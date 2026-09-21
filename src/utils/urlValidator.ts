/**
 * @fileoverview URL Validator
 *
 * Validates API endpoint URLs to ensure secure connections.
 * Prevents sending meeting data to non-HTTPS endpoints or to
 * unexpected third-party hosts.
 *
 * Loopback and private LAN targets (localhost, 127.0.0.0/8, ::1, RFC 1918
 * ranges, IPv4 link-local) are exempt from the HTTPS requirement so a
 * self-hosted Whisper server on the local network works out of the box.
 */

/**
 * Domains that are unconditionally trusted as Late-Meet API targets.
 * Used when `requireAllowlist` is enabled in {@link validateApiUrl}.
 */
const ALLOWED_DOMAINS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
];

/** Matches a dotted IPv4 literal; octet ranges are validated separately. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Returns whether the hostname targets the local machine: `localhost`
 * (including `*.localhost`) or the IPv4/IPv6 loopback ranges.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;

  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/**
 * Returns whether the hostname is a private LAN IPv4 address:
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, or 169.254.0.0/16 (link-local).
 */
function isPrivateIpv4(hostname: string): boolean {
  const match = IPV4_PATTERN.exec(hostname);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;

  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Returns whether the URL may use plain HTTP: only loopback and private
 * LAN targets are allowed to opt out of TLS.
 */
function isPlainHttpAllowed(hostname: string): boolean {
  return isLoopbackHost(hostname) || isPrivateIpv4(hostname);
}

/**
 * Validates that a URL string is well-formed, uses HTTPS (except for
 * loopback/private LAN hosts), and optionally belongs to the trusted API
 * domain allowlist.
 *
 * Three-stage validation:
 * 1. **Format check** – the string must parse as a valid URL.
 * 2. **Protocol check** – the scheme must be `https:`, unless the hostname is
 *    loopback or a private LAN address (see {@link isPlainHttpAllowed}).
 * 3. **Allowlist check** *(optional)* – the hostname must exactly match or be
 *    a subdomain of one of the entries in {@link ALLOWED_DOMAINS}.
 *
 * @param url - The URL string to validate.
 * @param options.requireAllowlist - When `true`, also verifies the hostname is
 *   in the trusted domain list. Defaults to `false`.
 * @returns An object with `valid: true` on success, or `valid: false` and a
 *   human-readable `error` string describing the first failure encountered.
 *
 * @example
 * const result = validateApiUrl("http://api.openai.com/v1/chat/completions");
 * // { valid: false, error: "API URL must use HTTPS. Got: http:" }
 *
 * @example
 * const result = validateApiUrl("http://127.0.0.1:8394/v1/audio/transcriptions");
 * // { valid: true } — local Whisper servers may use plain HTTP
 *
 * @example
 * const result = validateApiUrl("https://my-proxy.example.com/v1", { requireAllowlist: true });
 * // { valid: false, error: 'Domain "my-proxy.example.com" is not in the allowed API domains list' }
 */
export function validateApiUrl(
  url: string,
  options: { requireAllowlist?: boolean } = {},
): { valid: boolean; error?: string } {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:" && !isPlainHttpAllowed(parsed.hostname)) {
    return {
      valid: false,
      error: `API URL must use HTTPS. Got: ${parsed.protocol}`,
    };
  }

  if (options.requireAllowlist) {
    const isAllowed = ALLOWED_DOMAINS.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
    if (!isAllowed) {
      return {
        valid: false,
        error: `Domain "${parsed.hostname}" is not in the allowed API domains list`,
      };
    }
  }

  return { valid: true };
}

/**
 * Asserts that a URL is valid before making a fetch request, throwing a
 * descriptive error if validation fails.
 *
 * This is a convenience wrapper around {@link validateApiUrl} for call sites
 * that prefer the throw-on-failure pattern over checking a return value.
 * The error message is prefixed with `[Late-Meet Security]` to make security
 * violations easy to locate in logs.
 *
 * @param url - The URL string to validate (HTTPS-only outside loopback/LAN,
 *   no allowlist check).
 * @throws `Error` with a `[Late-Meet Security]` prefix if the URL is invalid
 *   or not HTTPS.
 *
 * @example
 * assertValidApiUrl(userSuppliedEndpoint); // throws if invalid
 * const res = await fetch(userSuppliedEndpoint, options);
 */
export function assertValidApiUrl(url: string): void {
  const result = validateApiUrl(url);
  if (!result.valid) {
    throw new Error(`[Late-Meet Security] ${result.error}`);
  }
}
