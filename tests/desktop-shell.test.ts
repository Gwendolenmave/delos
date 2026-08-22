/**
 * Desktop shell logic - policy and secret store - WITHOUT an Electron
 * binary. The modules under test import no Electron API: safeStorage is
 * injected as a narrow fake, and the security policy is pure decisions that
 * main.ts applies verbatim. What an Electron process would add on top
 * (real safeStorage, real dialogs) is exercised only on a host that can
 * launch Electron, and reported honestly either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDesktopSecretStore,
  type SafeStorageLike,
} from "../desktop/src/desktop-secret-store.js";
import {
  IPC_CHANNELS,
  ipcChannelAllowed,
  navigationAllowed,
  windowOpenAllowed,
  windowSecurity,
} from "../desktop/src/security-policy.js";

/** Reversible fake "encryption" so tests can see what IS and IS NOT stored. */
function fakeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc[${Buffer.from(plain).toString("base64")}]`),
    decryptString: (buffer) => {
      const match = /^enc\[(.+)\]$/.exec(buffer.toString());
      if (match === null) throw new Error("not ciphertext");
      return Buffer.from(match[1]!, "base64").toString();
    },
  };
}

test("window security is exactly the promised shape", () => {
  const security = windowSecurity("/p/preload.js");
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.sandbox, true);
  assert.equal(security.webviewTag, false);
});

test("navigation is pinned to the daemon origin; everything else refused", () => {
  const origin = "http://127.0.0.1:39471";
  assert.equal(navigationAllowed(origin, `${origin}/`), true);
  assert.equal(navigationAllowed(origin, `${origin}/app/web/app/main.js`), true);
  for (const target of [
    "https://example.com/",
    "http://127.0.0.1:39472/", // another local port is another origin
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(navigationAllowed(origin, target), false, `${target} was allowed`);
  }
  assert.equal(windowOpenAllowed(), false);
});

test("the IPC surface is closed: no secret-get, no generic invoke", () => {
  assert.ok(ipcChannelAllowed("delos:secret-set"));
  assert.ok(!ipcChannelAllowed("delos:secret-get"), "a secret read channel exists");
  assert.ok(!ipcChannelAllowed("delos:eval"));
  assert.ok(!IPC_CHANNELS.some((c) => /get.*secret|secret.*get/i.test(c)));
});

test("encrypted-persistent mode: ciphertext on disk, plaintext never", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-desktop-"));
  const filePath = join(dir, "desktop-secrets.json");
  try {
    const store = createDesktopSecretStore({ safeStorage: fakeSafeStorage(true), filePath });
    assert.equal(store.status().mode, "encrypted-persistent");

    await store.set!("provider:openai", "stored-desktop-value-123");
    const onDisk = await readFile(filePath, "utf8");
    assert.ok(!onDisk.includes("stored-desktop-value-123"), "plaintext reached the disk");
    const stored = (JSON.parse(onDisk) as { entries: Record<string, string> }).entries["provider:openai"];
    assert.ok(
      Buffer.from(stored ?? "", "base64").toString().startsWith("enc["),
      "what persists must be the encryptor's output",
    );

    const lookup = await store.get("provider:openai");
    assert.deepEqual(lookup, { found: true, value: "stored-desktop-value-123" });

    // A NEW store over the same file - the restart case - still resolves it.
    const reopened = createDesktopSecretStore({ safeStorage: fakeSafeStorage(true), filePath });
    assert.equal((await reopened.get("provider:openai")).found, true);
    assert.deepEqual(reopened.status().configuredIds, ["provider:openai"]);

    await store.delete!("provider:openai");
    assert.equal((await store.get("provider:openai")).found, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("undecryptable ciphertext reports unavailable, not a crash or a wrong value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-desktop-"));
  const filePath = join(dir, "desktop-secrets.json");
  try {
    const store = createDesktopSecretStore({ safeStorage: fakeSafeStorage(true), filePath });
    await store.set!("provider:anthropic", "value");
    // Another machine's keychain: decryption fails.
    const broken = createDesktopSecretStore({
      safeStorage: {
        ...fakeSafeStorage(true),
        decryptString: () => {
          throw new Error("keychain says no");
        },
      },
      filePath,
    });
    const lookup = await broken.get("provider:anthropic");
    assert.equal(lookup.found, false);
    if (!lookup.found) assert.equal(lookup.reason, "unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session-only fallback: honest mode, nothing written to disk, gone on new store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-desktop-"));
  const filePath = join(dir, "desktop-secrets.json");
  try {
    const store = createDesktopSecretStore({ safeStorage: fakeSafeStorage(false), filePath });
    assert.equal(store.status().mode, "session-only");
    await store.set!("provider:openai", "ephemeral-value");
    assert.equal((await store.get("provider:openai")).found, true);
    await assert.rejects(() => readFile(filePath, "utf8"), "session-only mode wrote a file");

    // A "restart": a fresh store has nothing - and says why.
    const next = createDesktopSecretStore({ safeStorage: fakeSafeStorage(false), filePath });
    const lookup = await next.get("provider:openai");
    assert.equal(lookup.found, false);
    if (!lookup.found) assert.match(lookup.detail, /one session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the packaging manifest covers every directory the daemon will read", async () => {
  const { packagedResources, daemonExpectedResourceDirs } = await import(
    "../desktop/src/packaging-manifest.js"
  );
  const { join: joinPath, normalize } = await import("node:path");
  const produced = new Set(packagedResources("/repo").map((r) => normalize(r.to)));
  for (const expected of daemonExpectedResourceDirs()) {
    assert.ok(
      produced.has(normalize(expected)),
      `a packaged app would miss ${expected} - the desktop window would open to a 404`,
    );
  }
  // And every source comes from the repository the recipe was given.
  for (const entry of packagedResources("/repo")) {
    assert.ok(normalize(entry.from).startsWith(normalize(joinPath("/repo"))), entry.from);
  }
});

test("the daemon consults an injected desktop store before the environment", async () => {
  const { startDaemon } = await import("../surfaces/daemon/daemon.js");
  const { dirname: pathDirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const shipped = join(pathDirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
  const dataDir = await mkdtemp(join(tmpdir(), "delos-desktop-daemon-"));
  const filePath = join(dataDir, "desktop-secrets.json");
  try {
    const desktopStore = createDesktopSecretStore({ safeStorage: fakeSafeStorage(true), filePath });
    await desktopStore.set!("provider:openai", "from-desktop-store");
    const daemon = await startDaemon({
      dataDir,
      shippedPersonaDir: shipped,
      env: {}, // the environment has NOTHING - the desktop store must answer
      secretStores: [desktopStore],
    });
    try {
      // Reach the chain through the daemon's own composition: a provider
      // profile whose secret only the desktop store can resolve.
      const response = await fetch(`${daemon.origin}/api/v1/providers`, {
        method: "POST",
        headers: {
          "x-delos-session": daemon.sessionToken,
          origin: daemon.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          id: "desk",
          kind: "openai-compatible",
          model: "m",
          baseUrl: "http://127.0.0.1:1/v1",
          auth: { source: "secret-store", transport: "bearer", secretId: "provider:openai" },
        }),
      });
      assert.equal(response.status, 201);
      // The connection test will FAIL to connect (port 1) - but it must fail
      // at the network, not at the credential: the chain resolved the secret.
      const probe = await fetch(`${daemon.origin}/api/v1/providers/desk/test`, {
        method: "POST",
        headers: { "x-delos-session": daemon.sessionToken, origin: daemon.origin },
      });
      const report = (await probe.json()) as { ok: boolean; error?: { code?: string } };
      assert.equal(report.ok, false);
      assert.notEqual(report.error?.code, "credential-missing", "the desktop store was not consulted");
      assert.notEqual(report.error?.code, "credential-unavailable");
      assert.equal(report.error?.code, "connection-failed", "the failure must be the unreachable endpoint");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
