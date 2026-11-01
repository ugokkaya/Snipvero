import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  channelFor,
  endpointFor,
  manifestFor,
  notesFromRelease,
  packageUrl,
  requireUpdaterConfig,
  requireUpdaterKeyPath,
  validateManifest,
  verifySignature,
} from "./updater.mjs";

// The same test-only fixtures as the Rust updater tests (their private keys no longer exist).
const fixture = (name) =>
  readFileSync(new URL(`../src-tauri/test-fixtures/updater/${name}`, import.meta.url));
const pubkey = fixture("test.pub").toString().trim();
const data = fixture("package.bin");
const signature = fixture("package.bin.sig").toString();
const VERSION = "0.1.0-beta.4";

test("a package verifies against its key and signed version", () => {
  const comment = verifySignature({ data, signature, pubkey, version: VERSION });
  assert.match(comment, /\tversion:0\.1\.0-beta\.4$/);
});

test("corrupted data, another key or another signed version never verify", () => {
  const corrupted = Buffer.from(data);
  corrupted[0] ^= 1;
  assert.throws(() => verifySignature({ data: corrupted, signature, pubkey, version: VERSION }));
  assert.throws(
    () =>
      verifySignature({
        data,
        signature: fixture("package.other-key.sig").toString(),
        pubkey,
        version: VERSION,
      }),
    /another key/,
  );
  assert.throws(
    () =>
      verifySignature({
        data,
        signature: fixture("package.wrong-version.sig").toString(),
        pubkey,
        version: VERSION,
      }),
    /signed for version:0\.1\.0-beta\.1/,
  );
  assert.throws(() => verifySignature({ data, signature, pubkey, version: "0.1.0-beta.5" }));
  assert.throws(() => verifySignature({ data, signature: "garbage", pubkey, version: VERSION }));
});

test("pre-releases use the beta channel; no build metadata", () => {
  assert.equal(channelFor("0.1.0-beta.3"), "beta");
  assert.equal(channelFor("0.1.0-rc.1"), "beta");
  assert.equal(channelFor("1.0.0"), "stable");
  assert.equal(
    endpointFor("beta"),
    "https://raw.githubusercontent.com/ugokkaya/Snipvero/main/updater/beta.json",
  );
  for (const bad of ["0.1.0-beta.3+1", "v0.1.0", "0.1", "01.0.0", "0.1.0-", ""]) {
    assert.throws(() => channelFor(bad), undefined, bad);
  }
});

test("the manifest has one Apple silicon entry at the versioned release asset", () => {
  const manifest = manifestFor({
    version: VERSION,
    notes: "Notes.",
    signature,
    pubDate: "2026-11-01T12:00:00Z",
  });
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64"]);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://github.com/ugokkaya/Snipvero/releases/download/v0.1.0-beta.4/Snipvero_0.1.0-beta.4_aarch64.app.tar.gz",
  );
  assert.equal(manifest.platforms["darwin-aarch64"].url, packageUrl(VERSION));

  const broken = [
    { ...manifest, version: "0.1.0-beta.5" },
    { ...manifest, pub_date: "yesterday" },
    { ...manifest, extra: true },
    { ...manifest, platforms: { "darwin-x86_64": manifest.platforms["darwin-aarch64"] } },
    {
      ...manifest,
      platforms: { ...manifest.platforms, "windows-x86_64": manifest.platforms["darwin-aarch64"] },
    },
    {
      ...manifest,
      platforms: {
        "darwin-aarch64": { ...manifest.platforms["darwin-aarch64"], url: "http://example.com/x" },
      },
    },
    { ...manifest, notes: "x".repeat(5001) },
  ];
  for (const candidate of broken) assert.throws(() => validateManifest(candidate, VERSION));
});

test("notes are the release summary as plain text with a link", () => {
  const notes = notesFromRelease(
    "# Snipvero 0.1.0 Beta 4\n\nAdds a thing\nand fixes another.\n\n## Details\n\n- item\n",
    VERSION,
  );
  assert.equal(
    notes,
    "Adds a thing and fixes another.\n\nFull release notes: https://github.com/ugokkaya/Snipvero/releases/tag/v0.1.0-beta.4",
  );
  assert.throws(() => notesFromRelease("# Title\n\n## Only sections\n", VERSION));
});

test("the updater key is a file outside the repository, never key material in the environment", () => {
  const root = "/Users/me/Snipvero";
  const path = "/Users/me/.tauri/snipvero-updater.key";
  assert.equal(requireUpdaterKeyPath({ TAURI_SIGNING_PRIVATE_KEY_PATH: path }, root), path);
  assert.throws(() => requireUpdaterKeyPath({}, root));
  assert.throws(() => requireUpdaterKeyPath({ TAURI_SIGNING_PRIVATE_KEY_PATH: "key.txt" }, root));
  assert.throws(() =>
    requireUpdaterKeyPath({ TAURI_SIGNING_PRIVATE_KEY_PATH: `${root}/secrets/key` }, root),
  );
  assert.throws(() =>
    requireUpdaterKeyPath(
      { TAURI_SIGNING_PRIVATE_KEY_PATH: path, TAURI_SIGNING_PRIVATE_KEY: "dW50cnVzdGVk" },
      root,
    ),
  );
});

test("release builds need the fixed endpoint, signed versions and a real key", () => {
  const config = {
    bundle: {},
    plugins: {
      updater: { pubkey, endpoints: [endpointFor("beta")], requireSignedVersion: true },
    },
  };
  assert.equal(requireUpdaterConfig(config, "0.1.0-beta.3").pubkey, pubkey);
  const variants = [
    { pubkey: "" },
    { endpoints: [endpointFor("stable")] },
    { endpoints: ["http://127.0.0.1:8080/beta.json"] },
    { requireSignedVersion: false },
    { dangerousInsecureTransportProtocol: true },
    { allowDowngrades: true },
  ];
  for (const change of variants) {
    const updater = { ...config.plugins.updater, ...change };
    assert.throws(
      () => requireUpdaterConfig({ ...config, plugins: { updater } }, "0.1.0-beta.3"),
      undefined,
      JSON.stringify(change),
    );
  }
  assert.throws(() =>
    requireUpdaterConfig({ ...config, bundle: { createUpdaterArtifacts: true } }, "0.1.0-beta.3"),
  );
  // The repository's config: the beta endpoint for this version; the key is added before release.
  const repo = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(repo.plugins.updater.endpoints, [endpointFor(channelFor(repo.version))]);
});
