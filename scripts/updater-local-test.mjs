// Local end-to-end test of the in-app updater (RELEASE.md §11), without the internet, the release
// key or the release endpoint. Builds two test versions of the app under a separate identifier
// ("Snipvero Update Test", com.snipvero.updatetest), signs their update packages with throwaway
// keys, and serves update scenarios from 127.0.0.1 only. The installed Snipvero is not touched.
//
//   node scripts/updater-local-test.mjs prepare --dir /tmp/snipvero-update-test
//   node scripts/updater-local-test.mjs serve --dir /tmp/snipvero-update-test --scenario newer [--slow]
//
// Test builds use an http endpoint, so `pnpm verify:macos` rejects them; never publish one.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const dir = resolve(option("--dir", "/tmp/snipvero-update-test"));
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PRODUCT = "Snipvero Update Test";
const INSTALLED = "0.1.0-beta.3";
const NEWER = "0.1.0-beta.90";
const SCENARIOS = [
  "newer",
  "same",
  "older",
  "wrong-arch",
  "other-key",
  "wrong-version",
  "corrupted",
  "malformed",
  "server-error",
  "offline",
];

function run(cmd, cmdArgs, env = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
}

const packageFile = (version, variant = "") =>
  `Snipvero_${version}_aarch64${variant ? `.${variant}` : ""}.app.tar.gz`;

function sign(key, version, file) {
  run("pnpm", ["-s", "tauri", "signer", "sign", "-f", key, "--app-version", version, file], {
    CI: "true",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  });
  return readFileSync(`${file}.sig`, "utf8").trim();
}

function prepare() {
  if (existsSync(dir)) throw new Error(`${dir} exists; choose a new --dir`);
  if (dir.startsWith(`${root}/`)) throw new Error("--dir must be outside the repository");
  for (const sub of ["keys", "builds", "www/packages", "www/scenarios", "Applications"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  const keys = join(dir, "keys");
  for (const name of ["test", "other"]) {
    run("pnpm", [
      "-s",
      "tauri",
      "signer",
      "generate",
      "--ci",
      "-p",
      "",
      "-w",
      join(keys, `${name}.key`),
    ]);
  }
  const pubkey = readFileSync(join(keys, "test.key.pub"), "utf8").trim();

  for (const version of [INSTALLED, NEWER]) {
    const config = join(dir, `config-${version}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        identifier: "com.snipvero.updatetest",
        productName: PRODUCT,
        version,
        plugins: {
          updater: {
            pubkey,
            endpoints: [`${ORIGIN}/beta.json`],
            requireSignedVersion: true,
            dangerousInsecureTransportProtocol: true,
          },
        },
      }),
    );
    // APPLE_SIGNING_IDENTITY (for example "Snipvero Local Development", ADR-011) keeps a Screen
    // Recording grant across the update; without it the builds are signed ad hoc.
    run("pnpm", ["tauri", "build", "--bundles", "app", "--config", config], {
      CI: "true",
      CARGO_TARGET_DIR: join(dir, "target"),
    });
    const out = join(dir, "builds", version);
    mkdirSync(out);
    run("ditto", [
      join(dir, "target/release/bundle/macos", `${PRODUCT}.app`),
      join(out, `${PRODUCT}.app`),
    ]);
  }

  // Update packages of the newer version, made like the release script makes them.
  const packages = join(dir, "www/packages");
  const valid = join(packages, packageFile(NEWER));
  run(
    "tar",
    [
      "--no-mac-metadata",
      "--no-xattrs",
      "-czf",
      valid,
      "-C",
      join(dir, "builds", NEWER),
      `${PRODUCT}.app`,
    ],
    {
      COPYFILE_DISABLE: "1",
    },
  );
  const variant = (name) => {
    const file = join(packages, packageFile(NEWER, name));
    copyFileSync(valid, file);
    return file;
  };
  const signature = sign(join(keys, "test.key"), NEWER, valid);
  const otherKey = sign(join(keys, "other.key"), NEWER, variant("other-key"));
  // Signed for another version: a manifest announcing NEWER must not accept it.
  const wrongVersion = sign(join(keys, "test.key"), "0.1.0-beta.89", variant("wrong-version"));
  const corrupted = variant("corrupted");
  const bytes = readFileSync(corrupted);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(corrupted, bytes);

  const manifest = (version, platform, file, sig) =>
    JSON.stringify(
      {
        version,
        notes: `Local updater test build ${version}.\nSecond line of plain-text notes.`,
        pub_date: "2026-11-01T12:00:00Z",
        platforms: { [platform]: { url: `${ORIGIN}/packages/${basename(file)}`, signature: sig } },
      },
      null,
      2,
    );
  const scenarios = {
    newer: manifest(NEWER, "darwin-aarch64", valid, signature),
    same: manifest(INSTALLED, "darwin-aarch64", valid, signature),
    older: manifest("0.1.0-beta.2", "darwin-aarch64", valid, signature),
    "wrong-arch": manifest(NEWER, "darwin-x86_64", valid, signature),
    "other-key": manifest(
      NEWER,
      "darwin-aarch64",
      join(packages, packageFile(NEWER, "other-key")),
      otherKey,
    ),
    "wrong-version": manifest(
      NEWER,
      "darwin-aarch64",
      join(packages, packageFile(NEWER, "wrong-version")),
      wrongVersion,
    ),
    corrupted: manifest(NEWER, "darwin-aarch64", corrupted, signature),
    malformed: '{ "version": "0.1.0-beta.90", "platforms": ',
  };
  for (const [name, body] of Object.entries(scenarios)) {
    writeFileSync(join(dir, "www/scenarios", `${name}.json`), body);
  }
  run("ditto", [
    join(dir, "builds", INSTALLED, `${PRODUCT}.app`),
    join(dir, "Applications", `${PRODUCT}.app`),
  ]);
  console.log(`\nPrepared ${dir}.
Installed test app (${INSTALLED}): ${join(dir, "Applications", `${PRODUCT}.app`)}
Next: node scripts/updater-local-test.mjs serve --dir ${dir} --scenario newer
      open "${join(dir, "Applications", `${PRODUCT}.app`)}"   then Check for Updates… in its Updates row`);
}

function serve() {
  let scenario = option("--scenario", "newer");
  if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario: one of ${SCENARIOS.join(", ")}`);
  let slow = args.includes("--slow");
  const prompt = () =>
    console.log(
      `\nScenario "${scenario}"${slow ? " (slow download)" : ""}. In the app: About → Check for Updates… ` +
        "(or Check Again / Try Again / Not Now first).\n" +
        `Type another scenario and Enter to switch (add " slow" for a slow download): ${SCENARIOS.join(", ")}`,
    );
  // Switching here keeps the server running, so no check is missed between scenarios.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (line) => {
    const [name, flag] = line.trim().split(/\s+/);
    if (!name) return;
    if (!SCENARIOS.includes(name)) return console.log(`Unknown scenario "${name}"`);
    scenario = name;
    slow = flag === "slow";
    prompt();
  });
  const server = createServer((request, response) => {
    // What the app sends, so the privacy claims can be checked: method, path, User-Agent.
    console.log(
      `${request.method} ${request.url} user-agent="${request.headers["user-agent"] ?? ""}" → ${scenario}`,
    );
    const url = new URL(request.url ?? "/", ORIGIN);
    // A dropped connection: what the app sees without a network.
    if (scenario === "offline") return request.socket.destroy();
    if (url.pathname === "/beta.json") {
      if (scenario === "server-error") return response.writeHead(500).end();
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(readFileSync(join(dir, "www/scenarios", `${scenario}.json`)));
    }
    const file = join(dir, "www/packages", basename(url.pathname));
    if (!url.pathname.startsWith("/packages/") || !existsSync(file))
      return response.writeHead(404).end();
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": statSync(file).size,
    });
    if (!slow) return createReadStream(file).pipe(response);
    // About 120 KB/s: time to watch the progress, press Cancel, or start a capture.
    const stream = createReadStream(file, { highWaterMark: 16 * 1024 });
    stream.on("data", (chunk) => {
      stream.pause();
      response.write(chunk);
      setTimeout(() => stream.resume(), 130);
    });
    stream.on("end", () => response.end());
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Serving on ${ORIGIN}; Ctrl+C stops it (the app then cannot reach it).`);
    prompt();
  });
}

try {
  if (command === "prepare") prepare();
  else if (command === "serve") serve();
  else
    throw new Error(
      "usage: updater-local-test.mjs prepare|serve --dir DIR [--scenario NAME] [--slow]",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
