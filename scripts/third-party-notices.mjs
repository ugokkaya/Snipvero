// Generates THIRD_PARTY_NOTICES.txt: the license texts of every Rust crate compiled into the
// executable and every npm package bundled into the frontend, and fails if one of them is under a
// license outside the project's policy (docs/DECISIONS.md, ADR-021).
//
//   node scripts/third-party-notices.mjs           write the file
//   node scripts/third-party-notices.mjs --check   fail if it is missing, stale or not allowed
//
// No dependencies: Cargo's own metadata and Vite's own module graph are the sources.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "THIRD_PARTY_NOTICES.txt");
const fallbackDir = join(root, "scripts", "licenses");

// Release targets plus Windows, whose CI build bundles the same file.
const rustTargets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];

// Permissive licenses only (AGENTS.md); MPL-2.0 for unmodified use. A component passes if one
// alternative of its SPDX expression consists of these alone.
const allowed = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "0BSD",
  "BSL-1.0",
  "CC0-1.0",
  "Unlicense",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "MPL-2.0",
]);
// Order in which a choice between licenses is made: the shortest obligations first.
const preference = [
  "MIT",
  "ISC",
  "Zlib",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MIT-0",
  "Unlicense",
  "CC0-1.0",
  "BSL-1.0",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "MPL-2.0",
];
// Which license a file holds: by its name (LICENSE-MIT) or else by its text. A file that matches
// none (NOTICE, COPYRIGHT) is always kept.
const families = [
  { id: /^MIT-0$/, name: /mit-0/i, text: null },
  { id: /^MIT$/, name: /mit/i, text: /permission is hereby granted, free of charge/i },
  { id: /^Apache-2\.0/, name: /apache/i, text: /apache license\s+version 2\.0/i },
  { id: /^BSD-/, name: /bsd/i, text: /redistribution and use in source and binary forms/i },
  { id: /^0BSD$/, name: /0bsd/i, text: null },
  { id: /^Zlib$/, name: /zlib/i, text: /provided 'as-is', without any express or implied/i },
  { id: /^ISC$/, name: /isc/i, text: /with or without fee is hereby granted, provided that/i },
  { id: /^MPL-2\.0$/, name: /mpl/i, text: /mozilla public license,? version 2\.0/i },
  { id: /^Unicode-/, name: /unicode/i, text: /unicode license|unicode, inc\. license/i },
  { id: /^Unlicense$/, name: /^unlicense/i, text: /free and unencumbered software released/i },
  { id: /^BSL-1\.0$/, name: /boost|bsl/i, text: /boost software license/i },
  { id: /^CC0-1\.0$/, name: /cc0/i, text: /cc0 1\.0 universal/i },
];
const licenseFile = /^(licen[cs]e|copying|notice|copyright|unlicense)([-_.][^/]*)?$/i;
const sourceFile = /\.(rs|toml|json|js|ts|lock)$/i;

// Crates published without license files. Texts taken from their source repositories.
const fallbacks = [
  [/^Rust standard library$/, ["rust-MIT.txt"]],
  [/^(objc2(-.+)?|block2|dispatch2)$/, ["objc2-MIT.txt"]],
  [/^alloc-stdlib$/, ["rust-alloc-no-stdlib-BSD-3-Clause.txt"]],
  [/^selectors$/, ["MPL-2.0.txt"]],
  [/^webview2-com(-.+)?$/, ["webview2-rs-MIT.txt"]],
  [/^clipboard-win$/, ["clipboard-win-BSL-1.0.txt"]],
];

const problems = [];

// --- SPDX: expression → alternatives, each a list of licenses that all apply --------------------

function alternatives(expression) {
  const tokens = expression
    .replaceAll("/", " OR ")
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const parseOr = () => {
    let result = parseAnd();
    while (tokens[i] === "OR") {
      i++;
      result = [...result, ...parseAnd()];
    }
    return result;
  };
  const parseAnd = () => {
    let result = parseAtom();
    while (tokens[i] === "AND") {
      i++;
      const right = parseAtom();
      result = result.flatMap((left) => right.map((r) => [...left, ...r]));
    }
    return result;
  };
  const parseAtom = () => {
    const token = tokens[i++];
    if (token === "(") {
      const inner = parseOr();
      if (tokens[i++] !== ")") throw new Error(`unbalanced license expression: ${expression}`);
      return inner;
    }
    if (token === undefined || ["AND", "OR", "WITH", ")"].includes(token)) {
      throw new Error(`invalid license expression: ${expression}`);
    }
    if (tokens[i] === "WITH") {
      const exception = tokens[i + 1];
      i += 2;
      return [[`${token} WITH ${exception}`]];
    }
    return [[token]];
  };
  const result = parseOr();
  if (i !== tokens.length) throw new Error(`invalid license expression: ${expression}`);
  return result;
}

const rank = (license) => {
  const index = preference.indexOf(license);
  return index === -1 ? preference.length : index;
};
const familyOf = (license) => families.find((f) => f.id.test(license));

function classify(file) {
  const [mit0, mit, , , zeroBsd, , , , , , boost] = families;
  const named = new Set(families.filter((f) => f.name.test(file.name)));
  if (named.size > 0) {
    // "LICENSE-MIT-0" also contains "mit", "LICENSE-0BSD" also "bsd".
    if (named.has(mit0)) named.delete(mit);
    if (named.has(zeroBsd)) named.delete(families[3]);
    return named;
  }
  const text = file.text.replace(/\s+/g, " ");
  const found = new Set(families.filter((f) => f.text?.test(text)));
  // The Boost text shares the MIT grant sentence; MIT-0 is MIT without the notice condition.
  if (found.has(boost)) found.delete(mit);
  if (found.has(mit) && !/shall be included in all copies/i.test(text)) {
    found.delete(mit);
    found.add(mit0);
  }
  return found;
}

// Picks the alternative the component is used under, and the license files that belong to it.
function elect(name, expression, files) {
  let options;
  try {
    options = alternatives(expression);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
    return { used: expression, files };
  }
  const permitted = options.filter((option) => option.every((license) => allowed.has(license)));
  if (permitted.length === 0) {
    problems.push(`${name}: license "${expression}" is not allowed`);
    return { used: expression, files };
  }
  const kinds = files.map(classify);
  const covered = (option) =>
    option.every((license) => kinds.some((kind) => kind.has(familyOf(license))));
  const score = (option) => Math.max(...option.map(rank));
  const chosen = [...permitted].sort(
    (a, b) => Number(covered(b)) - Number(covered(a)) || score(a) - score(b),
  )[0];
  if (!covered(chosen)) return { used: chosen.join(" AND "), files }; // unclear: keep them all
  const wanted = new Set(chosen.map(familyOf));
  return {
    used: chosen.join(" AND "),
    files: files.filter((_, i) => kinds[i].size === 0 || [...kinds[i]].some((f) => wanted.has(f))),
  };
}

function readLicenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => licenseFile.test(name) && !sourceFile.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function fallbackFiles(name) {
  const entry = fallbacks.find(([pattern]) => pattern.test(name));
  return (entry?.[1] ?? []).map((file) => ({
    name: file,
    text: readFileSync(join(fallbackDir, file), "utf8"),
  }));
}

function component(kind, name, version, expression, repository, files) {
  const id = `${name} ${version}`;
  if (!expression) problems.push(`${id}: no license declared`);
  const found = files.length > 0 ? files : fallbackFiles(name);
  if (found.length === 0) problems.push(`${id}: no license text found`);
  const { used, files: selected } = elect(id, expression ?? "", found);
  return { kind, name, version, expression, used, repository, files: selected };
}

// --- Rust: crates reachable through normal dependencies (build and dev dependencies do not ship)

function rustComponents() {
  const byId = new Map();
  for (const target of rustTargets) {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--format-version=1",
          "--locked",
          `--filter-platform=${target}`,
          "--manifest-path",
          join(root, "src-tauri", "Cargo.toml"),
        ],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      ),
    );
    const packages = new Map(metadata.packages.map((p) => [p.id, p]));
    const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
    const start = metadata.packages.find((p) => p.name === "snipvero" && p.source === null);
    const pending = [start.id];
    const seen = new Set();
    while (pending.length > 0) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id).deps) {
        if (dep.dep_kinds.some((k) => k.kind === null)) pending.push(dep.pkg);
      }
    }
    seen.delete(start.id);
    for (const id of seen) byId.set(id, packages.get(id));
  }
  return [...byId.values()].map((p) =>
    component(
      "rust",
      p.name,
      p.version,
      p.license,
      p.repository ?? "",
      readLicenseFiles(dirname(p.manifest_path)),
    ),
  );
}

// --- JavaScript: packages whose code ends up in the production bundle ---------------------------

async function javascriptComponents() {
  const require = createRequire(join(root, "package.json"));
  const packageRoot = (file) => {
    let dir = dirname(file);
    while (
      !existsSync(join(dir, "package.json")) ||
      !JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name
    ) {
      dir = dirname(dir);
    }
    return dir;
  };
  const viteRoot = packageRoot(require.resolve("vite"));
  const rolldownRoot = packageRoot(
    createRequire(join(viteRoot, "package.json")).resolve("rolldown"),
  );

  const { build } = await import("vite");
  const result = await build({ root, logLevel: "silent", build: { write: false } });
  const roots = new Set();
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const chunk of bundle.output) {
      if (chunk.type !== "chunk") continue;
      for (const id of chunk.moduleIds) {
        // Runtime helpers the bundler itself injects.
        if (id.startsWith("\0vite/")) roots.add(viteRoot);
        else if (id.startsWith("\0rolldown/")) roots.add(rolldownRoot);
        else if (id.startsWith("\0")) problems.push(`unknown virtual module in bundle: ${id}`);
        else if (id.split(/[\\/]/).includes("node_modules")) roots.add(packageRoot(id));
        else if (!resolve(id).startsWith(root + sep))
          problems.push(`module outside project: ${id}`);
      }
    }
  }
  return [...roots].map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const repository =
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? "");
    const license = typeof manifest.license === "string" ? manifest.license : null;
    return component(
      "npm",
      manifest.name,
      manifest.version,
      license,
      repository,
      readLicenseFiles(dir),
    );
  });
}

// --- Output -------------------------------------------------------------------------------------

const normalize = (text) =>
  text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

function render(components) {
  const texts = new Map(); // normalized text → { index, users }
  for (const c of components) {
    c.refs = c.files.map((file) => {
      const text = normalize(file.text);
      if (!texts.has(text)) texts.set(text, { index: texts.size + 1, users: [] });
      const entry = texts.get(text);
      entry.users.push(`${c.name} ${c.version}`);
      return entry.index;
    });
  }
  const rule = "=".repeat(78);
  const lines = [
    "Snipvero: third-party software notices",
    "",
    "Snipvero is released under the MIT License (LICENSE). It contains the third-party",
    "components listed below, each under its own license. Where a component offers a choice of",
    'licenses, Snipvero uses it under the license shown as "used under"; the full texts follow.',
    "",
    "Generated by scripts/third-party-notices.mjs from src-tauri/Cargo.lock and the frontend",
    "bundle. Do not edit by hand.",
    "",
  ];
  const sections = [
    ["Rust crates compiled into the Snipvero executable", "rust"],
    ["JavaScript packages bundled into the Snipvero user interface", "npm"],
  ];
  for (const [title, kind] of sections) {
    const list = components.filter((c) => c.kind === kind);
    lines.push(rule, `${title} (${list.length})`, rule, "");
    for (const c of list) {
      lines.push(`${c.name} ${c.version}`);
      lines.push(
        `  License: ${c.expression}${c.used !== c.expression ? ` (used under ${c.used})` : ""}`,
      );
      if (c.repository) lines.push(`  Source: ${c.repository}`);
      lines.push(`  License text: ${c.refs.map((n) => `[${n}]`).join(" ")}`, "");
    }
  }
  lines.push(rule, "License texts", rule, "");
  for (const [text, { index, users }] of texts) {
    lines.push(`----- [${index}] -----`, `Used by: ${users.join(", ")}`, "", text, "");
  }
  return lines.join("\n");
}

const compare = (a, b) =>
  a.kind.localeCompare(b.kind) ||
  a.name.localeCompare(b.name) ||
  a.version.localeCompare(b.version, undefined, { numeric: true });

const components = [
  // Linked into every Rust executable, but not a crate in Cargo.lock.
  component(
    "rust",
    "Rust standard library",
    "(toolchain)",
    "MIT OR Apache-2.0",
    "https://github.com/rust-lang/rust",
    [],
  ),
  ...rustComponents().sort(compare),
  ...(await javascriptComponents()).sort(compare),
];
const text = `${render(components)}\n`;

if (problems.length > 0) {
  console.error(`Third-party license check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const counts = `${components.filter((c) => c.kind === "rust").length} Rust, ${components.filter((c) => c.kind === "npm").length} npm`;
if (process.argv.includes("--check")) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== text) {
    console.error(
      `${relative(root, output)} is out of date: run \`pnpm notices\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`${relative(root, output)} is up to date (${counts} components, licenses allowed).`);
} else {
  writeFileSync(output, text);
  console.log(`Wrote ${relative(root, output)} (${counts} components).`);
}
