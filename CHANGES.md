# Changes — Provider-Agnostic AI Pipeline (`feat/provider-agnostic`)

## Summary

The AI pipeline is no longer tied to OpenAI. Transcription and summarization are
now configured independently in **Options → AI Providers**, each speaking the
OpenAI-compatible wire format:

- Chat: `POST {base}/chat/completions`
- Audio: `POST {base}/audio/transcriptions` (multipart)
- Connectivity probe: `GET {base}/models`

Target setup (zero cost per meeting minute, audio never leaves the machine):

| Role          | Default provider               | Base URL                       | API key                  | Model           |
| ------------- | ------------------------------ | ------------------------------ | ------------------------ | --------------- |
| Transcription | Local Whisper (faster-whisper) | `http://127.0.0.1:8394/v1`     | _(empty — local server)_ | `whisper-local` |
| Summary       | Z.ai GLM                       | `https://api.z.ai/api/paas/v4` | _(user key)_             | `glm-5.3-flash` |

OpenAI remains a first-class option (`https://api.openai.com/v1`,
`gpt-4o-mini`), and any OpenAI-compatible endpoint works through the `Custom`
profile.

## What changed

- **New settings module** (`src/utils/providerSettings.ts`): two independent
  provider blocks stored in `chrome.storage.local` under `provider.transcription`
  and `provider.summary` (the `provider.*` prefix avoids colliding with other
  settings namespaces). Built-in profiles pre-fill the editable fields.
- **No hardcoded provider URLs.** All AI fetches in `src/background.ts` and
  `src/utils/api.ts` read Base URL / key / model from the provider settings.
- **One-time migration.** Users with a saved (legacy) OpenAI vault key are
  migrated to the OpenAI profile automatically; the existing encrypted vault
  key keeps working as fallback when the OpenAI profile has no key of its own.
  Existing `settings.aiModel` values carry over as the summary model.
- **Options page** gained the "AI Providers" section (profile dropdown +
  editable Base URL / API key / Model per role, plus a "Test connection"
  button). The legacy ElevenLabs field and the global "AI Model" dropdown were
  removed (superseded by per-provider models).
- **URL validator** (`src/utils/urlValidator.ts`) now accepts plain HTTP for
  loopback (`localhost`, `127.0.0.0/8`, `::1`) and private LAN IPv4 addresses
  (RFC 1918 + link-local) so self-hosted Whisper servers on the local network
  work; all other hosts still require HTTPS.
- **Manifest** (`src/manifest.json`):
  - `host_permissions` added: `http://localhost/*`, `http://127.0.0.1/*`,
    `https://api.z.ai/*`, `https://*.valor.digital/*` (ElevenLabs removed).
  - CSP `connect-src` mirrors the same hosts; loopback sources use port
    wildcards (`http://localhost:* http://127.0.0.1:*`) because a CSP source
    without a port only matches the scheme's default port. A provider outside
    this list needs a manifest entry — MV3 platform limitation, not a bug
    (documented in the README).
  - Renamed to **"ValorBrain Meet"**; description mentions ValorBrain.
- **ElevenLabs removed from the pipeline.** The `@elevenlabs/elevenlabs-js`
  dependency was never imported at runtime — removed from `package.json`
  (smaller install). The ElevenLabs STT fetch branch, key fields, and vault
  entry were removed with it.
- **Usage tracking**: unknown chat models (e.g. GLM) no longer inherit
  gpt-4o-mini pricing; local/self-hosted transcription seconds are counted
  without a cost estimate.
- **Popup**: starting a capture no longer requires an API key (transcription
  works keyless against a local server). If the summary provider has no key,
  a non-blocking "transcripts only" notice is shown instead of blocking.

## Load unpacked (manual step)

1. Build the extension:

   ```
   npm ci && npm run build
   ```

2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Open the extension **Options → AI Providers** and confirm/save your
   transcription and summary providers (defaults work with a local Whisper
   server on `127.0.0.1:8394`; add your Z.ai API key for summaries).

## Verification performed

- `npm ci && npm run build` — passes.
- `npm test` — 150 tests pass, including new tests for provider profile
  resolution, settings migration, and the URL validator.
- `grep` over `src/utils/api.ts` and `src/background.ts` shows no hardcoded
  provider URLs (only `meet.google.com` tab-matching queries remain).
- `CHANGES.md` (this file) documents the change and the manual load step.
- Manual smoke test in a real Chromium with the unpacked build: provider
  defaults render, profile switching fills fields, saving persists
  `provider.*` blocks, "Test connection" reaches a live local Whisper server,
  and the legacy-OpenAI migration produces the OpenAI profile for both roles.
