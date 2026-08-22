#!/usr/bin/env python3
"""Regression tests for the narrow public-document scanner policy."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

SCANNER = Path(__file__).resolve().parent / "scan.py"
OWNER = "Gw" + "endolen"
CJK = chr(0x4E2D)
REAL_KEY = "sk-" + "A" * 32


def run_case(files: dict[str, str]) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="delos-public-doc-policy-") as tmp:
        root = Path(tmp)
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(SCANNER), "--root", str(root)],
            capture_output=True,
            text=True,
            check=False,
        )


def expect_pass(name: str, files: dict[str, str]) -> None:
    result = run_case(files)
    if result.returncode != 0:
        raise SystemExit(f"{name}: expected PASS\n{result.stdout}\n{result.stderr}")


def expect_fail(name: str, files: dict[str, str], needle: str) -> None:
    result = run_case(files)
    output = result.stdout + result.stderr
    if result.returncode == 0 or needle not in output:
        raise SystemExit(
            f"{name}: expected failure containing {needle!r}\n{output}"
        )


expect_pass(
    "Chinese README is an intentional public surface",
    {"README.zh-CN.md": CJK + " public documentation\nMaintained by " + OWNER + ".\n"},
)
expect_pass(
    "licensing document may carry public attribution",
    {"docs/LICENSING.md": "Licensor and maintainer: " + OWNER + ".\n"},
)
expect_fail(
    "Chinese remains forbidden outside the Chinese README",
    {"docs/notes.md": CJK + "\n"},
    "Chinese text",
)
expect_fail(
    "ordinary documentation does not gain attribution privileges",
    {"docs/notes.md": "Maintained by " + OWNER + ".\n"},
    "persona/owner name",
)
expect_fail(
    "Chinese README does not exempt secrets",
    {"README.zh-CN.md": CJK + "\napiKey = \"" + REAL_KEY + "\"\n"},
    "secret",
)
expect_fail(
    "Chinese README does not exempt owner-name namespaces",
    {"README.zh-CN.md": CJK + "\nconst " + OWNER.lower() + "Context = 1;\n"},
    "persona/owner name",
)

print("public document scanner policy: ok")
