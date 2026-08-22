# v0.1 Migration Plan — minimum vertical path and dependency closure

Derived from a read-only analysis of the private implementation.

**This document is the plan. `docs/PROVENANCE.md` is the record.** For what was
actually migrated, rewritten or written fresh, and why, read that instead.

Status: Waves 1 to 4 are complete. The original planning rationale below is
preserved unchanged - including the reasoning for writing Wave 4 fresh rather
than porting it - because the reasoning is what makes the result reviewable.

The order below is a dependency order: each wave depends only on waves above it.
Migrate **one module at a time**, completing de-personalisation, translation, and
fixture replacement at the moment of import — never as a later cleanup pass.

## Scan legend

`PERSONA` = persona and owner names, in every case and identifier form. The
authoritative list lives in `scripts/scan.py`; do not restate it here, so there
is only one place to keep correct.
`CJK` = lines containing Chinese characters (a **localisation** signal — category 3
— unless inspection shows the content itself is private, which promotes it to
category 1).
`DEPS` = distinct intra-repo import sources.

> Scanning must be run **inside WSL**. The same scan run from the Windows side
> returned a false "0 CJK across all files". A false-clean result is the most
> dangerous failure mode here; always sanity-check the scanner against a file
> known to contain Chinese before trusting a zero.

---

## Wave 0 — scaffolding (written fresh, nothing migrated)

| item | note |
|---|---|
| `package.json`, `tsconfig.json` | fresh; private version carries private script names |
| `.gitignore` | fresh |
| `README.md` | fresh — must explain installing, configuring a provider, and **replacing or extending the default persona / adding prompt blocks** |
| config loader | fresh — the private loader is coupled to a messaging platform |

## Wave 1 — domain and ports

| module | lines | persona | cjk | deps | action |
|---|---|---|---|---|---|
| `core/domain/types.ts` | 82 | 1 | 0 | 0 | migrate; rename 1 identifier per §1 |
| `core/ports/model-provider.ts` | 215 | 2 | 0 | 1 | migrate; rename 2 identifiers; this is the contract the fresh adapter implements |

## Wave 2 — leaf services

Order: `token-estimate` → `prompt-loader` → `reply-sanitizer`.

| module | lines | persona | cjk | deps | action |
|---|---|---|---|---|---|
| `core/services/token-estimate.ts` | 44 | 0 | 1 | 0 | migrate; needed by `recent-window` in Wave 3 |
| `core/services/prompt-loader.ts` | 290 | 1 | 0 | 1 | migrate. **Loads the default prompts — the keystone of persona replaceability. Must not hard-code any persona name.** Re-decide the public contract rather than translating line by line |
| `core/services/reply-sanitizer.ts` | 197 | 2 | 5 | 0 | migrate **after** `prompt-loader`. Audit rule by rule first: keep as protocol cleanup, rewrite provider-neutral, or drop |

### Deferred — not part of the v0.1 closure

| module | why deferred |
|---|---|
| `core/services/reply-segmenter.ts` | Splits a reply into chat bubbles: a **messaging-platform presentation** concern. v0.1 is a CLI and has no caller for it. Revisit when a messaging or UI adapter actually exists. |
| `core/services/time-context.ts` | Not required by the minimum vertical path. Migrating early only buys an extra rewrite pass. |
| `core/services/time-labels.ts` | Same, and 23 CJK lines in 88 need classification before import. |

> **Inclusion is decided by the vertical path, never by how clean a scan is.**
> `reply-segmenter` was originally scheduled first *because* it scanned
> cleanest — which is not a reason. Lexical cleanliness says a file is safe to
> copy; it says nothing about whether v0.1 needs it. A public repository
> carrying code no caller reaches is dead weight that still has to be
> reviewed, tested and maintained.

## Wave 3 — composed services

| module | lines | persona | cjk | deps | action |
|---|---|---|---|---|---|
| `core/services/recent-window.ts` | 144 | 2 | 2 | 2 | migrate; depends on `types` + `token-estimate` (both Wave 1–2). This is the **only** memory-ish feature in v0.1 and it does **not** touch the excluded semantic assets |

## Wave 4 — written fresh (deliberately not migrated)

| item | why fresh |
|---|---|
| **OpenAI-compatible provider adapter** | `adapters/models/openai-compatible/` in the private repo **contains only a README** — the adapter does not exist. Nothing to migrate; write it against the Wave 1 port. |
| **Turn service** | `core/services/chat-service.ts` imports **6 ports and 13 services** (retrieval, proactive behaviour, conversation-mode, current-situation, history-request, delimiter-guard …). Far past v0.1 scope. Write a thin turn service instead: assemble prompts + recent window → call provider → sanitise → return. |
| **CLI entry point** | the private CLI composition root wires memory, projections, and platform adapters that v0.1 excludes |

## Wave 5 — synthetic test fixtures

Every test in v0.1 is written fresh in **English with synthetic data**. No test
fixture is migrated. The private test suite is category 4 by default: 81 of its
107 files carry persona names or Chinese, and its fixtures encode real
conversation material.

---

## Explicitly excluded from the closure

These appear in the private repo's dependency graph but are **cut**, not ported:

`anamnesis` · `context-assembler` · `conversation-mode` · `current-situation` ·
`proactive-context` · `proactive-echo` · `proactive-policy` · `history-request` ·
`delimiter-guard` · `mnemosyne-governance` · `proposal-sink` · all
`episode-*` modules · `deterministic-episode-summarizer` ·
`assets/episode-summary/sum-v1…v9` · all memory adapters · all messaging adapters.

## Per-module checklist

Each module is done when all of the following pass:

- [ ] classified into exactly one category (1–5) and recorded
- [ ] every persona or owner name resolved to a **functional** name — never to the default persona's name
- [ ] every Chinese comment / string translated to English
- [ ] no fixture, sample, or example carries real conversation material
- [ ] compiles, and its fresh synthetic test passes
- [ ] scan re-run on the migrated file: **zero** persona hits, **zero** CJK
- [ ] provenance appended to `docs/PROVENANCE.md`

## Release gate for the first commit published to a public remote

This gate applies to publication, not to local commits. Local staging history
is discardable review material.

- [ ] full-repository scan: **zero persona-name hits in code**, in any case form.
      Legitimate exceptions, and the only ones: `prompts/` (the default persona
      itself), `README.md` (introduces the default persona), `docs/DESIGN-NOTES.md`
      (explains where the public names came from, and carries the owner byline
      as a single scanner-approved exact line), and the governance documents
      that state the naming rule (`MANIFEST-v0.1.md`, `docs/MIGRATION-PLAN.md`).
      Any hit in a source file, path, identifier, schema, or test is a failure.
- [ ] full-repository CJK scan: zero
- [ ] no credential, `.env`, database, transcript, or private asset present
- [ ] `git log` contains no private history
- [ ] **fresh-clone verification**: clone to a new directory, install, configure a
      provider, hold a real conversation — with no reference to the private
      implementation on disk
