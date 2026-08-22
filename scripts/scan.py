#!/usr/bin/env python3
"""Public-document policy wrapper for the Delos release scanner.

The scanner core remains intentionally strict and reusable. This wrapper owns
only the repository-level publication policy that changes when the public
surface changes: current attribution documents and the two bilingual README
surfaces allowed to contain Chinese prose.

Secret, credential, path, host, symlink, and forbidden-path checks remain in
scan-core.py and are not weakened here.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

CORE_PATH = Path(__file__).resolve().with_name("scan-core.py")
SPEC = importlib.util.spec_from_file_location("delos_public_scan_core", CORE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load scanner core: {CORE_PATH}")

core = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core)

# Preserve the mature core's adversarial fixtures while adding the documents
# that are part of the current public product surface. The allowance is only
# for standalone PUBLIC authorship words; identifier/namespace forms, secrets,
# emails, paths, hosts, and other private markers remain blocked by the core.
core.ATTRIBUTION_PROSE = frozenset(core.ATTRIBUTION_PROSE) | frozenset({
    "README.zh-CN.md",
    "docs/LICENSING.md",
})

# Chinese prose is intentional only on the two README language surfaces: the
# English README carries the visible Chinese-language switch, while the Chinese
# README contains the translated prose. The core still sees every ASCII
# fragment of those lines, so secrets, emails, home paths, private hosts, and
# owner-name namespace forms continue to be scanned normally. Every other
# tracked file keeps the core CJK prohibition.
_ALLOWED_CJK_PROSE = frozenset({"README.md", "README.zh-CN.md"})
_core_read_lines = core.read_lines


def _normalise(path: str) -> str:
    value = Path(path).as_posix()
    return value[2:] if value.startswith("./") else value


def _policy_read_lines(path: str) -> list[str]:
    lines = _core_read_lines(path)
    if _normalise(path) in _ALLOWED_CJK_PROSE:
        return [core.CJK.sub(" ", line) for line in lines]
    return lines


core.read_lines = _policy_read_lines

if __name__ == "__main__":
    raise SystemExit(core.main())
