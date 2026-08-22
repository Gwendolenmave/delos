#!/usr/bin/env python3
"""Public Delos release scanner.

Reports four categories before anything is published:

  1. forbidden tracked paths
  2. committed symlinks
  3. known private markers (persona and owner names, home paths, emails,
     private hosts, Chinese text)
  4. secret-like content

Usage:
    scripts/scan.py [path ...]      # defaults to every tracked file

Exit codes: 0 pass, 1 findings, 2 the scanner itself is broken.

Design rules, each of which exists because its absence produced a real bypass
------------------------------------------------------------------------------
* **Exemptions are per line AND per category.** A marker that suppresses a
  persona finding must not also suppress a secret on the same line. A single
  `continue` over a line is how `const ameliaProfile = "sk-..."  // marker`  # scan-allow-persona
  passed.
* **Placeholder judgement applies to the matched VALUE, never the line.**
  A line containing the word "example" does not make a real key on that line
  safe. `const exampleApiKey = "sk-AAAA..."` must fail.
* **No file is skipped wholesale.** Lockfiles are noisy for names, so persona
  checks are relaxed there - but credentials, home paths, emails and private
  hosts are still scanned.
* **Matcher self-tests are not enough.** They test predicates in isolation and
  therefore missed both bypasses above, which were control-flow bugs. See
  `scripts/scan-adversarial-test.py`, which runs this scanner against synthetic
  fixture trees and asserts pass/fail end to end.

This is a pre-flight check, not a guarantee. An independent release-grade
secret scan is still required before the first push to a public remote.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------

# The project's authorship names.
#
# These are PUBLIC by owner ruling: the licensor and maintainer is named in the
# licence notes and the README, and the Design Notes carry a two-name byline.
# What the scanner still enforces is §1 of the manifest - an authorship name may
# never become a namespace. So they are permitted as STANDALONE WORDS in the
# attribution documents listed below, and refused everywhere else and in every
# identifier form.
#
# Long enough that case-insensitive containment inside an identifier is safe:
# no ordinary English or code word contains them. Containment catches every
# form - AMELIAPROFILE, amelia2Profile, PROFILEAMELIA, GWENCONTEXT.  # scan-allow-persona
PRIVATE_CONTAINMENT = ("amelia", "gwendolen", "gwen")  # scan-allow-persona
PERSONA_CONTAINMENT = ("artemis",)  # scan-allow-persona

# Too short for containment: it is a substring of Partial, article, particle,
# partition, martial, artisan, artifact. Matched structurally instead, by
# splitting identifiers into words. KNOWN LIMIT: a run-together all-caps form
# such as ARTIPROFILE is NOT caught. The manifest states this limit rather
# than promising coverage the scanner does not have.
PERSONA_STRUCTURAL = ("arti",)  # scan-allow-persona

ALLOW_MARKER = "scan-allow-persona"

_COMMENT_OPENERS = ("//", "#", "<!--", "/*", ";;")


def marker_allows(line: str) -> bool:
    """True when the line carries the marker AS A COMMENT.

    A bare substring test would let a STRING CONSTANT containing the marker
    exempt its own line - so data could disable the check that guards it. The
    marker only counts when it sits after a comment opener and outside any
    quoted region.
    """
    idx = line.find(ALLOW_MARKER)
    if idx < 0:
        return False
    before = line[:idx]

    # An open HTML comment is unambiguous. Check it before the quote heuristic
    # below, because English prose is full of apostrophes ("one name's form")
    # and quote-parity would wrongly reject a perfectly good marker.
    opened = before.rfind("<!--")
    if opened >= 0 and "-->" not in before[opened:]:
        return True

    # Otherwise: unbalanced quotes before the marker mean it sits inside a
    # string literal, and data must not be able to exempt itself.
    for quote in ('"', "'", "`"):
        if before.count(quote) % 2 == 1:
            return False
    return any(opener in before for opener in _COMMENT_OPENERS)

CODE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sh",
                 ".py", ".yml", ".yaml"}
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"}

# Only these paths may contain the default persona's name and the public
# mythology names freely: the shipped persona content, which is what those
# files are for, and the Design Notes, which exist to explain where the names
# came from and cannot do that without saying them. Private names and secrets
# are still forbidden in both.
# Persona packs are shipped persona content too: the default persona and the
# public mythology names may appear throughout a pack under personas/. The
# allowance covers ONLY that name category - private names, secrets, emails,
# home paths and CJK text are still reported inside packs, and the
# adversarial suite attacks exactly that seam.
DEFAULT_PERSONA_PROSE = re.compile(
    r"^(?:prompts/[^/]+\.md|docs/DESIGN-NOTES\.md"
    r"|personas/[a-z0-9-]+/[A-Za-z0-9._/-]+\.(?:md|json))$"
)

# The attribution documents: the four files whose job includes saying who wrote
# and licenses this project. Authorship names may appear here as STANDALONE
# WORDS only.
#
# This replaced an exact-single-line allowance for the Design Notes byline. That
# allowance existed because the names were then classified as private; the owner
# has since ruled them public authorship, so the basis changed rather than an
# exception being widened. What did NOT change is the identifier rule: see
# below.
ATTRIBUTION_PROSE = frozenset({
    "README.md",
    "LICENSE-NOTES.md",
    "RELEASE-NOTES-v0.1.md",
    "docs/DESIGN-NOTES.md",
    "docs/PROVENANCE.md",
})

# Standalone occurrences only. `\b` means `ameliaProfile`, `GWENCONTEXT`,  # scan-allow-persona
# `gwendolenHome` and every other run-together identifier form still fails even  # scan-allow-persona
# inside an attribution document - the boundary simply is not there. The GitHub
# handle is listed first so it is consumed before the shorter name inside it.
AUTHOR_STANDALONE = re.compile(
    r"\b(?:gwendolenmave|gwendolen|gwen|amelia)\b",  # scan-allow-persona
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Identifier-aware splitting
# ---------------------------------------------------------------------------

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")
_BOUNDARY = re.compile(
    r"(?<=[a-z0-9])(?=[A-Z])"      # camelCase
    r"|(?<=[A-Z])(?=[A-Z][a-z])"   # ACRONYMWord
    r"|(?<=[A-Za-z])(?=[0-9])"     # letter -> digit
    r"|(?<=[0-9])(?=[A-Za-z])"     # digit -> letter
)


def words_in(text: str) -> list[str]:
    """Split text into lowercase words across separators and case/digit runs."""
    out: list[str] = []
    for chunk in _NON_ALNUM.split(text):
        if not chunk:
            continue
        for part in _BOUNDARY.split(chunk):
            if part:
                out.append(part.lower())
    return out


def find_names(text: str, containment: tuple[str, ...],
               structural: tuple[str, ...]) -> list[str]:
    """Return which forbidden names appear in `text`."""
    hits: list[str] = []
    low = text.lower()
    for name in containment:
        if name in low:
            hits.append(name)
    if structural:
        present = set(words_in(text))
        for name in structural:
            if name in present:
                hits.append(name)
    return sorted(set(hits))


# ---------------------------------------------------------------------------
# Secret-like content
# ---------------------------------------------------------------------------

SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("anthropic-style key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}")),
    ("openai-style key", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}")),
    ("github token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("google api key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}")),
    ("aws access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}")),
    ("telegram bot token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.")),
    ("bearer literal", re.compile(r"\bBearer\s+[A-Za-z0-9_\-.]{20,}")),
    # A key-named binding assigned a long quoted opaque value. Prefix-free on
    # purpose: relay tokens have no sk- shape, and rejecting only shaped
    # tokens trains people to believe unshaped ones are safe to commit. The
    # name must END in the credential word, so `tokenEstimate`, `keyOf` and
    # `secretId` (a reference, not a value) stay clean.
    ("key-named assignment", re.compile(
        r"(?i)\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|credential)\s*"
        r"[:=]\s*[\"'][A-Za-z0-9+/=_\-.]{16,}[\"']")),
    # An auth-header line carrying a long value: request/response dumps and
    # snapshots. Matches the header POSITION (start of line), so prose about
    # these headers stays clean.
    ("auth header value", re.compile(
        r"(?im)^\s*(?:authorization|x-api-key|api-key|proxy-authorization|"
        r"x-[a-z0-9-]*(?:auth|key|token)[a-z0-9-]*)\s*[:=]\s*"
        r"[\"']?[A-Za-z0-9+/=_\-.]{16,}")),
]

# Assignment forms, quoted or bare, so .env-style files are covered too. The
# VALUE is captured separately and judged on its own.
ASSIGNED_SECRET = re.compile(
    r"""(?ix)
    # (?<![A-Za-z]) rather than \b: an underscore IS a word character, so \b
    # never fires inside SOME_API_KEY - which is the commonest env var shape
    # there is. This gap was found by an adversarial case, not by reading.
    (?<![A-Za-z])
    (?:api[_\-]?key|secret|token|password|passwd|credential|access[_\-]?key)
    \w* \s* [:=] \s*
    (?: "(?P<dq>[^"]{8,})" | '(?P<sq>[^']{8,})' | (?P<bare>[A-Za-z0-9_\-./+=]{8,}) )
    """
)
# The bare branch is deliberately narrow. A looser class matched TYPE
# ANNOTATIONS - `SECRET_PATTERNS: list[tuple[str, ...]]` parsed as
# "secret" + ":" + a value - which is noise that trains people to ignore
# this category.

# A VALUE (never a line) that is obviously documentation rather than a secret.
# SHOUTING_KEY=value at the start of a line: the shape bare secrets actually
# take, in .env files and shell exports.
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=")

# ...but only in files where that shape means an assignment of a VALUE. A
# Python or TypeScript module constant looks identical - `ASSIGNED_SECRET =
# re.compile(...)` parses as SHOUTING_KEY=value - so restricting by file type
# is what separates configuration from code. Secrets written in code are
# quoted, and the quoted branches catch those everywhere.
ENV_LIKE_SUFFIXES = {".env", ".sh", ".bash", ".zsh", ".conf", ".cfg",
                     ".ini", ".properties", ".envrc"}


def is_env_like(path: str) -> bool:
    name = Path(path).name
    return (
        name.startswith(".env")
        or Path(path).suffix in ENV_LIKE_SUFFIXES
        or name in {"Dockerfile", "Makefile"}
    )

PLACEHOLDER_VALUE = re.compile(
    r"""(?ix)
    ^(?:
        <[^>]*>                              # <your-api-key>
      | \$\{?[A-Z_][A-Z0-9_]*\}?             # $OPENAI_API_KEY
      | (?:your|my|the)[_\-\s]?.*            # your-api-key
      | (?:x{4,}|\.{3,}|\*{4,})              # xxxx  ...  ****
      | (?:example|placeholder|changeme|redacted|dummy|sample|todo|none|null)
        [_\-a-z0-9]*
      # A secret REFERENCE, not a secret: the namespaced ids that provider
      # profiles and surface configs carry ("provider:openai",
      # "env:OPENAI_API_KEY", "telegram:bot"). The whole point of the
      # reference design is that these are safe to commit. Only the known
      # namespaces qualify - an arbitrary colon does not.
      | (?:provider|env|telegram):[A-Za-z0-9_.:\-]+
      # An environment variable NAME, not a value: config that stores which
      # variable to read ('tokenEnvVar: "DELOS_TELEGRAM_BOT_TOKEN"'). At
      # least one underscore is required, so an AWS-style all-caps key id
      # (AKIA..., no underscore) is still reported.
      | (?=[A-Z0-9]*_)[A-Z][A-Z0-9_]*
      )$
    """
)

PRIVATE_MARKER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("absolute home path", re.compile(
        r"(/home/[a-z][a-z0-9_\-]*|/Users/[A-Za-z][A-Za-z0-9_\-]*"
        r"|C:\\Users\\[A-Za-z][A-Za-z0-9_\-]*)")),
    ("email address", re.compile(
        r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    # The lookbehind stops FILENAMES matching: without it, the literal string
    # ".env.local" was reported as a private host.
    ("private host", re.compile(
        r"(?<![.\w])(?:[a-z0-9\-]+\.)*[a-z0-9\-]+\.(?:local|internal|lan)\b")),
    # Credentials embedded in a URL: the userinfo form, where a name and a
    # secret appear before the "@" of the authority component.
    #
    # NOT loopback. `localhost`, `127.0.0.1` and `::1` are the ordinary way to
    # point Delos at a locally running model and are a legitimate, documented
    # configuration - flagging them would train users to ignore this category,
    # or worse, to avoid the most private option available to them.
    ("credentials in url", re.compile(
        r"https?://[^/\s:@]+:[^/\s@]{4,}@")),
]

CJK = re.compile(r"[\u4e00-\u9fff]")


def mask(value: str) -> str:
    """Redact a match so a finding never reprints the secret itself."""
    if not value:
        return ""
    if len(value) <= 8:
        return value[0] + "*" * (len(value) - 1)
    return f"{value[:4]}...{value[-2:]} (len {len(value)})"


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ENV_EXAMPLE = re.compile(r"(^|/)\.env\.example$")

FORBIDDEN_PATHS = [
    (re.compile(r"(^|/)\.env$"), "environment file"),
    (re.compile(r"(^|/)\.env\.[A-Za-z0-9_\-]+$"), "environment file"),
    (re.compile(r"\.(db|sqlite|sqlite3)$"), "database"),
    (re.compile(r"(^|/)data/"), "runtime data directory"),
    (re.compile(r"(^|/)transcripts?/"), "transcript store"),
    (re.compile(r"(^|/)logs?/"), "log directory"),
    (re.compile(r"(^|/)secrets?/"), "secret directory"),
    (re.compile(r"\.(pem|key|p12|pfx|keystore)$"), "key material"),
    (re.compile(r"(^|/)id_(rsa|ed25519|ecdsa)"), "ssh private key"),
]


def path_is_forbidden(path: str) -> str | None:
    if ENV_EXAMPLE.search(path):
        return None  # documented template; its CONTENT is still scanned
    if path.startswith("adapters/transcripts/") or path.startswith("./adapters/transcripts/"):
        # SOURCE CODE for the transcript store, not a store. The rule below
        # exists to catch a committed transcript DATA directory; the .db
        # extension rule still applies inside this directory.
        for pattern, label in FORBIDDEN_PATHS:
            if label != "transcript store" and pattern.search(path):
                return label
        return None
    for pattern, label in FORBIDDEN_PATHS:
        if pattern.search(path):
            return label
    return None


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

NAME_POSITIVES = [
    "amelia", "Amelia", "AMELIA", "AMELIAPROFILE", "PROFILEAMELIA",  # scan-allow-persona
    "ameliaProfile", "currentAmeliaProfile", "defaultAmelia",  # scan-allow-persona
    "AmeliaProfile", "amelia_profile", "amelia-profile", "amelia2Profile",  # scan-allow-persona
    "gwen", "Gwen", "GWENCONTEXT", "gwenContext", "currentGwenState",  # scan-allow-persona
    "gwendolen", "Gwendolen", "gwendolenHome",  # scan-allow-persona
]
PERSONA_POSITIVES = [
    "artemis", "Artemis", "ARTEMIS", "artemisMode", "ArtemisProfile",  # scan-allow-persona
    "artemis2Mode", "ARTEMISPROFILE",  # scan-allow-persona
    "arti", "Arti", "artiProfile", "defaultArti", "arti_profile", "arti2Profile",  # scan-allow-persona
]
NAME_NEGATIVES = [
    "Partial", "partial", "article", "particle", "partition", "martial",
    "artisan", "artifact", "Cartesian", "quartile", "party", "chart", "start",
    "smartial", "department", "quarters",
]


def fail_hard(message: str) -> None:
    print(f"SCANNER BROKEN: {message}", file=sys.stderr)
    raise SystemExit(2)


def self_test() -> None:
    for probe in NAME_POSITIVES:
        if not find_names(probe, PRIVATE_CONTAINMENT, ()):
            fail_hard(f"missed private name in {probe!r}")
    for probe in PERSONA_POSITIVES:
        if not find_names(probe, PERSONA_CONTAINMENT, PERSONA_STRUCTURAL):
            fail_hard(f"missed persona name in {probe!r}")
    for probe in NAME_NEGATIVES:
        if find_names(probe, PRIVATE_CONTAINMENT + PERSONA_CONTAINMENT,
                      PERSONA_STRUCTURAL):
            fail_hard(f"false positive on {probe!r}")

    if not CJK.search(chr(0x4E2D)):
        fail_hard("CJK matcher dead")
    if CJK.search("plain ascii"):
        fail_hard("CJK false positive")

    real = "sk-" + "A" * 32
    if not any(p.search(real) for _, p in SECRET_PATTERNS):
        fail_hard("secret matcher dead")
    if real in mask(real):
        fail_hard("mask() leaks the value it masks")
    if PLACEHOLDER_VALUE.match(real):
        fail_hard("a real-shaped key was judged a placeholder")
    for ph in ("<your-api-key>", "$OPENAI_API_KEY", "your-api-key",
               "xxxxxxxx", "placeholder", "changeme",
               "telegram:bot", "DELOS_TELEGRAM_BOT_TOKEN"):
        if not PLACEHOLDER_VALUE.match(ph):
            fail_hard(f"placeholder {ph!r} not recognised")
    # The env-NAME branch must not swallow an AWS-style all-caps key id.
    if PLACEHOLDER_VALUE.match("AKIA" + "IOSFODNN7EXAMPLE"[:12]):
        fail_hard("an all-caps key id with no underscore was judged a placeholder")
    # The transcript-store SOURCE directory is legitimate; a transcript DATA
    # directory, and databases anywhere, stay forbidden.
    if path_is_forbidden("adapters/transcripts/sqlite-transcript-store.ts"):
        fail_hard("transcript store source code was treated as data")
    if not path_is_forbidden("adapters/transcripts/dump.db"):
        fail_hard("a database inside the adapter directory escaped")
    if not path_is_forbidden("transcripts/2026-01.json"):
        fail_hard("a transcript data directory escaped")

    # The marker must be a comment, never a string constant.
    if not marker_allows(f"// {ALLOW_MARKER}"):
        fail_hard("a genuine comment marker was not honoured")
    if not marker_allows(f"<!-- {ALLOW_MARKER} -->"):
        fail_hard("an html comment marker was not honoured")
    if marker_allows(f'const x = "{ALLOW_MARKER}";'):
        fail_hard("a marker inside a string literal was honoured")
    if marker_allows(f"{ALLOW_MARKER}"):
        fail_hard("a bare marker with no comment opener was honoured")

    # Loopback is a legitimate local-model configuration, not a leak.
    for ok_url in ("http://localhost:11434/v1/", "http://127.0.0.1:8080/v1/",
                   "http://[::1]:11434/v1/"):
        for label, pattern in PRIVATE_MARKER_PATTERNS:
            if pattern.search(ok_url):
                fail_hard(f"loopback URL {ok_url!r} flagged as {label}")

    if path_is_forbidden(".env.example") is not None:
        fail_hard(".env.example must be allowed")
    if path_is_forbidden(".env") is None:
        fail_hard(".env must be forbidden")
    if path_is_forbidden(".env.local") is None:
        fail_hard(".env.local must be forbidden")

    print("scanner self-test: ok")


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

SKIP_DIRS = {".git", "node_modules", "build", "dist", ".cache"}


def target_files() -> list[str]:
    """Files to scan; falls back to a walk outside a git checkout so a
    reviewer can run this on an extracted snapshot rather than trust a report."""
    proc = subprocess.run(["git", "ls-files"], capture_output=True, text=True)
    if proc.returncode == 0 and proc.stdout.strip():
        return [line for line in proc.stdout.splitlines() if line]
    print("  (not a git checkout - walking the directory instead)")
    out: list[str] = []
    for path in Path(".").rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file() or path.is_symlink():
            out.append(str(path))
    return sorted(out)


def read_lines(path: str) -> list[str]:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, UnicodeError):
        return []


def secrets_in(line: str, path: str = "") -> list[tuple[str, str]]:
    """Return (label, value) for every secret-shaped value on the line.

    Placeholder judgement is applied to the VALUE, never to the line.
    """
    out: list[tuple[str, str]] = []
    for label, pattern in SECRET_PATTERNS:
        for m in pattern.finditer(line):
            value = m.group(0)
            if not PLACEHOLDER_VALUE.match(value):
                out.append((label, value))
    env_style = is_env_like(path) and bool(ENV_ASSIGNMENT.match(line))
    for m in ASSIGNED_SECRET.finditer(line):
        value = m.group("dq") or m.group("sq") or m.group("bare") or ""
        # An UNQUOTED value is only treated as a secret in an env-style
        # assignment. In source code a bare value is an identifier, and
        # "token" is an ordinary domain word here - `estimator:
        # TokenEstimator = defaultTokenEstimator` is not a credential.
        # Secrets written in code are quoted, and the quoted branches above
        # still catch them.
        if m.group("bare") and not env_style:
            continue
        if value and not PLACEHOLDER_VALUE.match(value):
            if not any(value == v for _, v in out):
                out.append(("assigned secret literal", value))
    return out


class EmptyWalkError(Exception):
    """Raised when a scan would judge zero files or zero bytes.

    An empty input can only ever produce a vacuous PASS - which is exactly
    the defect this scanner once had, when `scan.py .` treated "." as a file
    name, read nothing, and blessed three phase gates with an empty-input
    PASS. A sweep that visited nothing is a harness failure, never a verdict.
    """


def walk_evidence(paths: list[str]) -> tuple[int, int]:
    """(files, bytes) actually visitable. Zero of either is a hard failure."""
    files = 0
    total = 0
    for f in paths:
        p = Path(f)
        if p.is_file() and not p.is_symlink():
            files += 1
            try:
                total += p.stat().st_size
            except OSError:
                pass
    if files == 0 or total == 0:
        raise EmptyWalkError(
            f"the scan input resolves to {files} readable file(s) and "
            f"{total} byte(s); refusing to judge an empty tree"
        )
    return files, total


def scan(paths: list[str]) -> int:
    findings = 0

    walked_files, walked_bytes = walk_evidence(paths)
    print(f"walk evidence: {walked_files} file(s), {walked_bytes} byte(s)")
    print()

    print("=== 1. forbidden tracked paths ===")
    hits = 0
    for f in paths:
        label = path_is_forbidden(f)
        if label:
            print(f"  {f}  [{label}]")
            hits += 1
    print("  clean" if hits == 0 else f"  {hits} finding(s)")
    findings += hits
    print()

    print("=== 2. committed symlinks ===")
    hits = 0
    for f in paths:
        if Path(f).is_symlink():
            print(f"  {f} -> {os.readlink(f)}")
            hits += 1
    print("  clean" if hits == 0 else f"  {hits} finding(s)")
    findings += hits
    print()

    print("=== 3. known private markers ===")
    hits = 0
    for f in paths:
        name = Path(f).name
        is_lockfile = name in LOCKFILES
        is_code = Path(f).suffix in CODE_SUFFIXES and not is_lockfile
        persona_ok_here = bool(DEFAULT_PERSONA_PROSE.match(f))

        for n, line in enumerate(read_lines(f), start=1):
            marked = marker_allows(line)

            # -- persona and owner names -------------------------------------
            # Lockfiles skip name checks only: dependency names are noise.
            if not is_lockfile and not marked:
                # In an attribution document, remove STANDALONE authorship words
                # and check what is left. An identifier form survives this,
                # because it has no word boundary, and is still reported. The
                # patterns further below run over the ORIGINAL line either way.
                subject = line
                if f in ATTRIBUTION_PROSE and not is_code:
                    subject = AUTHOR_STANDALONE.sub(" ", subject)
                bad = find_names(subject, PRIVATE_CONTAINMENT, ())
                if not persona_ok_here:
                    bad += find_names(line, PERSONA_CONTAINMENT,
                                      PERSONA_STRUCTURAL)
                if bad:
                    where = "code" if is_code else "prose"
                    print(f"  {f}:{n}  persona/owner name in {where}: "
                          f"{', '.join(sorted(set(bad)))}")
                    hits += len(set(bad))

            # -- everything below is NOT suppressed by the persona marker ----
            for label, pattern in PRIVATE_MARKER_PATTERNS:
                for m in pattern.finditer(line):
                    print(f"  {f}:{n}  {label}: {mask(m.group(0))}")
                    hits += 1

            if CJK.search(line):
                print(f"  {f}:{n}  Chinese text")
                hits += 1
    print("  clean" if hits == 0 else f"  {hits} finding(s)")
    findings += hits
    print()

    print("=== 4. secret-like content ===")
    hits = 0
    for f in paths:
        # No file is exempt here, lockfiles included.
        for n, line in enumerate(read_lines(f), start=1):
            for label, value in secrets_in(line, f):
                print(f"  {f}:{n}  {label}: {mask(value)}")
                hits += 1
    print("  clean" if hits == 0 else f"  {hits} finding(s)")
    findings += hits
    print()

    return findings


def main() -> int:
    # Supported entry points:
    #   scan.py                 - this repository (git ls-files, or a walk
    #                             when the tree is an extracted snapshot)
    #   scan.py --root DIR      - another tree, same rules; the recursive
    #                             walk entry point used for revalidating
    #                             historical checkpoint archives
    #   scan.py FILE [FILE...]  - exactly the named files
    # Every mode hard-fails on an empty walk rather than passing vacuously.
    args = sys.argv[1:]
    if args[:1] == ["--root"]:
        if len(args) != 2 or not Path(args[1]).is_dir():
            print("usage: scan.py --root <directory>")
            return 2
        os.chdir(args[1])
        args = []
    elif not args:
        os.chdir(Path(__file__).resolve().parent.parent)
    self_test()
    print()
    try:
        findings = scan(args or target_files())
    except EmptyWalkError as error:
        print(f"SCAN FAIL - empty walk: {error}")
        return 1
    print("SCAN PASS" if findings == 0 else f"SCAN FAIL - {findings} finding(s)")
    print()
    print("Note: this is a pre-flight check. An independent release-grade secret\n"
          "scan is still required before the first push to a public remote.")
    return 0 if findings == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
