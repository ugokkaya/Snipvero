import assert from "node:assert/strict";
import test from "node:test";
import { caskFor, requireAccepted, requireSigningConfig } from "./release-policy.mjs";

test("only an explicit Accepted submission with an ID passes", () => {
  assert.equal(requireAccepted({ id: "submission", status: "Accepted" }), "submission");
  for (const status of ["Invalid", "Rejected", "In Progress", "", undefined]) {
    assert.throws(() => requireAccepted({ id: "submission", status }));
  }
  assert.throws(() => requireAccepted({ status: "Accepted" }));
});

test("signing requires a Developer ID identity for the expected team and local profile", () => {
  const identity = "Developer ID Application: Example (TEAMID1234)";
  assert.doesNotThrow(() => requireSigningConfig(identity, "TEAMID1234", "local-profile"));
  assert.throws(() => requireSigningConfig(identity, "OTHER12345", "local-profile"));
  assert.throws(() => requireSigningConfig(identity, "bad", "local-profile"));
  assert.throws(() => requireSigningConfig("-", "TEAMID1234", "local-profile"));
  assert.throws(() => requireSigningConfig(identity, "TEAMID1234", ""));
});

test("cask pins the final checksum and supported platform, without security bypasses", () => {
  const sha = "a".repeat(64);
  const cask = caskFor("0.1.0-beta.2", sha);
  assert.ok(cask.includes(`sha256 "${sha}"`));
  assert.ok(cask.includes('version "0.1.0-beta.2"'));
  assert.ok(cask.includes("/v#{version}/Snipvero_#{version}_aarch64.dmg"));
  assert.ok(cask.includes("arch: :arm64"));
  assert.ok(cask.includes("macos: :sonoma"));
  assert.ok(cask.includes('app "Snipvero.app"'));
  assert.doesNotMatch(cask, /no_check|quarantine|xattr|system_command/);
  assert.throws(() => caskFor('1.0.0"\nsystem "bad"', sha));
  assert.throws(() => caskFor("0.1.0", "not-a-checksum"));
});
