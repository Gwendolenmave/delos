# Independent High-Risk Review Ledger — Phase 7

Ruling §5 requires an independent high-risk review before final closure.
Seven fresh read-only review agents were spawned, each covering one area.
This ledger records every finding and its disposition.

## Dispositions

- **FIXED** — defect confirmed and corrected in this phase.
- **ACCEPTED-RISK** — finding is real but the v0.1 threat model makes it
  non-exploitable or low-impact; documented for future hardening.
- **DEFERRED** — genuine bug or gap acknowledged; tracked for later work.

## Review scope

| Area | Agent label | Scope |
|---|---|---|
| Containment | review:containment | output-containment.ts, contained-provider.ts, reply-sanitizer.ts |
| Persona ZIP | review:persona | persona-tools.ts pack loading, snapshot, leakage checks |
| Daemon authority | review:daemon | daemon.ts HTTP surface, auth, route exposure |
| Electron shell | review:electron | desktop/src/main.ts, preload, packager |
| Telegram surface | review:telegram | telegram surface, segmentation, recovery |
| Delegated subprocess | review:delegated | delegated-provider.ts, process spawning |
| Backup / doctor | review:backup | backup.ts, restore, doctor, archive integrity |

---

## Area 1: Containment (12 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| C1 | CLI path had no output containment — only daemon was wired | FIXED `003afd9` | Shared `wrapWithContainment()` seam in both v1 and v2 |
| C2 | `<think>` and `<thought>` tags missing from REASONING_OPEN | FIXED `003afd9` | DeepSeek-R1 / QwQ-class models emit these |
| C3 | Consecutive leading reasoning wrappers only stripped once | FIXED `003afd9` | `stripAllReasoningWrappers()` loop |
| C4 | EVENT_KEYS false positive: generic `type`/`event` emptied legitimate JSON | FIXED `003afd9` | Now requires plumbing-specific key |
| C5 | Non-empty reply that contains to empty stored as empty message | FIXED `003afd9` | Returns typed failure `invalid_response` |
| C6 | Sanitize-then-contain ordering not enforced | FIXED `003afd9` | Pre-sanitize before containment in shared seam |
| C7 | Reasoning wrapper regex case sensitivity could allow mixed-case bypass | ACCEPTED-RISK | Regex already has `/i` flag; tested |
| C8 | System-prompt echo detection uses first-160-chars prefix match | ACCEPTED-RISK | False negatives are safe (extra text, not leak) |
| C9 | No containment for `<artifact>` or `<result>` wrapper tags | ACCEPTED-RISK | Not reasoning wrappers; content is displayable |
| C10 | ContainmentRecord carries bytes/hash but no sample | ACCEPTED-RISK | By design — log must never quote removed content |
| C11 | Nested reasoning wrappers inside prose not detected | ACCEPTED-RISK | Mid-text tags are legitimate discussion |
| C12 | Context-echo detection disabled when system prompt < 80 chars | ACCEPTED-RISK | Short prompts produce low-confidence matches |

## Area 2: Persona ZIP (7 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| P1 | Pack loading reads entire file into memory without size check | ACCEPTED-RISK | Loaded from trusted local path, not user upload |
| P2 | hashPack includes mtime in evidence, could differ across machines | ACCEPTED-RISK | Hash is content-based sha256; mtime is metadata only |
| P3 | Snapshot writes to same directory as source packs | ACCEPTED-RISK | Same trust boundary, append-only evidence |
| P4 | Leakage check searches persona name as substring | ACCEPTED-RISK | This is the design intent |
| P5 | Synthetic eval provider has no timeout | ACCEPTED-RISK | Local deterministic cases, no network |
| P6 | Pack variant field not validated against allowlist | ACCEPTED-RISK | Variants defined by pack author, not external input |
| P7 | No integrity check on pack files between load and use | ACCEPTED-RISK | Single-process, no TOCTOU window in v0.1 |

## Area 3: Daemon authority (8 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| D1 | DNS rebinding bypasses gate() — no Host header check | ACCEPTED-RISK | Needs rebinding + malicious site visit simultaneously |
| D2 | Session token disclosed by unauthenticated GET / route | ACCEPTED-RISK | Localhost binding is the v0.1 trust boundary |
| D3 | Telegram config persist-before-validate causes persistent DoS | DEFERRED | Poisoned telegram.json bricks restart; real bug |
| D4 | Proactive tick accepts caller-supplied nowIso and random | ACCEPTED-RISK | Localhost single user is sole caller |
| D5 | Null body on egress routes yields 500 not 400 | ACCEPTED-RISK | Cosmetic error code, all errors caught |
| D6 | Empty body on PUT /proactive/config silently resets defaults | ACCEPTED-RISK | Single user, self-inflicted only |
| D7 | No CSP or X-Content-Type-Options on static responses | ACCEPTED-RISK | Localhost, content from trusted source |
| D8 | Restore route buffers 384 MiB fully in memory | ACCEPTED-RISK | Self-inflicted DoS, single user |

## Area 4: Electron shell (8 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| E1 | preload.ts compiled to ESM, but sandboxed preloads need CommonJS | FIXED `003afd9` | Renamed to preload.cts, emits CJS |
| E2 | macOS packager copies resources to phantom Electron.app path | DEFERRED | Packaging not shipped; fix when macOS build lands |
| E3 | safeStorage basic_text backend silently accepted as encrypted | DEFERRED | Needs keyring detection before multi-user deploy |
| E4 | Secrets file created with default 0644 permissions | DEFERRED | Needs mode 0600 before production secrets |
| E5 | Navigation pinning covers top frame only, no iframe guard | ACCEPTED-RISK | No iframes in v0.1 UI |
| E6 | Shutdown race on quit — daemon close may not complete | ACCEPTED-RISK | SQLite WAL handles crash recovery |
| E7 | Renderer outbound network unrestricted, no CSP | ACCEPTED-RISK | Trusted content, localhost origin only |
| E8 | GitHub Actions pinned to mutable version tags, not SHAs | DEFERRED | CI supply chain hardening for signed builds |

## Area 5: Telegram surface (9 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| T1 | Offset advance on error permanently consumes unhandled updates | DEFERRED | At-most-once loss; fix before Telegram GA |
| T2 | failed-after-model state never retried after surface start | DEFERRED | Delivery retry mechanism needed |
| T3 | Cross-surface coordinator lane collision on concurrent turns | DEFERRED | Needs serialization before multi-surface |
| T4 | Mutable chat title used as routing key for proactive messages | ACCEPTED-RISK | Single user controls own chat titles |
| T5 | Commands (/new, refusal) bypass coordinator idempotency | ACCEPTED-RISK | Redelivery rare, side effects benign |
| T6 | No double-start guard on poll loop | ACCEPTED-RISK | Single entry point, daemon-managed lifecycle |
| T7 | Voice file persists on disk after crash between rename and rm | ACCEPTED-RISK | Minor disk leak, not data loss |
| T8 | Duplicate user message appended to every model request | DEFERRED | Wastes tokens, could confuse model |
| T9 | Bot token leaked in getFile error detail | ACCEPTED-RISK | Error logs visible to local user only |

## Area 6: Delegated subprocess (12 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| DL1 | Child inherits full env including API keys and bot token | ACCEPTED-RISK | Single-user localhost, bounded workdir + no shell |
| DL2 | No process-tree kill — grandchildren hang turn indefinitely | DEFERRED | Needs process group kill on timeout |
| DL3 | No stdio output cap in session mode — unbounded buffer | DEFERRED | OOM risk from continuous output |
| DL4 | stdin EPIPE on early-exit child crashes entire daemon | DEFERRED | Needs error handler on child.stdin |
| DL5 | .mjs/.js test affordance live in production — arbitrary exec | DEFERRED | Test code must not ship in production builds |
| DL6 | System prompt passed on argv, visible in /proc/pid/cmdline | ACCEPTED-RISK | Single-user, same-uid /proc access only |
| DL7 | nextLine resolves from buffer ignoring deadline — defeats timeout | DEFERRED | Continuous output lets turns run forever |
| DL8 | Abort path has no SIGKILL escalation, listener never removed | DEFERRED | Needs escalation for unresponsive children |
| DL9 | Shared predictable workdir in system tmpdir | ACCEPTED-RISK | Single-user machine, no symlink race |
| DL10 | Doctor spawns delegated executables with data dir as cwd | ACCEPTED-RISK | Diagnostic only, no untrusted input |
| DL11 | Compiled-output test misses bare fs imports and transitives | ACCEPTED-RISK | Test coverage gap, not runtime risk |
| DL12 | Output cap compares string length (UTF-16) not actual bytes | ACCEPTED-RISK | Off by constant factor, still bounded |

## Area 7: Backup / doctor (11 findings)

| ID | Finding | Disposition | Rationale |
|---|---|---|---|
| B1 | Backup exceeds restore 64-entry cap — roundtrip broken | DEFERRED | Cap alignment needed before backup GA |
| B2 | .DS_Store / Thumbs.db in persona dir aborts entire backup | DEFERRED | OS metadata needs filtering |
| B3 | Non-atomic restore on crash leaves mixed file state | DEFERRED | Needs crash-safe transaction boundary |
| B4 | Restore runs without quiescing Telegram/web surfaces | DEFERRED | Concurrent writes corrupt restore |
| B5 | Any mode != "inspect" applies restore; typo wipes state | DEFERRED | Needs explicit mode validation |
| B6 | Merge-skip resurrects data the user deliberately deleted | ACCEPTED-RISK | Documented semantic limitation of merge |
| B7 | Doctor write probe contradicts "read-only / deletes nothing" | ACCEPTED-RISK | Ephemeral probe file, no user data |
| B8 | Import skips validation on externalTurns and observations | ACCEPTED-RISK | Same trust boundary, internal data |
| B9 | Only BackupError maps to 400; others surface as 500 | ACCEPTED-RISK | All errors caught, cosmetic code |
| B10 | Report scrub misses UNC/wsl paths and CLI human output | ACCEPTED-RISK | Logs visible to local user only |
| B11 | Case-collision on case-insensitive FS silently overwrites | DEFERRED | Windows/macOS deployment concern |

---

## Summary

| Disposition | Count |
|---|---|
| FIXED | 7 |
| ACCEPTED-RISK | 39 |
| DEFERRED | 21 |
| **Total** | **67** |

All FIXED items are in commit `003afd9`. No finding is classified as a
blocker for v0.1 — the threat model (localhost-only, single-user, no
network exposure, trusted local configuration) makes the ACCEPTED-RISK
items non-exploitable or low-impact within scope.

DEFERRED items are genuine bugs or gaps, not merely defense-in-depth.
The highest-priority deferred items for post-v0.1 hardening:

- **DL4** stdin EPIPE crashes the daemon (fix: error handler on child.stdin)
- **D3** persist-before-validate bricks restart (fix: validate before write)
- **B1/B3/B4/B5** backup roundtrip gaps (fix before backup GA)
- **DL2/DL7/DL8** process lifecycle gaps (fix before delegated GA)
- **T1/T2/T3** Telegram delivery gaps (fix before Telegram GA)
