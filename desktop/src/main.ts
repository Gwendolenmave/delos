/**
 * The desktop shell: one window, one daemon, one bridge.
 *
 * The daemon is the SAME loopback daemon `npm run app:web` starts - the
 * desktop app is a lifecycle owner and a secure secret store, not a second
 * runtime. The window loads the daemon's own served page, so the web app,
 * the typed client and the session-token gate are identical to the browser
 * path. What the desktop adds:
 *
 * - single instance, clean daemon shutdown on quit;
 * - an OS-encrypted SecretStore in the main process (session-only fallback
 *   when the OS provides no encryption - stated, never silent);
 * - native file dialogs for import/export;
 * - the security policy from security-policy.ts applied verbatim:
 *   contextIsolation, sandbox, no nodeIntegration, no webviews, navigation
 *   pinned to the daemon origin, new windows denied, permissions denied,
 *   and the minimal typed preload as the only bridge.
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, readFile, stat } from "node:fs/promises";

import { startDaemon, type RunningDaemon } from "../../surfaces/daemon/daemon.js";
import { createDesktopSecretStore } from "./desktop-secret-store.js";
import { navigationAllowed, windowSecurity } from "./security-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT_CAP_BYTES = 10 * 1024 * 1024;

function shippedPersonaDir(): string {
  // Packaged: personas/ travels as an extra resource. Development: the
  // repository's own personas/. The compiled file runs from
  // <repo>/desktop/build-desktop/desktop/src/main.js, so the repository
  // root is FOUR levels up. The daemon derives the web static and build
  // directories as siblings of this path's parent, which is why it must
  // land exactly on <root>/personas in both modes.
  return app.isPackaged
    ? join(process.resourcesPath, "personas")
    : join(HERE, "..", "..", "..", "..", "personas");
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  const dataDir = process.env["DELOS_DATA_DIR"] ?? join(app.getPath("userData"), "delos-data");
  const secretStore = createDesktopSecretStore({
    safeStorage,
    filePath: join(dataDir, "desktop-secrets.json"),
  });

  const daemon: RunningDaemon = await startDaemon({
    dataDir,
    shippedPersonaDir: shippedPersonaDir(),
    env: process.env,
    secretStores: [secretStore],
  });

  // --- IPC: exactly the allowlisted channels, nothing generic ---------------
  ipcMain.handle("delos:version", () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? "",
    platform: process.platform,
  }));
  ipcMain.handle("delos:secret-set", async (_event, secretId: unknown, value: unknown) => {
    if (typeof secretId !== "string" || typeof value !== "string" || secretId.length === 0 || value.length === 0) {
      return { ok: false, detail: "A secret needs a non-empty id and value." };
    }
    await secretStore.set!(secretId, value);
    const mode = secretStore.status().mode;
    return {
      ok: true,
      ...(mode === "session-only"
        ? { detail: "Secure storage is unavailable on this system; this secret lasts until quit." }
        : {}),
    };
  });
  ipcMain.handle("delos:secret-delete", async (_event, secretId: unknown) => {
    if (typeof secretId !== "string") return { ok: false };
    await secretStore.delete!(secretId);
    return { ok: true };
  });
  ipcMain.handle("delos:secret-status", () => secretStore.status());
  ipcMain.handle("delos:open-data-dir", async () => {
    // Explicit user action from the settings page; never automatic.
    await shell.openPath(dataDir);
    return { ok: true };
  });
  ipcMain.handle(
    "delos:export-file",
    async (event, suggestedName: unknown, content: unknown, encoding: unknown) => {
      if (typeof suggestedName !== "string" || typeof content !== "string") return { saved: false };
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null) return { saved: false };
      const choice = await dialog.showSaveDialog(window, { defaultPath: basename(suggestedName) });
      if (choice.canceled || choice.filePath === undefined) return { saved: false };
      // base64 carries binary exports (persona pack ZIPs) faithfully; utf8
      // carries JSON. Nothing else is accepted.
      if (encoding === "base64") {
        await writeFile(choice.filePath, Buffer.from(content, "base64"));
      } else {
        await writeFile(choice.filePath, content, "utf8");
      }
      return { saved: true };
    },
  );
  ipcMain.handle("delos:import-file", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return { opened: false };
    const choice = await dialog.showOpenDialog(window, { properties: ["openFile"] });
    const path = choice.filePaths[0];
    if (choice.canceled || path === undefined) return { opened: false };
    const info = await stat(path);
    if (info.size > IMPORT_CAP_BYTES) return { opened: false };
    // base64 so a binary pack ZIP survives the bridge byte-for-byte; the
    // caller decodes text formats itself.
    return { opened: true, name: basename(path), contentBase64: (await readFile(path)).toString("base64") };
  });

  // --- the one window -------------------------------------------------------
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: `Delos ${app.getVersion()}`,
    webPreferences: windowSecurity(join(HERE, "preload.cjs")),
  });
  window.setMenuBarVisibility(false);

  window.webContents.on("will-navigate", (event, url) => {
    if (!navigationAllowed(daemon.origin, url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  let closed = false;
  const shutdown = async () => {
    if (!closed) {
      closed = true;
      await daemon.close();
    }
  };
  app.on("before-quit", () => {
    void shutdown();
  });
  app.on("window-all-closed", () => {
    void shutdown().then(() => app.quit());
  });

  await window.loadURL(daemon.origin);
}

void main();
