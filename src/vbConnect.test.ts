import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorizeUrl,
  buildRegistrationBody,
  connectValorBrain,
  grantsWrite,
  VB_OAUTH_CLIENT_KEY,
  VB_OAUTH_SCOPE,
} from "./vbConnect.ts";

const REDIRECT = "https://abcdefghijklmnop.chromiumapp.org/";
const BASE = "https://vb.example";
const originalFetch = globalThis.fetch;

interface Harness {
  storage: Record<string, unknown>;
  registrations: Array<Record<string, unknown>>;
  authorizeUrls: URL[];
}

/**
 * chrome.identity and chrome.storage, and the engine's /oauth endpoints, as
 * far as the connect flow uses them. The token endpoint grants `grantedScope`.
 */
function install(options: { cached?: unknown; grantedScope: string }): Harness {
  const harness: Harness = { storage: {}, registrations: [], authorizeUrls: [] };
  if (options.cached) harness.storage[VB_OAUTH_CLIENT_KEY] = options.cached;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async ({ url }: { url: string }) => {
        const authorize = new URL(url);
        harness.authorizeUrls.push(authorize);
        return `${REDIRECT}?code=the-code&state=${authorize.searchParams.get("state")}`;
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: harness.storage[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(harness.storage, items);
        },
      },
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/register") {
      harness.registrations.push(JSON.parse(String(init?.body)));
      return Response.json({ client_id: "new-client" }, { status: 201 });
    }
    if (url.pathname === "/oauth/token") {
      return Response.json({
        access_token: "vbm_issued",
        token_type: "Bearer",
        scope: options.grantedScope,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return harness;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the registration and the authorization ask to write, not only to read", () => {
  assert.equal(VB_OAUTH_SCOPE, "read write");
  assert.equal(buildRegistrationBody(REDIRECT).scope, VB_OAUTH_SCOPE);
  const url = new URL(
    buildAuthorizeUrl({
      baseUrl: BASE,
      clientId: "client",
      redirectUri: REDIRECT,
      state: "state",
      challenge: "challenge",
    }),
  );
  assert.equal(url.searchParams.get("scope"), VB_OAUTH_SCOPE);
});

test("grantsWrite reads the scope the token endpoint granted", () => {
  assert.equal(grantsWrite("read write"), true);
  assert.equal(grantsWrite("write read"), true);
  assert.equal(grantsWrite("read"), false);
  assert.equal(grantsWrite("readwrite"), false);
});

test("a client registered before 2.5.1 (read only) is replaced by one that asks to write", async () => {
  const harness = install({
    cached: { clientId: "old-client", redirectUri: REDIRECT },
    grantedScope: "read write",
  });

  const result = await connectValorBrain(BASE);

  assert.equal(harness.registrations.length, 1);
  assert.equal(harness.registrations[0].scope, VB_OAUTH_SCOPE);
  assert.equal(harness.authorizeUrls[0].searchParams.get("client_id"), "new-client");
  assert.equal(harness.authorizeUrls[0].searchParams.get("scope"), VB_OAUTH_SCOPE);
  assert.equal(result.accessToken, "vbm_issued");
  assert.deepEqual(harness.storage[VB_OAUTH_CLIENT_KEY], {
    clientId: "new-client",
    redirectUri: REDIRECT,
    scope: VB_OAUTH_SCOPE,
  });
});

test("a client already registered to write is reused", async () => {
  const harness = install({
    cached: { clientId: "rw-client", redirectUri: REDIRECT, scope: VB_OAUTH_SCOPE },
    grantedScope: "read write",
  });

  await connectValorBrain(BASE);

  assert.equal(harness.registrations.length, 0);
  assert.equal(harness.authorizeUrls[0].searchParams.get("client_id"), "rw-client");
});

test("a token that only reads is refused instead of saved as connected", async () => {
  install({ grantedScope: "read" });

  await assert.rejects(connectValorBrain(BASE), /só leitura/);
});
