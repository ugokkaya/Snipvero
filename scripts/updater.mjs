// Updater release policy (ADR-028): channel and endpoint, package names, the static manifest, and
// minisign verification of a package against the public key in tauri.conf.json. No dependencies:
// Ed25519 and BLAKE2b-512 come from node:crypto. Signing itself stays with `tauri signer sign`.
import { createHash, createPublicKey, verify } from "node:crypto";

export const REPOSITORY_URL = "https://github.com/ugokkaya/Snipvero";
/** The only platform key: Apple silicon builds (ADR-022). */
export const PLATFORM = "darwin-aarch64";
const NOTES_LIMIT = 5000;
/** SemVer without build metadata: a rebuild must get a new version, not a `+build` suffix. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function requireVersion(version) {
  if (!VERSION.test(version ?? "")) throw new Error(`Invalid release version: ${version}`);
  return version;
}

/** Pre-release versions belong to the beta channel; a build never changes channel by itself. */
export const channelFor = (version) => (requireVersion(version).includes("-") ? "beta" : "stable");

export const endpointFor = (channel) =>
  `https://raw.githubusercontent.com/ugokkaya/Snipvero/main/updater/${channel}.json`;

export const packageName = (version) => `Snipvero_${requireVersion(version)}_aarch64.app.tar.gz`;

/** Immutable, versioned release asset; a published manifest never points anywhere else. */
export const packageUrl = (version) =>
  `${REPOSITORY_URL}/releases/download/v${version}/${packageName(version)}`;

/** The release build's updater settings: fixed channel endpoint, a real key, nothing relaxed. */
export function requireUpdaterConfig(config, version) {
  const updater = config?.plugins?.updater;
  if (!updater) throw new Error("tauri.conf.json has no plugins.updater");
  const allowed = ["pubkey", "endpoints", "requireSignedVersion"];
  const extra = Object.keys(updater).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`Unexpected updater settings: ${extra.join(", ")}`);
  const endpoint = endpointFor(channelFor(version));
  if (JSON.stringify(updater.endpoints) !== JSON.stringify([endpoint])) {
    throw new Error(`Updater endpoints must be exactly [${endpoint}]`);
  }
  if (updater.requireSignedVersion !== true) throw new Error("requireSignedVersion must be true");
  if (typeof updater.pubkey !== "string" || updater.pubkey.trim() === "") {
    throw new Error("The updater public key is missing; create the release key first (RELEASE.md)");
  }
  publicKeyOf(updater.pubkey);
  if (config.bundle?.createUpdaterArtifacts !== undefined) {
    throw new Error("createUpdaterArtifacts must stay unset: packages come from the stapled app");
  }
  return { endpoint, pubkey: updater.pubkey.trim() };
}

/**
 * The release updater key comes only as a file outside the repository; its content never sits in
 * the environment (where `tauri build` and every child process would see it).
 */
export function requireUpdaterKeyPath(env, repositoryRoot) {
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error(
      "Unset TAURI_SIGNING_PRIVATE_KEY; pass the key file in TAURI_SIGNING_PRIVATE_KEY_PATH",
    );
  }
  const path = env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? "";
  if (!path.startsWith("/")) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY_PATH must be the absolute path of the updater key");
  }
  const rootPrefix = repositoryRoot.endsWith("/") ? repositoryRoot : `${repositoryRoot}/`;
  if (path.startsWith(rootPrefix))
    throw new Error("The updater key must live outside the repository");
  return path;
}

// --- minisign ---------------------------------------------------------------------------------

const base64Text = (value, what) => {
  const text = Buffer.from(String(value).trim(), "base64").toString("utf8");
  if (!text.startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign file`);
  return text.split("\n").map((line) => line.trim());
};

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** Key ID and Ed25519 key of a Tauri updater public key (base64 of the minisign `.pub` file). */
export function publicKeyOf(pubkey) {
  const raw = Buffer.from(base64Text(pubkey, "Public key")[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("Public key is not a minisign Ed25519 key");
  }
  return {
    keyId: raw.subarray(2, 10).toString("hex"),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

/**
 * Verifies `data` against a Tauri `.sig` file (base64 of a minisign signature, prehashed `ED`)
 * and the signed version in its trusted comment, as the app does with `requireSignedVersion`.
 * Returns the trusted comment. Throws on any mismatch.
 */
export function verifySignature({ data, signature, pubkey, version }) {
  const { keyId, key } = publicKeyOf(pubkey);
  const lines = base64Text(signature, "Signature");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (raw.length !== 74 || raw.subarray(0, 2).toString() !== "ED") {
    throw new Error("Signature is not a prehashed minisign signature");
  }
  if (raw.subarray(2, 10).toString("hex") !== keyId) {
    throw new Error("Signature was made with another key");
  }
  const digest = createHash("blake2b512").update(data).digest();
  if (!verify(null, digest, key, raw.subarray(10))) throw new Error("Signature does not match");
  if (!trusted.startsWith("trusted comment: ") || global.length !== 64) {
    throw new Error("Signature has no trusted comment");
  }
  const comment = trusted.slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([raw.subarray(10), Buffer.from(comment)]), key, global)) {
    throw new Error("Trusted comment signature does not match");
  }
  const signed = comment.split("\t").find((field) => field.startsWith("version:"));
  if (signed !== `version:${version}`) {
    throw new Error(`Package is signed for ${signed ?? "no version"}, not version:${version}`);
  }
  return comment;
}

// --- manifest ---------------------------------------------------------------------------------

/** Plain-text notes: the release document's summary (before its first section) and a link. */
export function notesFromRelease(markdown, version) {
  const summary = markdown
    .replace(/^# .*\n/, "")
    .split(/^## /m)[0]
    .trim()
    .replace(/\s*\n\s*/g, " ");
  const notes = `${summary}\n\nFull release notes: ${REPOSITORY_URL}/releases/tag/v${version}`;
  if (summary === "" || notes.length > NOTES_LIMIT) {
    throw new Error("Release notes summary is missing or too long");
  }
  return notes;
}

export function manifestFor({ version, notes, signature, pubDate }) {
  const manifest = {
    version: requireVersion(version),
    notes,
    pub_date: pubDate,
    platforms: { [PLATFORM]: { signature: String(signature).trim(), url: packageUrl(version) } },
  };
  validateManifest(manifest, version);
  return manifest;
}

/** The manifest the app will read: exactly one Apple silicon entry at its versioned asset. */
export function validateManifest(manifest, version) {
  const keys = Object.keys(manifest ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["notes", "platforms", "pub_date", "version"])) {
    throw new Error(`Unexpected manifest fields: ${keys.join(", ")}`);
  }
  if (manifest.version !== requireVersion(version)) throw new Error("Manifest version mismatch");
  if (typeof manifest.notes !== "string" || manifest.notes.length > NOTES_LIMIT) {
    throw new Error("Manifest notes must be plain text of at most 5000 characters");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    throw new Error("pub_date must be an RFC 3339 UTC time");
  }
  const platforms = Object.keys(manifest.platforms ?? {});
  if (JSON.stringify(platforms) !== JSON.stringify([PLATFORM])) {
    throw new Error(`Manifest must list only ${PLATFORM}, not ${platforms.join(", ")}`);
  }
  const entry = manifest.platforms[PLATFORM];
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["signature", "url"])) {
    throw new Error("Platform entry must have exactly url and signature");
  }
  if (entry.url !== packageUrl(version))
    throw new Error(`Package URL must be ${packageUrl(version)}`);
  base64Text(entry.signature, "Manifest signature");
  return manifest;
}
