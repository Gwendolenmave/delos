/**
 * The daemon's static surface: the page, its assets, and nothing else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../surfaces/daemon/daemon.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-web-"));
  const daemon = await startDaemon({ dataDir, shippedPersonaDir: SHIPPED, env: {} });
  return {
    daemon,
    close: async () => {
      await daemon.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("web: the page is served with the session token injected, unauthenticated", async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.daemon.origin}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(h.daemon.sessionToken), "the served page carries the session");
    assert.ok(!html.includes("__DELOS_SESSION__"), "the placeholder survived");
    assert.match(html, /<meta name="delos-session"/);
  } finally {
    await h.close();
  }
});

test("web: app modules and stylesheet are served; everything else 404s", async () => {
  const h = await harness();
  try {
    const css = await fetch(`${h.daemon.origin}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const js = await fetch(`${h.daemon.origin}/app/web/app/main.js`);
    assert.equal(js.status, 200, "the compiled app module must be reachable");
    const client = await fetch(`${h.daemon.origin}/app/api-client/client.js`);
    assert.equal(client.status, 200, "the typed client must be importable by the page");

    for (const path of [
      "/app/../package.json",
      "/app/web/app/../../daemon/daemon.js",
      "/%2e%2e/package.json",
      "/app/web/app/x%2f..%2f..%2fmain.js",
      "/anything-else",
    ]) {
      const response = await fetch(`${h.daemon.origin}${path}`);
      assert.equal(response.status, 404, `${path} escaped the allowlist`);
    }
  } finally {
    await h.close();
  }
});

test("web: the served app contains no credential-shaped literal", async () => {
  const h = await harness();
  try {
    const js = await (await fetch(`${h.daemon.origin}/app/web/app/main.js`)).text();
    assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(js));
    assert.ok(!js.includes("localStorage"), "the app must not persist anything in localStorage");
    assert.ok(!js.includes("sessionStorage"), "nor sessionStorage");
    assert.ok(!js.includes("indexedDB"), "nor IndexedDB");
    assert.ok(!/\.innerHTML\s*=/.test(js), "model text must never meet innerHTML");
  } finally {
    await h.close();
  }
});
