/**
 * @fileoverview "Conectar com ValorBrain" — OAuth 2.1 authorization-code flow
 * with PKCE against the ValorBrain engine's built-in authorization server.
 *
 * The engine already runs a full OAuth 2.1 server (see engine `src/oauth.ts`):
 * discovery, dynamic client registration, authorize → consent → token with
 * S256 PKCE, issuing `vbm_*` tokens bound to the approving tenant. This module
 * is the extension-side client:
 *
 *   1. registerClient()  — POST /oauth/register (dynamic client registration)
 *   2. connectValorBrain() — chrome.identity.launchWebAuthFlow over
 *      /oauth/authorize (S256 PKCE + state); the user logs in and approves at
 *      the ValorBrain consent page
 *   3. exchangeCode() — POST /oauth/token → { access_token: "vbm_…" }
 *
 * The resulting `vbm_` token resolves to the tenant server-side, so the
 * extension stores it as the VB ingest credential without needing a Tenant ID.
 */

import { VB_STORE_PATH } from "./vbClient";

/** Production ValorBrain engine API (default Base URL for new connections). */
export const VB_API_BASE_URL = "https://valorbrain-api.valor.digital";

export interface OAuthClient {
  clientId: string;
  redirectUri: string;
}

export interface ConnectResult {
  accessToken: string;
  scope: string;
  clientId: string;
}

/** `base64url(bytes)` without padding, per RFC 7636 appendix A. */
export function base64url(bytes: ArrayBuffer): string {
  const raw = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random RFC 7636 code_verifier + matching S256 code_challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

/** Body for the engine's dynamic client registration endpoint. */
export function buildRegistrationBody(redirectUri: string): Record<string, unknown> {
  return {
    client_name: "ValorBrain Meet",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Registers an OAuth client for this extension install and returns its id. */
export async function registerClient(baseUrl: string, redirectUri: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRegistrationBody(redirectUri)),
  });
  if (!res.ok) {
    throw new Error(`Falha no registro do cliente OAuth (${res.status})`);
  }
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) {
    throw new Error("Registro OAuth sem client_id");
  }
  return body.client_id;
}

/** Builds the /oauth/authorize URL (S256 PKCE + state). */
export function buildAuthorizeUrl(o: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const base = o.baseUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  return `${base}/oauth/authorize?${q.toString()}`;
}

/**
 * Validates the launchWebAuthFlow redirect: checks state and surfaces OAuth
 * errors. Returns the authorization code.
 */
export function parseCallbackUrl(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  if (url.searchParams.get("error")) {
    throw new Error(
      url.searchParams.get("error_description") ??
        url.searchParams.get("error") ??
        "autorização negada",
    );
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new Error("state OAuth inválido (possível CSRF)");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("redirect sem authorization code");
  }
  return { code };
}

/** Exchanges an authorization code for the `vbm_` access token. */
export async function exchangeCode(
  baseUrl: string,
  o: { code: string; clientId: string; redirectUri: string; verifier: string },
): Promise<{ accessToken: string; scope: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({
    grant_type: "authorization_code",
    code: o.code,
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    code_verifier: o.verifier,
  });
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: q.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Falha ao trocar o código OAuth (${res.status}) ${detail.slice(0, 120)}`);
  }
  const body = (await res.json()) as { access_token?: string; scope?: string };
  if (!body.access_token) {
    throw new Error("Resposta /oauth/token sem access_token");
  }
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

/** Cached storage key for the dynamically registered OAuth client. */
export const VB_OAUTH_CLIENT_KEY = "vb.oauthClient";

/** Runs the full connect flow: register → authorize → exchange. */
export async function connectValorBrain(baseUrl = VB_API_BASE_URL): Promise<ConnectResult> {
  const redirectUri = chrome.identity.getRedirectURL();
  const stored = await chrome.storage.local.get(VB_OAUTH_CLIENT_KEY);
  const cached = stored[VB_OAUTH_CLIENT_KEY] as OAuthClient | undefined;
  const clientId =
    cached && cached.redirectUri === redirectUri
      ? cached.clientId
      : await registerClient(baseUrl, redirectUri);
  await chrome.storage.local.set({
    [VB_OAUTH_CLIENT_KEY]: { clientId, redirectUri } satisfies OAuthClient,
  });

  const state = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const { verifier, challenge } = await createPkcePair();
  const authorizeUrl = buildAuthorizeUrl({ baseUrl, clientId, redirectUri, state, challenge });

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl,
    interactive: true,
  });
  if (!callbackUrl) {
    throw new Error("Fluxo de autorização cancelado");
  }
  const { code } = parseCallbackUrl(callbackUrl, state);
  const { accessToken, scope } = await exchangeCode(baseUrl, {
    code,
    clientId,
    redirectUri,
    verifier,
  });
  return { accessToken, scope, clientId };
}

/** Convenience for tests/docs: the store endpoint of a given base URL. */
export function vbStoreUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${VB_STORE_PATH}`;
}
