import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("GHSA-p4f5-76q4-ffq7 cannot add an outside file to the serving allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snipvero-vite-security-"));
  let server;
  try {
    const root = join(directory, "project");
    const canary = join(directory, "canary.txt");
    await mkdir(root);
    await writeFile(canary, "SNIPVERO-TEST-CANARY-not-valid-js\n");
    server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, fs: { strict: true, allow: [root] } },
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    // /@fs/ prefixes both POSIX paths and Windows drive-letter paths.
    const fileUrl = `/@fs/${canary.replaceAll("\\", "/").replace(/^\/+/, "")}`;
    assert.equal((await fetch(base + fileUrl)).status, 403);

    // The advisory's file-read PoC, confined to a disposable file owned by this test.
    const payload = `__vite-browser-external:\`);}});\nimport '${fileUrl}';\nvar z=new Proxy({}, {get(_, key) {throw new Error(\``;
    const response = await fetch(`${base}/@id/${encodeURIComponent(payload)}?import`);
    await response.text();
    const after = await fetch(base + fileUrl);
    assert.equal(after.status, 403);
    assert.ok(!(await after.text()).includes("SNIPVERO-TEST-CANARY"));
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
