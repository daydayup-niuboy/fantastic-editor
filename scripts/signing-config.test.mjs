import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TIMESTAMP_SERVER, resolveSigningConfiguration } from "./signing-config.mjs";

test("accepts a password-protected PFX source without exposing its values", () => {
  const result = resolveSigningConfiguration({
    WIN_CSC_LINK: "C:/secure/fantastic-editor.pfx",
    WIN_CSC_KEY_PASSWORD: "secret",
  });
  assert.deepEqual(result, {
    mode: "pfx",
    certificateSha1: null,
    timestampServer: `${DEFAULT_TIMESTAMP_SERVER}/`,
  });
  assert.equal("certificatePassword" in result, false);
  assert.equal("certificateLink" in result, false);
});
test("accepts and normalizes a Windows certificate-store thumbprint", () => {
  const result = resolveSigningConfiguration({
    FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1: "01234567 89ab cdef 0123 4567 89ab cdef 0123 4567",
  });
  assert.equal(result.mode, "windows-store");
  assert.equal(result.certificateSha1, "0123456789ABCDEF0123456789ABCDEF01234567");
});

test("rejects missing, ambiguous, incomplete, malformed, and insecure configurations", () => {
  const validThumbprint = "0123456789abcdef0123456789abcdef01234567";
  const invalidEnvironments = [
    {},
    { WIN_CSC_LINK: "certificate.pfx" },
    {
      WIN_CSC_LINK: "certificate.pfx",
      WIN_CSC_KEY_PASSWORD: "secret",
      FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1: validThumbprint,
    },
    { FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1: "not-a-thumbprint" },
    {
      WIN_CSC_LINK: "certificate.pfx",
      WIN_CSC_KEY_PASSWORD: "secret",
      FANTASTIC_EDITOR_TIMESTAMP_SERVER: "http://timestamp.invalid",
    },
  ];

  for (const environment of invalidEnvironments) {
    assert.throws(() => resolveSigningConfiguration(environment));
  }
});
