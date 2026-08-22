/**
 * The minimal typed preload bridge - the renderer's ENTIRE capability
 * surface beyond the daemon's HTTP API.
 *
 * Every function forwards to one allowlisted IPC channel. There is no
 * secret-get, no eval, no generic invoke passthrough: a compromised
 * renderer can store a secret it already holds, delete one, ask which ids
 * exist, and drive the file dialogs - and nothing else. No plaintext secret
 * ever crosses from main to renderer.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface DelosDesktopBridge {
  version(): Promise<{ app: string; electron: string; platform: string }>;
  /** Store a secret the user just typed. Resolves to ok only - never a value. */
  secretSet(secretId: string, value: string): Promise<{ ok: boolean; detail?: string }>;
  secretDelete(secretId: string): Promise<{ ok: boolean }>;
  secretStatus(): Promise<{ mode: string; configuredIds: readonly string[] }>;
  openDataDir(): Promise<{ ok: boolean }>;
  /**
   * Save content through a native dialog. Content flows renderer->main
   * only; base64 encoding carries binary exports (pack ZIPs) faithfully.
   */
  exportFile(
    suggestedName: string,
    content: string,
    encoding?: "utf8" | "base64",
  ): Promise<{ saved: boolean }>;
  /** Open a file through a native dialog; base64 content, size-capped. */
  importFile(): Promise<{ opened: boolean; name?: string; contentBase64?: string }>;
}

const bridge: DelosDesktopBridge = {
  version: () => ipcRenderer.invoke("delos:version"),
  secretSet: (secretId, value) => ipcRenderer.invoke("delos:secret-set", secretId, value),
  secretDelete: (secretId) => ipcRenderer.invoke("delos:secret-delete", secretId),
  secretStatus: () => ipcRenderer.invoke("delos:secret-status"),
  openDataDir: () => ipcRenderer.invoke("delos:open-data-dir"),
  exportFile: (suggestedName, content, encoding) =>
    ipcRenderer.invoke("delos:export-file", suggestedName, content, encoding ?? "utf8"),
  importFile: () => ipcRenderer.invoke("delos:import-file"),
};

contextBridge.exposeInMainWorld("delosDesktop", bridge);
