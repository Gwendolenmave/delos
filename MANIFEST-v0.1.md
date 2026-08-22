# Public Delos — v0.1 Inclusion Manifest

Status: **v0.1 source release candidate.** No release is tagged and no package
is published to npm. This repository was created empty and carries **none** of
the private implementation's `.git` history.

## 0. What v0.1 is

A clean, installable, configurable, **conversable** minimum vertical slice.

v0.1 does **not** chase feature parity with the private implementation. It ships
when a user can install it, point it at a model provider, and hold a
conversation with a default assistant they can rename and rewrite.

### Implementation status

**The minimum vertical path now exists locally and runs**: local JSON
configuration, filesystem identity adapter, assembled system prompt, recent
history selection, current user message, OpenAI-compatible model adapter,
reply sanitisation, and a command-line reference surface. It is proven
end to end against a synthetic loopback provider.

**Wave 7a adds the provider and secret foundation** on a development
branch: provider profiles (official OpenAI via the Responses protocol,
official Anthropic via the Messages protocol, and OpenAI-/Anthropic-compatible
endpoints), a SecretStore port with environment-backed and in-memory stores,
central credential redaction, and CLI profile selection and connection
testing. Browser setup, desktop credential storage, delegated logins,
Telegram, persona packs and persistent conversations are later stages, and no
placeholder for them exists in the code.

**Wave 7 Phase 2 adds persona packs and context continuity** on the
programme branch: portable versioned packs with hardened directory/ZIP import
and deterministic export, transparent variant resolution with manual-only
intimacy, model-output containment, trusted time, trust-ordered context
assembly, user-authored Current Situation state, and deterministic history
reads. `personas/arti/` is the canonical persona form; `prompts/` remains the <!-- scan-allow-persona -->
v1 compatibility path.

**Wave 7 Phase 3 adds the persistent runtime**: a SQLite transcript archive
on the built-in `node:sqlite` (versioned atomic migrations, restart
persistence, non-persistent `:memory:` mode), external-turn identity with
database-arbitrated idempotency, an exactly-once turn coordinator with honest
crash recovery, and served-model/capability observations recorded as
evidence. Still zero runtime dependencies.

**Wave 7 Phase 4 adds the usable local application**: a loopback daemon
serving /api/v1 behind a session-token + origin gate, one typed client shared
by every surface (and the future PWA), and a framework-free web application
with onboarding, chat, personas, situations, providers, backup and
diagnostics. Still zero runtime dependencies.

**Wave 7 Phase 5 adds the desktop shell, the Telegram surface, and
delegated Codex / Claude Code provider kinds** - all through the same
daemon, coordinator and transcript store. Desktop secrets are OS-encrypted
with an honest session-only fallback; Telegram is disabled by default,
DM-only and allowlisted; delegated tools own their own logins and their
protocol contracts are proven against committed fakes (Codex is not
functional on the development host - integration is reported
detected-untested, never assumed). The root package keeps zero runtime
dependencies; Electron lives in a separate desktop subpackage.

**Wave 7 Phase 6 adds the full deterministic backup, the atomic restore,
and doctor.** One versioned ZIP carries everything non-secret; secrets are
structurally inexpressible in it; restore rolls back completely on any
failure and names the profiles whose credentials must be reconfigured;
doctor reports operational truth as read-only PASS/DEGRADED/BLOCKED checks
on the API, the web Diagnostics page, and an offline CLI, with a redacted
exportable report.

**Wave 7 Phase 7 adds the public-safe extensions**: fence-preserving reply
segmentation, the voice/attachment boundary with pluggable LOCAL speech-to-
text, the default-off proactive runtime with visible timing and an echo
guard, persona validate/snapshot/test tooling with append-only evidence,
and the Addendum B items - egress policy (off by default), model pinning,
the delimiter guard, the public ADR set, executable repo hygiene, and
containment before persistence.

**No release is tagged, and no package has been published.** v0.1 is offered as
source only; the release gates that govern publication are in
`docs/MIGRATION-PLAN.md`. A local build is required before the CLI will run.
Completed work is recorded module by module in `docs/PROVENANCE.md`.

### Release surface for v0.1 — source only

v0.1 is distributed as **a public source repository and source archives derived
from it**. It is **not published to npm**, and npm publication is deliberately
out of scope for this release.

That is why `package.json` carries `"private": true`, why there is no
`prepack`, `prepare` or automatic build-output packaging step, and why `build/`
is never committed. The `bin` entry names the path the CLI occupies *after* a
local `npm run build`; it is not a promise that a packed tarball is an
installable npm distribution.

`npm pack --dry-run` is used in this project only as an **accidental-inclusion
audit** — a way to see what a source archive would carry, and to confirm that
build output, caches, editor files and local configuration stay out of it.
Nothing in this repository should be read as offering an npm package.

## 1. Naming principle — binding on all code in this repository

> **Arti is a default identity, not an architectural namespace.** <!-- scan-allow-persona -->

- `Delos` is the product and framework name, and may appear anywhere.
- `Arti` is **only** the value of a default identity shipped in `prompts/`. <!-- scan-allow-persona -->
- Core code is named by **function, role, or data type** — never after a persona.
- A user replacing the default persona must only replace prompt/profile
  **content**. They must never have to rename code, move files, migrate a
  database schema, or touch test infrastructure.

Therefore: files and identifiers carrying a persona name in the private
implementation are **renamed to their function**, not renamed to the new persona.

| private | public |
|---|---|
| `amelia-proposal-sink.ts` | `proposal-sink.ts` <!-- scan-allow-persona --> |
| `amelia-proposals.ts` | `proposals.ts` <!-- scan-allow-persona --> |
| `ameliaProposal` | `proposal` <!-- scan-allow-persona --> |
| `ameliaIdentity` | `assistantIdentity` / `activeIdentity` <!-- scan-allow-persona --> |
| *(counter-example)* `artiProfile` | `activeProfile` / `defaultProfile` <!-- scan-allow-persona --> |

Default prompt files keep generic names: `identity.md`, `relationship.md`,
`response-style.md`.

**Every case form is forbidden**: standalone words, `snake_case`,
`kebab-case`, `camelCase`, `PascalCase`, `SCREAMING_CASE`, and those embedded
in a longer identifier.

What the scanner actually guarantees, stated exactly rather than optimistically:

- **Owner and private-instance names** are matched by **case-insensitive
  containment anywhere inside an identifier**. They are long enough that no
  ordinary English or code word contains them, so this catches every form,
  including run-together ones such as an all-caps name concatenated with a
  suffix, or a name appearing at the end of a longer identifier.
- **The default persona's short name** is matched **structurally** — by
  splitting identifiers on separators, case transitions and digit boundaries —
  because containment would fire on `Partial`, `article`, `particle`,
  `partition` and `martial`. **Known limit:** a run-together all-caps form
  such as `ARTIPROFILE` is *not* caught. The longer form of the name is
  matched by containment and has no such gap.

The self-test enumerates the forms it must catch and the ordinary words it
must not. `scripts/scan-adversarial-test.py` then runs the scanner end to end
against synthetic trees, because matcher tests alone missed two control-flow
bypasses.

Outside the default persona content, example screenshots, and explicitly
labelled default-profile data, **no persona or owner name may appear in public
code.**

**Exceptions are narrow, and there are exactly three kinds.** Stated precisely,
because a governance rule that overstates itself is worse than one that admits
its shape.

1. **Per line.** Any line may be exempted with an inline `scan-allow-persona`
   marker. The marker must sit in a comment, never inside a string, and it
   suppresses only the persona category on only that line — a secret, email or
   home path on the same line still fails.
2. **Persona and mythology names, in two paths.** `prompts/*.md` and
   `docs/DESIGN-NOTES.md` may carry the **default persona and the public
   mythology names** freely: the first is the shipped persona content, the
   second exists to explain where the names came from.
3. **Authorship names, as standalone words, in the attribution documents.**
   `README.md`, `LICENSE-NOTES.md`, `RELEASE-NOTES-v0.1.md`,
   `docs/DESIGN-NOTES.md` and `docs/PROVENANCE.md` name the project's licensor,
   maintainer and authors, because saying who offers a licence is their job.
   Everywhere else the authorship names are refused.

Each allowance covers **one category of name, in prose only**. None of them is
a whole-file exemption: inside every path listed above, a secret, an email
address, a home path, CJK text, or any **run-together identifier form** of a
name — `ameliaProfile`, `GWENCONTEXT`, `gwendolenHome` — is still reported. <!-- scan-allow-persona -->
Rule (3) matches whole words only, which is precisely what keeps an authorship
name from becoming a namespace while letting a byline be a byline.

Every exemption is enumerable, though it takes two commands rather than one:

    grep -rn "scan-allow-persona" .
    grep -n "DEFAULT_PERSONA_PROSE\|ATTRIBUTION_PROSE" scripts/scan.py

`scripts/scan-adversarial-test.py` attacks (2) and (3) directly, asserting that
each of the following still **fails**: an authorship name in another document,
in this manifest, in the shipped prompts, or in code; any run-together
identifier form inside an attribution document; and a key or an email address
sitting on an otherwise-permitted line. The suite prints its own case count when
run, which is why no count is quoted here.

## 2. Migration classification

Every file considered for migration is classified into exactly one category.

| # | category | disposition |
|---|---|---|
| **1** | Private content or sensitive data | **Never migrated.** |
| **2** | Persona/owner identity, naming, or relationship coupling | **Redesigned or renamed** to a functional name (see §1). |
| **3** | Ordinary Chinese documentation, comments, and UI strings | A **localization** task. Translate. **Not automatically treated as privacy.** |
| **4** | Private test fixtures, AU lexicons, frozen semantic assets | **Rebuilt as synthetic English fixtures, or removed from v0.1.** |
| **5** | Neutral code | Migrated **only** when it enters the v0.1 minimum vertical path or is a necessary dependency of something that does. |

Category 5 is the default gate: lexical cleanliness is **not** sufficient
grounds for inclusion. A file is included because the vertical path needs it.

## 3. In scope for v0.1

- Configuration loading (provider, model, credentials — read from local config)
- A model-provider port and **one** OpenAI-compatible provider adapter
- Prompt loading and system-prompt assembly from `prompts/`
- A minimal turn service: user message → assemble context → call model → reply
- A short rolling recent-context window
- Basic reply sanitisation
- A command-line entry point
- Synthetic English test fixtures for everything above
- `README.md` explaining installation, configuration, and **how to replace or
  extend the default persona and add prompt blocks**

## 4. Explicitly out of scope for v0.1

- **`assets/episode-summary/sum-v*` bundles, fiction lexicons, and any
  automatic-summarisation semantic asset.** Not migrated in any form.
- Any feature that depends on those assets — episode projection, Pass1/Pass2
  summarisation, the deterministic summariser.
- Long-term memory governance (Mnemosyne cards, proposal/review flow), the
  retrieval stack (Anamnesis), proactive behaviour, conversation-mode routing,
  current-situation state.
- Every messaging-platform adapter.
- Any web or desktop UI.

Persistent local memory is **deferred**, not rejected. It may enter a later
version only when it (a) does not depend on the excluded semantic assets and
(b) can be verified independently with synthetic fixtures.

## 5. Prompt content

`prompts/identity.md`, `prompts/relationship.md`, and `prompts/response-style.md`
are shipped with content authored by the project owners and landed verbatim.
**No placeholders.** These three files are the entire default persona.

## 6. Governance boundary

The private implementation's semantic-asset governance (hash-bound bundle
identities, ruling gates) is **not** a global approval gate for creating this
repository. Public Delos may mint its own synthetic semantic assets, versions,
and hash provenance independently.

Those private governance rules apply **only** if a public asset is ever merged
back into the private canonical system.

## 7. Working rules

1. **One module at a time**, together with its necessary dependencies.
2. Every migration performs, at the moment of import: de-personalisation
   (§1), English publication (§2 category 3), and synthetic-fixture replacement
   (§2 category 4).
3. After each module: an individual scan, a test run, and a provenance record.
4. **The first commit published to a public remote happens only after a
   full-repository scan and a fresh-clone verification both pass.** Before
   publication these commits were review history and could still be revised.
   From the first published commit onward the history is public and permanent,
   and the scan covers `git log` as well as the working tree.
5. The private implementation is never modified. It is read-only reference.

## 8. Provenance

Each migrated module records its origin in `docs/PROVENANCE.md`: source path in
the private implementation, what was renamed, what was translated, what fixtures
were replaced, and the scan result at time of import.
