#!/usr/bin/env python3
"""End-to-end adversarial tests for scripts/scan.py.

Why this exists
---------------
The scanner's built-in self-test checks its PREDICATES in isolation. Two real
bypasses still shipped, because both were CONTROL-FLOW bugs that no predicate
test could see:

  * a `scan-allow-persona` marker skipped the whole line, so it also hid a
    real secret sitting on that line;
  * a line containing the word "example" disabled secret detection for the
    whole line, so `const exampleApiKey = "sk-..."` passed.

Each case below builds a synthetic file tree, runs the scanner against it as a
subprocess, and asserts the verdict. Every case is an attack that previously
succeeded or a legitimate pattern that must not be rejected.

Run:  python3 scripts/scan-adversarial-test.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCANNER = Path(__file__).resolve().parent / "scan.py"

REAL_KEY = "sk-" + "A" * 32
MARKER = "scan-allow-persona"

# Probe strings are ASSEMBLED rather than written as literals, so this file
# contains no real home path, no email address, and no persona name of its own.
# The alternative - exempting this file - would mean the repository genuinely
# held the patterns it forbids, protected only by an exception. Composing them
# keeps the repository clean under its own rules, which is the stronger
# property and needs no exception machinery.
HOME_PATH = "/ho" + "me/someone/pkg"
EMAIL = "someone@" + "example.org"
PERSONA_NAMESPACE = "Artem" + "isProfile"
DEFAULT_PERSONA = "Ar" + "ti"
PRIVATE_NAME = "Am" + "elia"
OWNER_NAME = "Gw" + "en"
OWNER_FULL_NAME = OWNER_NAME + "dolen"
HANDLE = OWNER_FULL_NAME + "mave"
PERSONA_MYTH = "Artem" + "is"
# The owner-approved authorship byline carried by the Design Notes.
CREDIT_LINE = OWNER_FULL_NAME + " & " + PRIVATE_NAME
URL_WITH_USERINFO = "https://user:" + "s3cr3t" + "token@" + "registry.example/"

# name -> (files, expect_pass, must_appear_in_output)
Case = tuple[dict[str, str], bool, list[str]]

CASES: dict[str, Case] = {
    "clean tree passes": (
        {"src/app.ts": 'export const greeting = "hello";\n'},
        True,
        [],
    ),
    "persona marker must not hide a secret": (
        {"src/a.ts": f'const assistantProfile = "{REAL_KEY}"; // {MARKER}\n'},
        False,
        ["secret"],
    ),
    "persona marker hides only the persona finding": (
        {"src/b.ts": f'const {PRIVATE_NAME.lower()}Profile = true; // {MARKER}\n'},
        True,
        [],
    ),
    "the word example must not hide a real key": (
        {"src/c.ts": f'const exampleApiKey = "{REAL_KEY}";\n'},
        False,
        ["secret"],
    ),
    "a genuine placeholder value is allowed": (
        {".env.example": "OPENAI_API_KEY=<your-api-key>\n"},
        True,
        [],
    ),
    "dot-env-example path is allowed": (
        {".env.example": "OPENAI_API_KEY=<your-api-key>\n"},
        True,
        [],
    ),
    "a real key inside dot-env-example still fails": (
        {".env.example": f"OPENAI_API_KEY={REAL_KEY}\n"},
        False,
        ["secret"],
    ),
    "dot-env path fails": (
        {".env": "SOMETHING=1\n"},
        False,
        ["forbidden"],
    ),
    "dot-env-local path fails": (
        {".env.local": "SOMETHING=1\n"},
        False,
        ["forbidden"],
    ),
    "a secret in a lockfile fails": (
        {"package-lock.json": '{"token": "' + REAL_KEY + '"}\n'},
        False,
        ["secret"],
    ),
    "a home path in a lockfile fails": (
        {"package-lock.json": '{"resolved": "file://' + HOME_PATH + '"}\n'},
        False,
        ["home path"],
    ),
    "run-together private name fails": (
        {"src/d.ts": f"const {PRIVATE_NAME.upper()}PROFILE = true;\n"},
        False,
        ["persona"],
    ),
    "digit-separated private name fails": (
        {"src/e.ts": f"const {PRIVATE_NAME.lower()}2Profile = true;\n"},
        False,
        ["persona"],
    ),
    "suffix private name fails": (
        {"src/f.ts": f"const PROFILE{PRIVATE_NAME.upper()} = true;\n"},
        False,
        ["persona"],
    ),
    "run-together owner name fails": (
        {"src/g.ts": f"const {OWNER_NAME.upper()}CONTEXT = true;\n"},
        False,
        ["persona"],
    ),
    "default persona as a namespace in prose fails": (
        {"docs/notes.md": "We will call the module " + PERSONA_NAMESPACE + ".\n"},
        False,
        ["persona"],
    ),
    "default persona in the shipped prompts is allowed": (
        {"prompts/identity.md": "You are " + DEFAULT_PERSONA + ", a lightweight assistant.\n"},
        True,
        [],
    ),
    "a private name in the shipped prompts still fails": (
        {"prompts/identity.md": "You are " + PRIVATE_NAME + ".\n"},
        False,
        ["persona"],
    ),
    # The Design Notes explain where the public names came from and cannot do
    # that without saying them. The allowance granted for that must not become
    # a hole the private names can walk through.
    "public mythology names are allowed in the design notes": (
        {"docs/DESIGN-NOTES.md":
            "Apollo and " + PERSONA_MYTH + " are twins. "
            + DEFAULT_PERSONA + " is the default guest.\n"},
        True,
        [],
    ),
    # Authorship names are PUBLIC by owner ruling, but only as standalone words
    # and only in the four attribution documents. Every case below that expects
    # a failure is an attack on that allowance.
    "the authorship byline is allowed in the design notes": (
        {"docs/DESIGN-NOTES.md": CREDIT_LINE + "\n"},
        True,
        [],
    ),
    "the licensor line is allowed in the licence notes": (
        {"LICENSE-NOTES.md":
            "Offered by **" + OWNER_FULL_NAME + "** (`@" + HANDLE + "` on GitHub).\n"},
        True,
        [],
    ),
    "the licensor line is allowed in the readme": (
        {"README.md":
            "The licensor and maintainer is **" + OWNER_FULL_NAME + "**.\n"},
        True,
        [],
    ),
    "the identity record is allowed in provenance": (
        {"docs/PROVENANCE.md":
            "Review credit to " + PRIVATE_NAME + " is retained by owner ruling.\n"},
        True,
        [],
    ),
    "the licensor line is allowed in the release notes": (
        {"RELEASE-NOTES-v0.1.md":
            "Licensor and maintainer: **" + OWNER_FULL_NAME + "** (`@" + HANDLE + "`).\n"},
        True,
        [],
    ),
    "an authorship namespace in the release notes still fails": (
        {"RELEASE-NOTES-v0.1.md": "see " + OWNER_NAME.lower() + "Context\n"},
        False,
        ["persona"],
    ),
    "an authorship name in any other document still fails": (
        {"docs/notes.md": CREDIT_LINE + "\n"},
        False,
        ["persona"],
    ),
    "an authorship name in the manifest still fails": (
        {"MANIFEST-v0.1.md": "Maintained by " + OWNER_FULL_NAME + ".\n"},
        False,
        ["persona"],
    ),
    "an authorship name in the shipped prompts still fails": (
        {"prompts/identity.md": "You were written by " + OWNER_FULL_NAME + ".\n"},
        False,
        ["persona"],
    ),
    "an authorship namespace in an attribution document still fails": (
        {"docs/DESIGN-NOTES.md": "See " + PRIVATE_NAME.lower() + "Profile for details.\n"},
        False,
        ["persona"],
    ),
    "an owner-name namespace in an attribution document still fails": (
        {"README.md": "const " + OWNER_NAME.lower() + "Context = load();\n"},
        False,
        ["persona"],
    ),
    "a run-together authorship name in an attribution document still fails": (
        {"docs/PROVENANCE.md": "field " + OWNER_FULL_NAME.upper() + "HOME is set\n"},
        False,
        ["persona"],
    ),
    "an authorship name in code is not rescued by any path rule": (
        {"src/profile.ts": "export const author = \"" + OWNER_FULL_NAME + "\";\n"},
        False,
        ["persona"],
    ),
    "the attribution allowance does not suppress a secret": (
        {"docs/DESIGN-NOTES.md": CREDIT_LINE + "\n\nkey = \"" + REAL_KEY + "\"\n"},
        False,
        ["secret"],
    ),
    "the attribution allowance does not suppress an email": (
        {"README.md": "Written by " + OWNER_FULL_NAME + ", reachable at " + EMAIL + "\n"},
        False,
        ["email"],
    ),
    "ordinary english words do not false-positive": (
        {
            "src/h.ts": (
                "const partial = 1; const article = 2; const particle = 3;\n"
                "const partition = 4; const martial = 5; const artisan = 6;\n"
                "const artifact = 7; const quartile = 8; const department = 9;\n"
            )
        },
        True,
        [],
    ),
    "chinese text fails even on a marked line": (
        {"src/i.ts": f"// {MARKER} " + chr(0x4E2D) + "\n"},
        False,
        ["Chinese"],
    ),
    "an email fails even on a marked line": (
        {"src/j.ts": f"// {MARKER} contact " + EMAIL + "\n"},
        False,
        ["email"],
    ),
    "a committed symlink fails": (
        {"src/k.ts": "export const x = 1;\n", "@symlink:src/link.ts": "app.ts"},
        False,
        ["symlink"],
    ),
    "a marker inside a string constant cannot hide a persona finding": (
        # Data must not be able to disable the check that guards it.
        {"src/l.ts": f'const note = "{MARKER}"; const {PRIVATE_NAME.lower()}X = 1;\n'},
        False,
        ["persona"],
    ),
    # --- Wave 7a: provider and secret surfaces -----------------------------
    "an openai-looking token in source fails": (
        {"src/p1.ts": 'const k = "sk-' + "proj" + "-" + "A" * 40 + '";\n'},
        False,
        ["secret"],
    ),
    "an anthropic-looking token in source fails": (
        {"src/p2.ts": 'const k = "sk-' + "ant-api03-" + "B" * 40 + '";\n'},
        False,
        ["secret"],
    ),
    "an arbitrary relay token assigned to a key-named constant fails": (
        {"src/p3.ts": 'const gatewayApiKey = "' + "zq" * 24 + '";\n'},
        False,
        ["secret"],
    ),
    "a bearer token inside an error fixture fails": (
        {"tests/p4.txt": "error: Authorization: Bearer " + "C" * 32 + "\n"},
        False,
        ["secret"],
    ),
    "a secret value inside a provider profile json fails": (
        {"profiles/p5.json": '{"id": "x", "apiKey": "sk-' + "D" * 32 + '"}\n'},
        False,
        ["secret"],
    ),
    "a custom auth header value in a snapshot fails": (
        {"tests/p6.snap": 'x-gateway-auth: "' + "E" * 40 + '"\n'},
        False,
        ["secret"],
    ),
    "an environment dump with a key-named variable fails": (
        {"logs-fixture/p7.txt": "OPENAI_API_KEY=sk-" + "F" * 32 + "\n"},
        False,
        ["secret"],
    ),
    "a proxy url containing credentials fails": (
        {"src/p8.ts": 'const proxy = "http://user:' + "p4ss" + '@127.0.0.1:8080";\n'},
        False,
        ["credentials in url"],
    ),
    "a secret reference is configuration, not a secret": (
        # The profile design's core property: references are safe to commit.
        {"profiles/p9.json":
            '{"auth": {"secretId": "provider:my-relay"}, "e": "env:MY_TOKEN"}\n'},
        True,
        [],
    ),
    "a reference-shaped prefix does not launder a real key": (
        {"src/p10.ts": 'const k = "provider:sk-' + "G" * 32 + '";\n'},
        False,
        ["secret"],
    ),
    # --- Wave 7 Phase 2: persona packs ---------------------------------------
    "the public persona name is allowed inside a pack": (
        {"personas/example/persona.json":
            '{"id": "example", "displayName": "' + DEFAULT_PERSONA + '"}',
         "personas/example/base/identity.md": "You are " + DEFAULT_PERSONA + ".\n"},
        True,
        [],
    ),
    "a secret inside a persona pack fails": (
        {"personas/example/base/identity.md": 'key = "sk-' + "H" * 32 + '"\n'},
        False,
        ["secret"],
    ),
    "a private name inside a pack variant fails": (
        {"personas/example/variants/warm.md": "Speak like " + PRIVATE_NAME + " would.\n"},
        False,
        ["persona"],
    ),
    "a real email inside pack metadata fails": (
        {"personas/example/persona.json": '{"author": "' + EMAIL + '"}'},
        False,
        ["email"],
    ),
    "the pack allowance does not extend to a personas-like path elsewhere": (
        {"docs/personas/example/identity.md": "You are " + DEFAULT_PERSONA + ".\n"},
        False,
        ["persona"],
    ),
    "a loopback model endpoint is legitimate configuration": (
        {
            "src/m.ts": (
                'export const endpoints = ["http://localhost:11434/v1/",\n'
                '  "http://127.0.0.1:8080/v1/", "http://[::1]:11434/v1/"];\n'
            )
        },
        True,
        [],
    ),
    "credentials embedded in a url fail": (
        {"src/n.ts": 'const registry = "' + URL_WITH_USERINFO + '";\n'},
        False,
        ["credentials in url"],
    ),
    "a bare env-style secret fails": (
        {".env.example": "SOME_API_KEY=" + "Zk9" + "qP" * 12 + "\n"},
        False,
        ["secret"],
    ),
    "an identifier whose type name contains 'token' is not a secret": (
        # `token` is an ordinary domain word in an LLM runtime. Flagging this
        # shape would make the category noise, and noisy checks get ignored.
        {
            "src/o.ts": (
                "export type TokenEstimator = (text: string) => number;\n"
                "export function estimate(text: string,\n"
                "  estimator: TokenEstimator = defaultTokenEstimator) {\n"
                "  return estimator(text);\n}\n"
            )
        },
        True,
        [],
    ),
}


def build(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        if rel.startswith("@symlink:"):
            link = root / rel[len("@symlink:"):]
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(content)
            continue
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def run_scanner(root: Path) -> tuple[int, str]:
    scripts = root / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    shutil.copy(SCANNER, scripts / "scan.py")
    proc = subprocess.run(
        [sys.executable, "scripts/scan.py"],
        cwd=root, capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def git_init(root: Path) -> bool:
    env_ok = subprocess.run(["git", "init", "-q"], cwd=root,
                            capture_output=True).returncode == 0
    if not env_ok:
        return False
    subprocess.run(["git", "add", "-A", "-f"], cwd=root, capture_output=True)
    return True


def main() -> int:
    failures: list[str] = []
    for name, (files, expect_pass, must_appear) in CASES.items():
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build(root, files)

            rc_walk, out_walk = run_scanner(root)
            if rc_walk == 2:
                failures.append(f"{name}: scanner reported itself broken\n{out_walk}")
                continue

            passed = rc_walk == 0
            if passed != expect_pass:
                failures.append(
                    f"{name}: expected {'PASS' if expect_pass else 'FAIL'}, "
                    f"got {'PASS' if passed else 'FAIL'}\n{out_walk}"
                )
                continue
            for needle in must_appear:
                if needle.lower() not in out_walk.lower():
                    failures.append(
                        f"{name}: output never mentions {needle!r}\n{out_walk}"
                    )

            # Git mode must reach the same verdict as walk mode.
            if git_init(root):
                rc_git, out_git = run_scanner(root)
                if (rc_git == 0) != (rc_walk == 0):
                    failures.append(
                        f"{name}: git mode and walk mode disagree "
                        f"(git rc={rc_git}, walk rc={rc_walk})\n{out_git}"
                    )

        status = "ok" if not any(f.startswith(name) for f in failures) else "FAIL"
        print(f"  [{status}] {name}")

    print()
    if failures:
        print(f"ADVERSARIAL TESTS FAILED - {len(failures)} case(s)\n")
        for f in failures:
            print(f"--- {f}\n")
        return 1
    print(f"ADVERSARIAL TESTS PASS - {len(CASES)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
