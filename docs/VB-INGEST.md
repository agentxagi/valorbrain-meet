# ValorBrain Ingest — integração vb-ingest

Implements the `valorbrain-meet` PRD: each saved meeting session can be pushed
into the tenant's ValorBrain memory over REST (never MCP). The extension is a
distributed per-tenant client — **no URL, token, or tenant ID is hardcoded**;
everything is configured in Settings under the `vb.*` keys.

## What was added

| Area                                  | Change                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vbClient.ts` (new)               | `sendToValorBrain(session, settings)`, `buildValorBrainPayload`, `testValorBrainConnection`, `normalizeVbSettings` / `getVbSettings`, sync-status recording. Errors are explicit results: `config` / `auth` (401/403) / `rateLimit` (429, one retry with 2s backoff) / `network` / `timeout` (30s) / `server`.                           |
| `src/vbClient.test.ts` (new)          | Payload assembly, headers, docRef extraction (`path` or `docid`), 401/429 handling, retry/timeout, connection test. Wired into `npm test`.                                                                                                                                                                                               |
| `src/background.ts`                   | `VB_SEND_SESSION` and `VB_TEST_CONNECTION` message handlers (all ValorBrain fetches go through the service worker). Optional auto-send: when `vb.autoSend` is on, `persistSession()` fires a best-effort send after the session is saved — **a VB failure never blocks the local export** (the local transcript is the source of truth). |
| `src/options.html` / `src/options.ts` | "ValorBrain" section: Base URL, API token (password), Tenant ID, Auto-send toggle (default OFF), and a "Test connection" button (`GET {baseUrl}/health` with the auth headers, showing OK/failure with reason).                                                                                                                          |
| `src/dashboard.html` / `.ts` / `.css` | "Send to ValorBrain" button on each saved session (sending / Sent ✓ / error with Retry). Local last-sync badge in the panel (ok/fail + time, tooltip carries the doc ref or error).                                                                                                                                                      |
| `src/manifest.json`                   | `host_permissions` += `https://*.valor.digital/*`; CSP `connect-src` += `https://*.valor.digital`.                                                                                                                                                                                                                                       |
| `package.json`                        | `src/vbClient.test.ts` added to the `test` script.                                                                                                                                                                                                                                                                                       |

## Settings keys (`settings` object in `chrome.storage.local`)

- `vb.baseUrl` — string, default `""` (empty disables; no production default is committed)
- `vb.apiToken` — string, default `""`
- `vb.tenantId` — string, default `""` (UUID)
- `vb.autoSend` — boolean, default `false`

Summary generation is deliberately **not** touched here (`provider.*` belongs to
the parallel `feat/provider-agnostic` PRD). `vbClient` only transports whatever
summary exists under `## Resumo`; once the PT-BR prompt lands, its sections flow
through unchanged.

## ⚠️ Merge-conflict note for `feat/provider-agnostic`

Both branches part from the same commit and both add the ValorBrain domain to
`src/manifest.json` (`host_permissions` and CSP `connect-src`). **Keep only one
copy** of each when resolving:

- `host_permissions`: `"https://*.valor.digital/*"`
- CSP: `connect-src ... https://*.valor.digital ...`

## Manual integration test (against a real VB)

No real keys live in this repo. Run from a shell, substituting your own values:

```bash
BASE_URL="https://memory.valor.digital"   # your ValorBrain engine
TOKEN="<tenant api token>"
TENANT="<tenant uuid>"

# 1. Health check (same request the options-page "Test connection" button makes)
curl -sS -o /dev/null -w "health: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  "$BASE_URL/health"

# 2. Store a memory (exact payload shape the extension posts)
curl -sS -w "\nstore: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "observation",
    "title": "Reunião: smoke-test (2026-01-15 12:00)",
    "content": "## Resumo\nTeste de integração do valorbrain-meet.\n\n## Decisões\n_(nenhuma)_\n\n## Action Items\n_(nenhum)_\n\n## Transcript\n[00:10] Tester: Olá.",
    "collection": "meetings",
    "tags": ["reuniao", "meet", "valorbrain-meet"],
    "confidence": 0.85
  }' \
  "$BASE_URL/api/v1/memory/store"

# 3. Negative checks
curl -sS -o /dev/null -w "bad token (expect 401/403): %{http_code}\n" \
  -H "Authorization: Bearer wrong" -H "X-Tenant-ID: $TENANT" \
  "$BASE_URL/api/v1/memory/store" -X POST -H "Content-Type: application/json" -d '{}'
```

Expected: `health: 200`; `store: 200` (or `201`) with a JSON body containing
`path` or `docid` — the extension surfaces that reference in the success toast;
bad token returns `401`/`403`, which the extension maps to an explicit
"check vb.apiToken and vb.tenantId" error.

In-browser E2E: load the unpacked extension from `dist/`, fill the ValorBrain
section in Settings, click "Test connection" (expect ✓), save a meeting
session, then use "Send to ValorBrain" on it in the Sessions tab (expect toast
with doc ref and the footer badge turning ✓).

## Implementation notes

- **Sync badge storage**: the PRD sketched a `localStorage` badge. The badge is
  written by the service worker (so auto-send updates it too), which cannot
  reach page `localStorage`; the status therefore lives in
  `chrome.storage.local` under `vbLastSync` — same "local to this browser"
  semantics, and the side panel listens via `chrome.storage.onChanged`.
- **Auto-send hook point**: `persistSession()` (i.e. right after the end-of-
  meeting "Save session" commit, when the final summary is already part of the
  pending session). Fire-and-forget by design.
- **Why sends go through the service worker**: extension-page CSP
  (`connect-src`) would otherwise restrict which ValorBrain hosts tenants can
  configure; the worker + `host_permissions` keep arbitrary self-hosted
  `vb.baseUrl` values workable.
