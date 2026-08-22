/**
 * prompt-loader - synthetic tests.
 *
 * Every fixture is written into a fresh temporary directory with invented
 * English content. Nothing reads the persona shipped in this repository: a
 * test that depends on the default persona would start failing the moment a
 * user does the thing the product exists to let them do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp, mkdir, writeFile, symlink, rm, chmod, readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPromptBundle,
  PromptLoadError,
  DEFAULT_SECTION_ORDER,
} from "../adapters/identity/filesystem/prompt-loader.js";
import { assembleSystemPrompt } from "../core/services/system-prompt.js";
import type { PromptBundle } from "../core/domain/types.js";

async function makeRoot(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "delos-prompt-test-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, "utf8");
  }
  return root;
}

const THREE_DEFAULTS = {
  "identity.md": "You are a test assistant.\n",
  "relationship.md": "You and the user are collaborators.\n",
  "response-style.md": "Be clear and direct.\n",
};

async function expectFailure(
  fn: () => Promise<unknown>,
  kind: string,
): Promise<PromptLoadError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof PromptLoadError, `expected PromptLoadError, got ${error}`);
    assert.equal(error.kind, kind);
    return error;
  }
  throw new Error(`expected a ${kind} failure, but the call succeeded`);
}

test("the three default sections load in their fixed order", async () => {
  // Written in reverse so a loader that trusted enumeration order would fail.
  const root = await makeRoot();
  await writeFile(join(root, "response-style.md"), "Style.\n", "utf8");
  await writeFile(join(root, "relationship.md"), "Relationship.\n", "utf8");
  await writeFile(join(root, "identity.md"), "Identity.\n", "utf8");

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(
    bundle.sections.map((s) => s.name),
    [...DEFAULT_SECTION_ORDER],
  );
  await rm(root, { recursive: true, force: true });
});

test("custom sections follow the defaults, sorted by name", async () => {
  const root = await makeRoot({
    ...THREE_DEFAULTS,
    "zebra.md": "Zebra section.\n",
    "alpha.md": "Alpha section.\n",
    "middle.md": "Middle section.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(
    bundle.sections.map((s) => s.name),
    ["identity", "relationship", "response-style", "alpha", "middle", "zebra"],
  );
  await rm(root, { recursive: true, force: true });
});

test("a prompt root outside the repository works", async () => {
  // The root is a fresh temp directory, which is by construction not in this
  // repository - a user may keep prompts anywhere.
  const root = await makeRoot(THREE_DEFAULTS);
  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.equal(bundle.sections.length, 3);
  await rm(root, { recursive: true, force: true });
});

test("a missing default section is allowed, not fatal", async () => {
  const root = await makeRoot({
    "identity.md": "Identity.\n",
    "response-style.md": "Style.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(
    bundle.sections.map((s) => s.name),
    ["identity", "response-style"],
  );
  await rm(root, { recursive: true, force: true });
});

test("a persona built entirely from custom sections works", async () => {
  // The product's claim is that the user may replace the structure, not just
  // the words. A loader that required the defaults would make that false.
  const root = await makeRoot({
    "voice.md": "Voice.\n",
    "boundaries.md": "Boundaries.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(bundle.sections.map((s) => s.name), ["boundaries", "voice"]);
  await rm(root, { recursive: true, force: true });
});

test("a missing prompt root is a typed failure", async () => {
  const root = await makeRoot();
  const missing = join(root, "does-not-exist");
  await expectFailure(
    () => loadPromptBundle({ promptRoot: missing }),
    "prompt_root_missing",
  );
  await rm(root, { recursive: true, force: true });
});

test("a prompt root that is a file is a typed failure", async () => {
  const root = await makeRoot({ "identity.md": "Identity.\n" });
  await expectFailure(
    () => loadPromptBundle({ promptRoot: join(root, "identity.md") }),
    "prompt_root_not_a_directory",
  );
  await rm(root, { recursive: true, force: true });
});

test("a root with no Markdown files is a typed failure", async () => {
  const root = await makeRoot({ "notes.txt": "not markdown\n" });
  await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "no_prompt_files",
  );
  await rm(root, { recursive: true, force: true });
});

test("an empty file is a typed failure naming its relative path", async () => {
  const root = await makeRoot({ ...THREE_DEFAULTS, "blank.md": "" });
  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "empty_file",
  );
  assert.equal(error.path, "blank.md");
  await rm(root, { recursive: true, force: true });
});

test("a whitespace-only file is a typed failure, not a silent skip", async () => {
  // Silently dropping it would delete part of the persona without saying so.
  const root = await makeRoot({ ...THREE_DEFAULTS, "spaces.md": "   \n\n\t\n" });
  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "empty_file",
  );
  assert.equal(error.path, "spaces.md");
  await rm(root, { recursive: true, force: true });
});

test("invalid UTF-8 is a typed failure, not replacement characters", async () => {
  const root = await makeRoot(THREE_DEFAULTS);
  await writeFile(join(root, "broken.md"), Buffer.from([0xff, 0xfe, 0x41]));
  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "invalid_utf8",
  );
  assert.equal(error.path, "broken.md");
  await rm(root, { recursive: true, force: true });
});

test("non-Markdown files, hidden files, backups and subdirectories are ignored", async () => {
  const root = await makeRoot({
    ...THREE_DEFAULTS,
    "notes.txt": "ignored\n",
    ".hidden.md": "ignored\n",
    "draft.md~": "ignored\n",
    "scratch.md.tmp": "ignored\n",
    "old.md.bak": "ignored\n",
  });
  await mkdir(join(root, "archive"));
  await writeFile(join(root, "archive", "old-identity.md"), "ignored\n", "utf8");

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(bundle.sections.map((s) => s.name), [...DEFAULT_SECTION_ORDER]);
  await rm(root, { recursive: true, force: true });
});

test("symbolic links are not followed", async () => {
  const outside = await makeRoot({ "secret.md": "Content from outside the root.\n" });
  const root = await makeRoot(THREE_DEFAULTS);
  await symlink(join(outside, "secret.md"), join(root, "linked.md"));

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(bundle.sections.map((s) => s.name), [...DEFAULT_SECTION_ORDER]);
  assert.ok(!bundle.sections.some((s) => s.content.includes("outside the root")));
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("content is preserved verbatim: not trimmed, rewrapped, or titled", async () => {
  const raw = "\n\n  Leading blanks and spaces.\r\n\nTrailing lines follow.\n\n\n";
  const root = await makeRoot({ "identity.md": raw });

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.equal(bundle.sections[0]?.content, raw);
  await rm(root, { recursive: true, force: true });
});

test("sha256 is taken over the actual file bytes", async () => {
  const raw = "Exact bytes matter.\n";
  const root = await makeRoot({ "identity.md": raw });

  const bundle = await loadPromptBundle({ promptRoot: root });
  const expected = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
  assert.equal(bundle.sections[0]?.sha256, expected);
  await rm(root, { recursive: true, force: true });
});

test("a byte-order mark is stripped from content but still covered by sha256", async () => {
  const body = "Identity without a visible mark.\n";
  const withBom = "﻿" + body;
  const root = await makeRoot({ "identity.md": withBom });

  const bundle = await loadPromptBundle({ promptRoot: root });
  const section = bundle.sections[0];
  assert.ok(section);
  // The mark would otherwise be an invisible first character of the prompt.
  assert.equal(section.content, body);
  assert.ok(!section.content.startsWith("﻿"));
  // The digest still identifies the file as it exists on disk.
  assert.equal(
    section.sha256,
    createHash("sha256").update(Buffer.from(withBom, "utf8")).digest("hex"),
  );
  await rm(root, { recursive: true, force: true });
});

test("section paths are plain file names, identical on any platform", async () => {
  const root = await makeRoot(THREE_DEFAULTS);
  const bundle = await loadPromptBundle({ promptRoot: root });

  for (const section of bundle.sections) {
    assert.equal(section.path, `${section.name}.md`);
    assert.ok(!section.path.includes("/"), "path must not contain a separator");
    assert.ok(!section.path.includes("\\"), "path must not contain a separator");
  }
  await rm(root, { recursive: true, force: true });
});

test("the loader carries no persona name in its output", async () => {
  // The persona is content. If a name is required for the loader to work, the
  // user cannot really replace it.
  const root = await makeRoot({
    "identity.md": "You are a test assistant.\n",
    "custom.md": "A custom section.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  const serialised = JSON.stringify(bundle);

  // Assembled from fragments so this test file contains no persona name of
  // its own - the same rule the loader is being checked against.
  const short = "Ar" + "ti";
  const long = "Artem" + "is";
  for (const forbidden of [short, long, short.toLowerCase(), long.toLowerCase()]) {
    assert.ok(
      !serialised.includes(forbidden),
      `loader output mentions ${forbidden}`,
    );
  }
  await rm(root, { recursive: true, force: true });
});

// --- duplicate logical section names ---------------------------------------

test("two files differing only by extension case are a typed failure", async () => {
  // Silently keeping one would make the persona depend on enumeration order,
  // and the loser would vanish without a word.
  const root = await makeRoot();
  await writeFile(join(root, "identity.md"), "First.\n", "utf8");
  await writeFile(join(root, "identity.MD"), "Second.\n", "utf8");

  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "duplicate_section",
  );
  assert.deepEqual(error.paths, ["identity.MD", "identity.md"]);
  await rm(root, { recursive: true, force: true });
});

test("two custom files differing only by name case are a typed failure", async () => {
  const root = await makeRoot();
  await writeFile(join(root, "custom.md"), "First.\n", "utf8");
  await writeFile(join(root, "CUSTOM.MD"), "Second.\n", "utf8");

  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "duplicate_section",
  );
  assert.deepEqual(error.paths, ["CUSTOM.MD", "custom.md"]);
  await rm(root, { recursive: true, force: true });
});

test("Unicode composed and decomposed names collide as one section", async () => {
  // The same word, spelled two ways: macOS and Linux disagree about which
  // lands on disk, so a user would call these the same section.
  const composed = String.fromCodePoint(0x00e9); // e-acute, one code point
  const decomposed = "e" + String.fromCodePoint(0x0301); // e + combining acute
  const root = await makeRoot();
  await writeFile(join(root, `caf${composed}.md`), "First.\n", "utf8");
  try {
    await writeFile(join(root, `caf${decomposed}.md`), "Second.\n", "utf8");
  } catch {
    await rm(root, { recursive: true, force: true });
    return; // filesystem normalised them into one file; nothing to collide
  }

  const error = await expectFailure(
    () => loadPromptBundle({ promptRoot: root }),
    "duplicate_section",
  );
  assert.equal(error.paths?.length, 2);
  await rm(root, { recursive: true, force: true });
});

test("the duplicate verdict does not depend on which file was written first", async () => {
  const rootA = await makeRoot();
  await writeFile(join(rootA, "notes.md"), "A.\n", "utf8");
  await writeFile(join(rootA, "NOTES.md"), "B.\n", "utf8");

  const rootB = await makeRoot();
  await writeFile(join(rootB, "NOTES.md"), "B.\n", "utf8");
  await writeFile(join(rootB, "notes.md"), "A.\n", "utf8");

  const a = await expectFailure(
    () => loadPromptBundle({ promptRoot: rootA }),
    "duplicate_section",
  );
  const b = await expectFailure(
    () => loadPromptBundle({ promptRoot: rootB }),
    "duplicate_section",
  );
  assert.deepEqual(a.paths, b.paths, "same conclusion regardless of order");
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

test("a default section is matched case-insensitively", async () => {
  // Windows, macOS and Linux must agree about what counts as `identity`.
  const root = await makeRoot({
    "IDENTITY.md": "Identity.\n",
    "custom.md": "Custom.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  assert.deepEqual(bundle.sections.map((s) => s.name), ["IDENTITY", "custom"]);
  await rm(root, { recursive: true, force: true });
});

// --- prompt-root failures ---------------------------------------------------

test("an unreadable prompt root is distinguished from a missing one", async () => {
  const root = await makeRoot({ "identity.md": "Identity.\n" });
  const sealed = join(root, "sealed");
  await mkdir(sealed);
  await writeFile(join(sealed, "identity.md"), "Identity.\n", "utf8");
  await chmod(sealed, 0o000);

  try {
    // Running as root defeats permission bits; skip rather than assert a lie.
    const probe = await readdir(sealed).then(() => true).catch(() => false);
    if (!probe) {
      await expectFailure(
        () => loadPromptBundle({ promptRoot: sealed }),
        "prompt_root_unreadable",
      );
    }
  } finally {
    await chmod(sealed, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked prompt root is resolved, by contract", async () => {
  // The root is configuration the user chose explicitly; its CONTENTS are not.
  const real = await makeRoot(THREE_DEFAULTS);
  const parent = await makeRoot();
  const link = join(parent, "prompts-link");
  await symlink(real, link);

  const bundle = await loadPromptBundle({ promptRoot: link });
  assert.deepEqual(bundle.sections.map((s) => s.name), [...DEFAULT_SECTION_ORDER]);
  await rm(real, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
});

// --- source-agnostic core ---------------------------------------------------

test("the adapter carries filesystem provenance that core does not require", async () => {
  const root = await makeRoot(THREE_DEFAULTS);
  const bundle = await loadPromptBundle({ promptRoot: root });

  // The adapter's own type has `path`...
  assert.equal(bundle.sections[0]?.path, "identity.md");
  // ...and the core shape a consumer sees needs only these three fields.
  const core: PromptBundle = bundle;
  for (const section of core.sections) {
    assert.equal(typeof section.name, "string");
    assert.equal(typeof section.sha256, "string");
    assert.equal(typeof section.content, "string");
  }
  await rm(root, { recursive: true, force: true });
});

test("assembleSystemPrompt works on a bundle with no filesystem origin", async () => {
  // Proves core does not require a path: this bundle never touched a disk.
  const bundle: PromptBundle = {
    sections: [
      { name: "identity", sha256: "0".repeat(64), content: "Identity body.\n" },
      { name: "style", sha256: "1".repeat(64), content: "Style body.\n" },
    ],
  };
  assert.equal(assembleSystemPrompt(bundle), "Identity body.\n\nStyle body.");
});

test("assembleSystemPrompt joins sections in order with no delimiter protocol", async () => {
  const root = await makeRoot({
    "identity.md": "Identity body.\n",
    "response-style.md": "Style body.\n",
  });

  const bundle = await loadPromptBundle({ promptRoot: root });
  const assembled = assembleSystemPrompt(bundle);

  assert.equal(assembled, "Identity body.\n\nStyle body.");
  assert.ok(!assembled.includes("==="), "no banner or delimiter protocol");
  await rm(root, { recursive: true, force: true });
});
