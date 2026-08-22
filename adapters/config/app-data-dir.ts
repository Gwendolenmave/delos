/**
 * The platform application-data directory for Delos, honoured everywhere a
 * surface needs one: web launcher, desktop shell, CLI doctor. DELOS_DATA_DIR
 * overrides for tests and portable setups.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export function defaultDataDir(env: Readonly<Record<string, string | undefined>>): string {
  const override = env["DELOS_DATA_DIR"];
  if (override !== undefined && override.length > 0) return override;
  const home = homedir();
  if (platform() === "win32") {
    return join(env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Delos");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Delos");
  }
  return join(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "delos");
}
