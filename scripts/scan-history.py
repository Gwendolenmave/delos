#!/usr/bin/env python3
"""Apply the current Public Delos release scanner to every reachable commit.

The publication workflow deliberately checks out a one-commit shallow history,
so the normal first-publication case scans exactly the commit that would seed
the empty public repository. Keeping this script commit-generic makes the gate
fail safely if more history is ever made reachable later.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURRENT_SCANNER = ROOT / "scripts" / "scan.py"


def run_git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> int:
    listed = run_git("rev-list", "--all")
    if listed.returncode != 0:
        print(listed.stderr.strip() or "unable to enumerate reachable commits", file=sys.stderr)
        return 2

    commits = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
    if not commits:
        print("HISTORY SCAN FAIL - no reachable commits")
        return 1
    if not CURRENT_SCANNER.is_file():
        print("HISTORY SCAN ERROR - current release scanner is missing", file=sys.stderr)
        return 2

    failures = 0
    with tempfile.TemporaryDirectory(prefix="public-delos-history-") as temp_root:
        temp_root_path = Path(temp_root)
        for index, commit in enumerate(commits, 1):
            checkout = temp_root_path / f"commit-{index}"
            added = run_git("worktree", "add", "--detach", "--force", str(checkout), commit)
            if added.returncode != 0:
                print(
                    added.stderr.strip() or f"unable to materialize commit {commit[:12]}",
                    file=sys.stderr,
                )
                return 2

            try:
                # Run the CURRENT scanner policy against the historical tree.
                # The copied scanner is intentionally untracked, so the tree
                # being inspected remains byte-for-byte the commit under test.
                scanner_copy = checkout / "scripts" / "_publication_scan_current.py"
                scanner_copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(CURRENT_SCANNER, scanner_copy)
                scanned = subprocess.run(
                    [sys.executable, str(scanner_copy)],
                    cwd=checkout,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                print(f"--- commit {commit[:12]} ---")
                if scanned.stdout:
                    print(scanned.stdout, end="" if scanned.stdout.endswith("\n") else "\n")
                if scanned.stderr:
                    print(scanned.stderr, file=sys.stderr, end="" if scanned.stderr.endswith("\n") else "\n")
                if scanned.returncode != 0:
                    failures += 1
            finally:
                removed = run_git("worktree", "remove", "--force", str(checkout))
                if removed.returncode != 0:
                    print(
                        removed.stderr.strip() or f"unable to remove temporary worktree for {commit[:12]}",
                        file=sys.stderr,
                    )
                    return 2

    if failures:
        print(f"HISTORY SCAN FAIL - {failures} of {len(commits)} commit(s) failed")
        return 1

    print(f"HISTORY SCAN PASS - {len(commits)} commit(s) scanned with current policy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
