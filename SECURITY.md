# Security Policy

## Supported versions

Delos is a local-first application distributed as source. Security fixes land
on `main`; please run from a recent commit or tagged release rather than an
old snapshot.

## Reporting a vulnerability

Please do **not** open a public issue for anything you believe is a security
problem.

Use GitHub's **private vulnerability reporting** for this repository
(Security tab → "Report a vulnerability"), which reaches the maintainer
directly without public disclosure.

## What matters most here

Delos is designed to hold private conversation data locally. Reports in these
areas are especially welcome:

- Anything that could send transcripts, memories, prompts, state files, or
  credentials off the machine (network egress, telemetry, provider calls)
  outside the explicitly documented, owner-gated paths.
- The privacy scanner (`scripts/scan*.py`) failing closed incorrectly — or
  worse, silently passing content it should flag.
- Path traversal, symlink, or unsafe-deserialization issues in model loading,
  backup/restore, import, or transcript handling.
- Secret handling: tokens, proxy credentials, or API keys leaking into logs,
  receipts, error messages, or durable state.

## Scope notes

- The threat model is a single-owner, local-first runtime; multi-user hardening
  is out of scope until an ADR says otherwise.
- Vulnerabilities in third-party model providers or CLIs that Delos delegates
  to (Codex, Claude, Kimi) should be reported upstream; reports about how Delos
  integrates them are in scope here.
