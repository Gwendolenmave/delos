import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { MNEMOSYNE_PACKAGE_NAME } from "../adapters/memory/mnemosyne-package.js";

interface PackageDocument {
  readonly version?: string;
  readonly private?: boolean;
  readonly engines?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

interface LockDocument {
  readonly version?: string;
  readonly packages?: Record<string, PackageDocument>;
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), name), "utf8")) as T;
}

test("v0.2 declares Mnemosyne as an optional peer, not a bundled dependency", async () => {
  const pkg = await readJson<PackageDocument>("package.json");
  const lock = await readJson<LockDocument>("package-lock.json");
  const root = lock.packages?.[""];

  assert.equal(MNEMOSYNE_PACKAGE_NAME, "@delos/mnemosyne");
  assert.equal(pkg.version, "0.2.0-dev.0");
  assert.equal(lock.version, pkg.version);
  assert.equal(root?.version, pkg.version);
  assert.equal(pkg.private, true, "staging remains non-publishable by npm");

  assert.equal(pkg.peerDependencies?.[MNEMOSYNE_PACKAGE_NAME], "^0.1.0");
  assert.equal(pkg.peerDependenciesMeta?.[MNEMOSYNE_PACKAGE_NAME]?.optional, true);
  assert.equal(root?.peerDependencies?.[MNEMOSYNE_PACKAGE_NAME], "^0.1.0");
  assert.equal(root?.peerDependenciesMeta?.[MNEMOSYNE_PACKAGE_NAME]?.optional, true);

  for (const section of [pkg.dependencies, pkg.optionalDependencies, pkg.devDependencies]) {
    assert.equal(
      section?.[MNEMOSYNE_PACKAGE_NAME],
      undefined,
      "Delos must not pretend the currently unpublished package is bundled or installable",
    );
  }

  assert.equal(pkg.engines?.node, ">=22.22.0");
  assert.equal(root?.engines?.node, pkg.engines?.node, "lockfile root must mirror the runtime floor");
});
