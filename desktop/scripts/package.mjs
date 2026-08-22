/**
 * Package the desktop app for the CURRENT platform only, unsigned, with
 * checksums. Cross-platform packages are configured in the GitHub Actions
 * workflow (authored, deliberately never run from here) - building a target
 * this host cannot exercise would produce an artifact nobody verified.
 *
 * The resources a working package needs are declared in
 * src/packaging-manifest.ts and unit-tested against the daemon's own path
 * derivation - the recipe here just executes that manifest. The repository
 * web build (`npm run build` at the root) is a prerequisite and is checked,
 * not assumed.
 *
 * Unsigned candidate packages will warn on first launch on macOS and
 * Windows; that is stated rather than worked around.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { packagedResources } from "../build-desktop/desktop/src/packaging-manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const REPO = join(DESKTOP, "..");
const OUT = join(DESKTOP, "dist");

const resources = packagedResources(REPO);
for (const entry of resources) {
  if (!existsSync(entry.from)) {
    console.error(
      `Missing packaged resource source: ${entry.from}\n` +
        `Run "npm run build" at the repository root first - the packaged app ` +
        `serves the SAME web application, so its compiled assets must exist.`,
    );
    process.exit(1);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

await mkdir(OUT, { recursive: true });

const paths = await packager({
  dir: DESKTOP,
  out: OUT,
  overwrite: true,
  asar: true,
  // Current platform/arch only - see the header.
  ignore: [
    /^\/src($|\/)/,
    /^\/scripts($|\/)/,
    /^\/tsconfig\.json$/,
    /^\/dist($|\/)/,
  ],
});

// Place the daemon-served assets into each package's resources directory,
// in exactly the layout the daemon derives from <resources>/personas.
for (const packedPath of paths) {
  const entries = await readdir(packedPath);
  const macResources = join(packedPath, "Electron.app", "Contents", "Resources");
  const resourcesDir = entries.includes("resources")
    ? join(packedPath, "resources")
    : macResources;
  for (const entry of resources) {
    await cp(entry.from, join(resourcesDir, entry.to), { recursive: true });
  }
}

const manifest = [];
for (const packedPath of paths) {
  const entries = await readdir(packedPath, { recursive: true });
  for (const entry of entries) {
    const full = join(packedPath, entry);
    const info = await stat(full).catch(() => undefined);
    if (info?.isFile()) {
      manifest.push({ path: join(packedPath, entry).slice(OUT.length + 1), sha256: await sha256(full), bytes: info.size });
    }
  }
}
manifest.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(OUT, "CHECKSUMS.json"), JSON.stringify({ files: manifest }, null, 2) + "\n");
console.log(`packaged: ${paths.join(", ")}`);
console.log(`checksums: ${manifest.length} files -> dist/CHECKSUMS.json`);
