#!/usr/bin/env python3
"""Run the mature adversarial scanner suite against the exact scanner core.

The public `scan.py` file is a thin repository-policy wrapper around
`scan-core.py`. The mature adversarial harness intentionally copies one
self-contained scanner into isolated temporary trees, so it must exercise the
self-contained core rather than the wrapper. Public-document policy is tested
separately by `scan-public-doc-policy-test.py`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITE_PATH = HERE / "scan-adversarial-test.py"
CORE_PATH = HERE / "scan-core.py"

spec = importlib.util.spec_from_file_location("delos_scan_adversarial_suite", SUITE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load adversarial suite: {SUITE_PATH}")

suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
suite.SCANNER = CORE_PATH

if __name__ == "__main__":
    raise SystemExit(suite.main())
