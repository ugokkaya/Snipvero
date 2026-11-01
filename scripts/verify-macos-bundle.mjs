// Verifies a built Snipvero.app and its DMG without launching them: Info.plist values, the exact
// file list, architectures, minimum macOS, linked libraries, signature, bundled notices, and that
// the DMG holds the same app plus an Applications link. macOS only (plutil, codesign, hdiutil).
//
//   node scripts/verify-macos-bundle.mjs [--bundle-dir DIR] [--arch arm64|x86_64|universal] [--distribution] [--team-id TEAM]
//
// --bundle-dir    default src-tauri/target/release/bundle (CI's debug build: .../debug/bundle)
// --arch          architectures the executable must contain; default arm64
// --distribution  also require a Developer ID signature, a timestamp, notarization and stapling

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const bundleDir = resolve(option("--bundle-dir", join(root, "src-tauri/target/release/bundle")));
const archOption = option("--arch", "arm64");
const distribution = args.includes("--distribution");
const teamId = option("--team-id", "");
if (args.includes("--team-id") && !/^[A-Z0-9]{10}$/.test(teamId ?? "")) {
  console.error("--team-id requires a 10-character Apple Team ID");
  process.exit(2);
}

const archs = { arm64: ["arm64"], x86_64: ["x86_64"], universal: ["arm64", "x86_64"] }[archOption];
const dmgArch = { arm64: "aarch64", x86_64: "x64", universal: "universal" }[archOption];
if (!archs) {
  console.error(`unknown --arch ${archOption}`);
  process.exit(2);
}

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const coreVersion = packageVersion.split(/[-+]/)[0];
const appleVersion = /^\d+(\.\d+){0,2}$/;

let failures = 0;
const check = (ok, message, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};
const info = (message) => console.log(`info ${message}`);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, entry))
    .filter((path) => !lstatSync(path).isDirectory())
    .map((path) => relative(dir, path))
    .sort();
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function readPlist(path) {
  const result = run("plutil", ["-convert", "json", "-o", "-", path]);
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}

// Checks the app at `app`; `label` tells the standalone bundle and the copy in the DMG apart.
function verifyApp(app, label) {
  console.log(`\n${label}: ${relative(root, app)}`);
  if (!check(existsSync(app), "bundle exists")) return null;

  const plist = readPlist(join(app, "Contents/Info.plist"));
  if (!check(plist !== null, "Info.plist is readable")) return null;
  const expect = (key, value) =>
    check(plist[key] === value, `${key} = ${JSON.stringify(value)}`, JSON.stringify(plist[key]));
  expect("CFBundleIdentifier", tauriConfig.identifier);
  expect("CFBundleName", tauriConfig.productName);
  expect("CFBundlePackageType", "APPL");
  expect("CFBundleShortVersionString", coreVersion);
  check(
    appleVersion.test(plist.CFBundleShortVersionString ?? ""),
    "CFBundleShortVersionString has Apple's format",
  );
  expect("CFBundleVersion", tauriConfig.bundle.macOS.bundleVersion);
  check(appleVersion.test(plist.CFBundleVersion ?? ""), "CFBundleVersion has Apple's format");
  expect("LSMinimumSystemVersion", tauriConfig.bundle.macOS.minimumSystemVersion);
  expect("LSUIElement", true);
  expect("NSHumanReadableCopyright", tauriConfig.bundle.copyright);

  const executable = plist.CFBundleExecutable ?? "";
  const binary = join(app, "Contents/MacOS", executable);
  check(
    existsSync(binary) && (statSync(binary).mode & 0o111) !== 0,
    "executable exists",
    executable,
  );

  // Exactly these files: anything else (a stray resource, a framework, a dylib) needs a review.
  const expected = [
    "Contents/Info.plist",
    `Contents/MacOS/${executable}`,
    `Contents/Resources/${plist.CFBundleIconFile}`,
    "Contents/Resources/LICENSE.txt",
    "Contents/Resources/THIRD_PARTY_NOTICES.txt",
    "Contents/_CodeSignature/CodeResources",
  ];
  // stapler adds the Apple ticket here, separately from _CodeSignature/CodeResources.
  const ticket = join(app, "Contents/CodeResources");
  if (existsSync(ticket)) {
    check(
      lstatSync(ticket).isFile() && run("xcrun", ["stapler", "validate", app]).status === 0,
      "extra CodeResources is a valid stapled Apple ticket",
    );
    expected.push("Contents/CodeResources");
  }
  expected.sort();
  const actual = filesUnder(app);
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    "bundle contains exactly the expected files",
    actual.join(", "),
  );
  for (const [bundled, source] of [
    ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
    ["LICENSE.txt", "LICENSE"],
  ]) {
    const path = join(app, "Contents/Resources", bundled);
    check(
      existsSync(path) && sha256(path) === sha256(join(root, source)),
      `Resources/${bundled} matches ${source}`,
    );
  }

  if (existsSync(binary)) {
    const lipo = run("lipo", ["-archs", binary]).stdout.trim().split(/\s+/).sort();
    check(
      JSON.stringify(lipo) === JSON.stringify([...archs].sort()),
      `architectures ${archs.join(" + ")}`,
      lipo.join(" "),
    );

    const loads = run("otool", ["-arch", "all", "-l", binary]).stdout;
    const minos = [...loads.matchAll(/cmd LC_BUILD_VERSION[\s\S]*?minos (\S+)/g)].map((m) => m[1]);
    check(
      minos.length === archs.length &&
        minos.every((v) => v === tauriConfig.bundle.macOS.minimumSystemVersion),
      `minimum macOS ${tauriConfig.bundle.macOS.minimumSystemVersion} in every slice`,
      minos.join(", "),
    );

    const libraries = run("otool", ["-arch", "all", "-L", binary])
      .stdout.split("\n")
      .filter((line) => line.startsWith("\t"))
      .map((line) => line.trim().split(" (")[0]);
    const foreign = libraries.filter((lib) => !/^\/(System\/Library|usr\/lib)\//.test(lib));
    check(
      foreign.length === 0,
      "links only system libraries",
      foreign.join(", ") || `${new Set(libraries).size} libraries`,
    );
  }

  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  check(
    verify.status === 0,
    "codesign --verify --deep --strict",
    verify.stderr.trim().split("\n").pop(),
  );

  const details = run("codesign", ["-dv", "--verbose=4", app]).stderr;
  const field = (name) => details.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
  check(
    field("Identifier") === tauriConfig.identifier,
    "signature identifier",
    field("Identifier"),
  );
  check(
    /\bruntime\b/.test(details.match(/^CodeDirectory .*$/m)?.[0] ?? ""),
    "hardened runtime enabled",
  );
  const authority = field("Authority");
  const adhoc = /^Signature=adhoc$/m.test(details);
  info(`signature: ${adhoc ? "ad hoc" : authority}`);

  const entitlements = run("codesign", ["-d", "--entitlements", "-", "--xml", app]).stdout.trim();
  check(!/<key>/.test(entitlements), "no entitlements (ADR-020)", entitlements ? "present" : "");

  const assess = run("spctl", ["-a", "-t", "exec", "-vv", app]);
  const assessment = (assess.stdout + assess.stderr).trim().replace(/\n/g, "; ");
  if (distribution) {
    check(
      authority.startsWith("Developer ID Application:"),
      "signed with Developer ID Application",
      authority,
    );
    check(field("Timestamp") !== "", "secure timestamp", field("Timestamp"));
    check(
      field("TeamIdentifier") !== "" && field("TeamIdentifier") !== "not set",
      "team identifier",
      field("TeamIdentifier"),
    );
    if (teamId) check(field("TeamIdentifier") === teamId, "expected signing team", teamId);
    check(run("xcrun", ["stapler", "validate", app]).status === 0, "notarization ticket stapled");
    check(
      assess.status === 0 && /source=Notarized Developer ID/.test(assessment),
      "Gatekeeper accepts",
      assessment,
    );
  } else {
    info(
      `Gatekeeper: ${assessment} (a Developer ID signature and notarization are not required without --distribution)`,
    );
  }

  return existsSync(binary) ? { plist, binarySha: sha256(binary) } : null;
}

function verifyDmg(standalone) {
  const dmgDir = join(bundleDir, "dmg");
  const name = `${tauriConfig.productName}_${packageVersion}_${dmgArch}.dmg`;
  const dmg = join(dmgDir, name);
  console.log(`\nDMG: ${relative(root, dmg)}`);
  const others = existsSync(dmgDir)
    ? readdirSync(dmgDir).filter((f) => f.endsWith(".dmg") && f !== name)
    : [];
  if (others.length > 0) info(`other images in ${relative(root, dmgDir)}: ${others.join(", ")}`);
  if (!check(existsSync(dmg), "image exists, named after the package version and architecture"))
    return;

  const verify = run("hdiutil", ["verify", dmg]);
  check(
    verify.status === 0,
    "hdiutil verify",
    (verify.stdout + verify.stderr).trim().split("\n").pop(),
  );

  const mount = mkdtempSync(join(tmpdir(), "snipvero-dmg-"));
  const attach = run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mount,
    dmg,
  ]);
  if (
    !check(
      attach.status === 0,
      "image mounts read-only",
      attach.status === 0 ? "" : attach.stderr.trim(),
    )
  ) {
    rmSync(mount, { recursive: true, force: true });
    return;
  }
  try {
    // Hidden entries (.background, .DS_Store, .VolumeIcon.icns) belong to the Finder layout.
    const visible = readdirSync(mount)
      .filter((entry) => !entry.startsWith("."))
      .sort();
    check(
      JSON.stringify(visible) ===
        JSON.stringify(["Applications", `${tauriConfig.productName}.app`]),
      "contains the app and an Applications link only",
      visible.join(", "),
    );
    const link = join(mount, "Applications");
    check(
      existsSync(link) &&
        lstatSync(link).isSymbolicLink() &&
        readlinkSync(link) === "/Applications",
      "Applications is a link to /Applications",
    );
    const copy = verifyApp(join(mount, `${tauriConfig.productName}.app`), "App in DMG");
    if (copy && standalone) {
      check(
        copy.binarySha === standalone.binarySha,
        "DMG app executable is identical to the built app",
      );
      check(
        JSON.stringify(copy.plist) === JSON.stringify(standalone.plist),
        "DMG app Info.plist is identical",
      );
    }
  } finally {
    run("hdiutil", ["detach", mount, "-quiet"]);
    rmSync(mount, { recursive: true, force: true });
  }

  if (distribution) {
    const details = run("codesign", ["-dv", "--verbose=4", dmg]).stderr;
    check(run("codesign", ["--verify", "--strict", dmg]).status === 0, "DMG signature verifies");
    check(
      /^Authority=Developer ID Application:/m.test(details),
      "DMG signed with Developer ID Application",
    );
    check(/^Timestamp=.+$/m.test(details), "DMG secure timestamp");
    if (teamId) {
      check(details.includes(`TeamIdentifier=${teamId}\n`), "DMG expected signing team", teamId);
    }
    check(
      run("xcrun", ["stapler", "validate", dmg]).status === 0,
      "DMG notarization ticket stapled",
    );
    const assess = run("spctl", [
      "-a",
      "-t",
      "open",
      "--context",
      "context:primary-signature",
      "-vv",
      dmg,
    ]);
    check(
      assess.status === 0,
      "Gatekeeper accepts the DMG",
      (assess.stdout + assess.stderr).trim().replace(/\n/g, "; "),
    );
  }
  info(`SHA-256 ${sha256(dmg)}  ${name}`);
}

if (process.platform !== "darwin") {
  console.error("verify-macos-bundle runs on macOS only");
  process.exit(2);
}
console.log(
  `Snipvero ${packageVersion} (bundle ${coreVersion} build ${tauriConfig.bundle.macOS.bundleVersion}), ${archOption}${distribution ? ", distribution" : ""}`,
);
const standalone = verifyApp(join(bundleDir, "macos", `${tauriConfig.productName}.app`), "App");
verifyDmg(standalone);
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
