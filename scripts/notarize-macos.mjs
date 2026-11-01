// Consumes an already Developer ID-signed app. Never rebuilds/re-signs it, exports keys or
// creates a release. Public artifacts appear in dist/ only after the complete distribution gate.
// The updater package (ADR-028) is made from the stapled app and signed with the separate updater
// key, whose password comes from the login Keychain and reaches only the signing process.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caskFor, requireAccepted, requireSigningConfig } from "./release-policy.mjs";
import {
  channelFor,
  manifestFor,
  notesFromRelease,
  packageName,
  requireUpdaterConfig,
  requireUpdaterKeyPath,
  verifySignature,
} from "./updater.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1] || args[i + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return resolve(args[i + 1]);
};

function run(command, commandArgs, capture = false, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? result.error ?? ""}`);
  }
  return result.stdout ?? "";
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Requires an Apple silicon signing Mac");
  }
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  const team = process.env.APPLE_TEAM_ID;
  const profile = process.env.NOTARY_KEYCHAIN_PROFILE;
  requireSigningConfig(identity, team, profile);
  const app = option("--app");
  const output = option("--output-dir");
  // No recursive mkdir: a reused candidate directory (including a stale dist/) must fail closed.
  mkdirSync(output);
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  caskFor(version, "0".repeat(64));
  if (config.version !== version) throw new Error("Manifest version mismatch");
  // Updater prerequisites before any submission, so a missing key cannot waste a notarization.
  const { pubkey } = requireUpdaterConfig(config, version);
  const keyPath = requireUpdaterKeyPath(process.env, root);
  if (!existsSync(keyPath) || (statSync(keyPath).mode & 0o077) !== 0) {
    throw new Error("The updater key file must exist and be readable only by its owner (0600)");
  }
  const releaseNotes = join(root, `docs/releases/v${version}.md`);
  const notes = notesFromRelease(readFileSync(releaseNotes, "utf8"), version);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  // codesign writes signature details to stderr.
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (
    signature.status !== 0 ||
    !signature.stderr.includes(`Authority=${identity}\n`) ||
    !signature.stderr.includes(`TeamIdentifier=${team}\n`) ||
    !/^Timestamp=.+$/m.test(signature.stderr) ||
    !/CodeDirectory .*\bruntime\b/.test(signature.stderr)
  ) {
    throw new Error("Input app is not timestamped/hardened for the expected identity");
  }

  const bundle = join(output, "bundle");
  mkdirSync(join(bundle, "macos"), { recursive: true });
  mkdirSync(join(bundle, "dmg"));
  const candidate = join(bundle, "macos/Snipvero.app");
  run("ditto", [app, candidate]);

  const notarize = (path, label) => {
    // Keep the ID immediately, even if the wait later times out. Never auto-resubmit.
    const submitted = JSON.parse(
      run(
        "xcrun",
        ["notarytool", "submit", path, "--keychain-profile", profile, "--output-format", "json"],
        true,
      ),
    );
    writeFileSync(join(output, `${label}-submission.json`), JSON.stringify(submitted, null, 2));
    if (!submitted.id) throw new Error("Notary service returned no submission ID");
    console.log(`${label} submission: ${submitted.id}`);
    const waited = JSON.parse(
      run(
        "xcrun",
        [
          "notarytool",
          "wait",
          submitted.id,
          "--keychain-profile",
          profile,
          "--timeout",
          "30m",
          "--output-format",
          "json",
        ],
        true,
      ),
    );
    writeFileSync(join(output, `${label}-result.json`), JSON.stringify(waited, null, 2));
    requireAccepted(waited);
    run("xcrun", ["stapler", "staple", path === zip ? candidate : path]);
    run("xcrun", ["stapler", "validate", path === zip ? candidate : path]);
  };
  const zip = join(output, "Snipvero.zip");
  run("ditto", ["-c", "-k", "--keepParent", candidate, zip]);
  notarize(zip, "app");

  // Updater package: the stapled app exactly as notarized, without Finder metadata or extended
  // attributes, signed for this version. Never made before stapling (the ticket is part of it).
  const updater = join(bundle, "updater");
  mkdirSync(updater);
  const updaterPackage = join(updater, packageName(version));
  run(
    "tar",
    [
      "--no-mac-metadata",
      "--no-xattrs",
      "-czf",
      updaterPackage,
      "-C",
      join(bundle, "macos"),
      "Snipvero.app",
    ],
    false,
    { ...process.env, COPYFILE_DISABLE: "1" },
  );
  const password =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??
    run(
      "security",
      [
        "find-generic-password",
        "-s",
        process.env.UPDATER_KEY_KEYCHAIN_SERVICE ?? "snipvero-updater-key",
        "-w",
      ],
      true,
    ).replace(/\n$/, "");
  run(
    "pnpm",
    [
      "tauri",
      "signer",
      "sign",
      "--private-key-path",
      keyPath,
      "--app-version",
      version,
      updaterPackage,
    ],
    false,
    { ...process.env, CI: "true", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
  );
  const updaterSignature = readFileSync(`${updaterPackage}.sig`, "utf8");
  verifySignature({
    data: readFileSync(updaterPackage),
    signature: updaterSignature,
    pubkey,
    version,
  });
  const channel = channelFor(version);
  const manifest = manifestFor({
    version,
    notes,
    signature: updaterSignature,
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  writeFileSync(join(updater, `${channel}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  const stage = join(output, "dmg-stage");
  mkdirSync(stage);
  run("ditto", [candidate, join(stage, "Snipvero.app")]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const name = `Snipvero_${version}_aarch64.dmg`;
  const dmg = join(bundle, "dmg", name);
  run("hdiutil", ["create", "-volname", "Snipvero", "-srcfolder", stage, "-format", "UDZO", dmg]);
  run("codesign", ["--timestamp", "--sign", identity, dmg]);
  notarize(dmg, "dmg");
  run(process.execPath, [
    join(root, "scripts/verify-macos-bundle.mjs"),
    "--distribution",
    "--team-id",
    team,
    "--bundle-dir",
    bundle,
    "--updater",
  ]);

  const dist = join(output, "dist");
  mkdirSync(dist);
  copyFileSync(dmg, join(dist, name));
  const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  copyFileSync(updaterPackage, join(dist, packageName(version)));
  copyFileSync(`${updaterPackage}.sig`, join(dist, `${packageName(version)}.sig`));
  const packageSha = createHash("sha256").update(readFileSync(updaterPackage)).digest("hex");
  writeFileSync(
    join(dist, "SHA256SUMS.txt"),
    `${sha}  ${name}\n${packageSha}  ${packageName(version)}\n`,
  );
  copyFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), join(dist, "THIRD_PARTY_NOTICES.txt"));
  writeFileSync(join(dist, "snipvero.rb"), caskFor(version, sha));
  // Not a release asset: committed as updater/<channel>.json only after the release is public
  // and its assets re-downloaded and verified (RELEASE.md §9).
  const manifestDir = join(output, "manifest");
  mkdirSync(manifestDir);
  copyFileSync(join(updater, `${channel}.json`), join(manifestDir, `${channel}.json`));
  console.log(`Verified distribution files: ${dist}. Updater manifest: ${manifestDir}.`);
  console.log("No release created and no manifest published.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
