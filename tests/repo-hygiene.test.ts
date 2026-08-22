/**
 * B6: repository hygiene as executable policy, not convention.
 *
 * Two layers: the ignore rules must COVER the dangerous categories, and the
 * tree itself must CONTAIN none of them. The tree walk works in a git
 * checkout and in an extracted snapshot alike, so the phase gates exercise
 * both layers from a pristine export.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "build", "build-desktop", ".git", "dist"]);

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
}

test("hygiene: .gitignore covers every dangerous category", async () => {
  const ignore = await readFile(join(ROOT, ".gitignore"), "utf8");
  const lines = ignore.split("\n").map((l) => l.trim());
  for (const required of ["node_modules/", "build/", "*.db", ".env", "secrets/", "data/"]) {
    assert.ok(
      lines.some((l) => l === required || l.startsWith(required)),
      `.gitignore must cover ${required}`,
    );
  }
});

test("hygiene: the tree contains no database, env file, key material, or data dir", async () => {
  const files: string[] = [];
  await walk(ROOT, files);
  assert.ok(files.length > 50, "the walk saw the real tree");

  const forbidden = [
    { rule: /\.(db|sqlite|sqlite3)$/, label: "database file" },
    { rule: /(^|\/)\.env($|\.)/, label: "environment file" },
    { rule: /\.(pem|key|p12|pfx|keystore)$/, label: "key material" },
    { rule: /(^|\/)(data|logs?|secrets?)\//, label: "runtime data directory" },
    { rule: /(^|\/)id_(rsa|ed25519|ecdsa)/, label: "ssh key" },
  ];
  for (const file of files) {
    for (const { rule, label } of forbidden) {
      if (file.startsWith("adapters/transcripts/") && label === "runtime data directory") continue;
      assert.ok(!rule.test(file), `${file} looks like a ${label}`);
    }
  }
});

test("hygiene: nothing tracked is a symlink", async () => {
  const files: string[] = [];
  await walk(ROOT, files);
  for (const file of files) {
    const stat = await lstat(join(ROOT, file));
    assert.ok(!stat.isSymbolicLink(), `${file} is a symlink`);
  }
});
