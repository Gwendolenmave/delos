/**
 * The desktop shell's security policy, as PURE DATA AND DECISIONS - no
 * Electron import here, so every rule is unit-testable without a display or
 * an Electron binary, and `main.ts` stays a thin composition that applies
 * them verbatim.
 */

/** The exact webPreferences the one BrowserWindow is created with. */
export interface WindowSecurityOptions {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webviewTag: false;
  readonly preload: string;
}

export function windowSecurity(preloadPath: string): WindowSecurityOptions {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    preload: preloadPath,
  };
}

/**
 * Navigation policy: the window may only ever show the local daemon.
 * Everything else - external sites, file URLs, redirects - is refused, and
 * `openExternal` is NOT the fallback: a desktop app that silently forwards
 * arbitrary URLs to the OS browser is a phishing primitive.
 */
export function navigationAllowed(daemonOrigin: string, targetUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const origin = new URL(daemonOrigin);
    return target.origin === origin.origin;
  } catch {
    return false;
  }
}

/** New windows are never allowed; there is exactly one window. */
export function windowOpenAllowed(): boolean {
  return false;
}

/**
 * The complete allowlist of IPC channels the preload bridge may invoke.
 * Anything else is refused at the main-process handler layer. Read the list
 * as the renderer's ENTIRE extra capability surface beyond the daemon API:
 * no secret ever travels back to the renderer - `secret-set` stores and
 * returns only `{ ok }`, and there is deliberately no `secret-get`.
 */
export const IPC_CHANNELS = [
  "delos:version",
  "delos:secret-set",
  "delos:secret-delete",
  "delos:secret-status",
  "delos:open-data-dir",
  "delos:export-file",
  "delos:import-file",
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

export function ipcChannelAllowed(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}
