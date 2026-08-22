/**
 * What a packaged desktop app must carry in its resources directory - as
 * PURE DATA, so a unit test can hold the packaging recipe to the daemon's
 * actual path derivation without packaging anything.
 *
 * The daemon resolves everything relative to the shipped persona directory:
 * with shippedPersonaDir = <resources>/personas it serves
 *   <resources>/surfaces/web/static        (index.html, styles.css)
 *   <resources>/build/surfaces/web/app     (compiled web app modules)
 *   <resources>/build/surfaces/api-client  (compiled typed client)
 * A package missing any of these opens to a 404 instead of the web UI -
 * which is exactly the defect this module exists to make untestable to
 * reintroduce.
 */

import { join } from "node:path";

export interface ResourceCopy {
  /** Absolute source in the repository checkout. */
  readonly from: string;
  /** Destination relative to the package's resources directory. */
  readonly to: string;
}

export function packagedResources(repoRoot: string): readonly ResourceCopy[] {
  return [
    { from: join(repoRoot, "personas"), to: "personas" },
    { from: join(repoRoot, "surfaces", "web", "static"), to: join("surfaces", "web", "static") },
    { from: join(repoRoot, "build", "surfaces", "web", "app"), to: join("build", "surfaces", "web", "app") },
    { from: join(repoRoot, "build", "surfaces", "api-client"), to: join("build", "surfaces", "api-client") },
  ];
}

/**
 * The directories the daemon will actually read, derived the same way the
 * daemon derives them from a shipped-persona dir. The test asserts every
 * one of these is produced by packagedResources().
 */
export function daemonExpectedResourceDirs(): readonly string[] {
  const shippedPersonaDir = "personas";
  const root = join(shippedPersonaDir, "..");
  return [
    shippedPersonaDir,
    join(root, "surfaces", "web", "static"),
    join(root, "build", "surfaces", "web", "app"),
    join(root, "build", "surfaces", "api-client"),
  ];
}
