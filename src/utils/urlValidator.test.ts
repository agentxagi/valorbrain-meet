import test from "node:test";
import assert from "node:assert/strict";

import { assertValidApiUrl, validateApiUrl } from "./urlValidator.ts";

test("accepts well-formed HTTPS URLs", () => {
  assert.deepEqual(validateApiUrl("https://api.openai.com/v1/models"), { valid: true });
  assert.deepEqual(validateApiUrl("https://api.z.ai/api/paas/v4/chat/completions"), {
    valid: true,
  });
  assert.deepEqual(validateApiUrl("https://10.0.0.5:8394/v1"), { valid: true });
});

test("accepts plain HTTP for localhost and loopback targets", () => {
  assert.deepEqual(validateApiUrl("http://localhost:8394/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://127.0.0.1:8394/v1/audio/transcriptions"), {
    valid: true,
  });
  assert.deepEqual(validateApiUrl("http://127.127.0.5/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://[::1]:8394/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://dashboard.localhost/v1"), { valid: true });
});

test("accepts plain HTTP for private LAN IPv4 addresses", () => {
  assert.deepEqual(validateApiUrl("http://192.168.1.20:8394/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://10.1.2.3/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://172.16.0.9/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://172.31.255.1/v1"), { valid: true });
  assert.deepEqual(validateApiUrl("http://169.254.10.10/v1"), { valid: true });
});

test("rejects plain HTTP for public or random hosts", () => {
  const publicHost = validateApiUrl("http://api.openai.com/v1/models");
  assert.equal(publicHost.valid, false);
  assert.match(publicHost.error ?? "", /must use HTTPS/);

  assert.equal(validateApiUrl("http://random-host.example.com/v1").valid, false);
  assert.equal(validateApiUrl("http://8.8.8.8/v1").valid, false);
  assert.equal(validateApiUrl("http://172.32.0.1/v1").valid, false);
  assert.equal(validateApiUrl("http://172.15.0.1/v1").valid, false);
  assert.equal(validateApiUrl("http://192.169.0.1/v1").valid, false);
  assert.equal(validateApiUrl("http://999.1.1.1/v1").valid, false);
});

test("rejects malformed URLs", () => {
  assert.equal(validateApiUrl("not-a-url").valid, false);
  assert.equal(validateApiUrl("").valid, false);
});

test("requireAllowlist still restricts to trusted API domains", () => {
  assert.equal(
    validateApiUrl("https://api.openai.com/v1/models", { requireAllowlist: true }).valid,
    true,
  );
  assert.equal(
    validateApiUrl("https://api.anthropic.com/v1/models", { requireAllowlist: true }).valid,
    true,
  );
  assert.equal(
    validateApiUrl("https://api.openai.com.evil.test/v1/models", { requireAllowlist: true }).valid,
    false,
  );

  const lanHost = validateApiUrl("http://192.168.1.20:8394/v1", { requireAllowlist: true });
  assert.equal(lanHost.valid, false);
});

test("assertValidApiUrl throws with the security prefix on failure", () => {
  assert.throws(
    () => assertValidApiUrl("http://random-host.example.com"),
    /\[Late-Meet Security\]/,
  );
  assert.doesNotThrow(() => assertValidApiUrl("http://127.0.0.1:8394/v1"));
});
