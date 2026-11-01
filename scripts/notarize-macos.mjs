// Consumes an already Developer ID-signed app. Never rebuilds/re-signs it, exports keys or
// creates a release. Public artifacts appear in dist/ only after the complete distribution gate.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caskFor, requireAccepted, requireSigningConfig } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1] || args[i + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return resolve(args[i + 1]);
};

function run(command, commandArgs, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
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
  ]);

  const dist = join(output, "dist");
  mkdirSync(dist);
  copyFileSync(dmg, join(dist, name));
  const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  writeFileSync(join(dist, "SHA256SUMS.txt"), `${sha}  ${name}\n`);
  copyFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), join(dist, "THIRD_PARTY_NOTICES.txt"));
  writeFileSync(join(dist, "snipvero.rb"), caskFor(version, sha));
  console.log(`Verified distribution files: ${dist}. No release created.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
