# Provenance

One entry per migrated module. Records where it came from, what changed on the
way in, and the scan result at time of import.

Private-source paths are recorded relative to the private implementation's
repository root. That repository was read-only throughout and was never
modified.

---

## Wave 0 — scaffolding (written fresh)

| file | origin |
|---|---|
| `package.json` | **written fresh.** Only the toolchain choice was reused from the private implementation: TypeScript plus Node's built-in `node --test`, no external test framework. |
| `tsconfig.json` | **written fresh**, same compiler settings family (`ES2022`, `NodeNext`, `strict`, `noUncheckedIndexedAccess`). Output directory is `build/`. |
| `scripts/scan.py` | **written fresh.** Release scanner enforcing the manifest invariants. |

---

## Wave 1

### `core/domain/types.ts`

- **Source:** `core/domain/types.ts`
- **Category:** 5 (neutral code) with category-2 elements
- **Changed on import:**
  - Removed `ChatMessage.proactive` and `TurnFailure.superseded` — both belong
    to a self-initiated-turn feature outside v0.1 scope, and the first named
    the private persona in its comment.
  - Rewrote the `PromptSection.name` comment to describe the three shipped
    defaults **and** that users may add their own sections.
- **Changed in Wave 1 review fixes:**
  - Removed `AssistantThinking` and `TurnSuccess.thinking` entirely. v0.1 has
    no consumer that displays or audits reasoning, and no adapter that
    demonstrably exposes an independent reasoning channel. Reserved for
    reintroduction (see "Removed port capabilities" below).
  - `PromptSection.path` is now documented as relative to the **configured
    prompt root**, not the repository root. A user may put prompts anywhere;
    a repository-relative path would be meaningless for most installations.

### `core/ports/model-provider.ts`

- **Source:** `core/ports/model-provider.ts` (215 lines)
- **Category:** 5, with category-2 comments
- **Changed on import:**
  - Removed comments naming the private persona.
  - Removed a vendor-specific prompt-cache capability surface, web-search
    capability and its audit record, image input, the turn-context kind union
    (every one of its nine members named an excluded subsystem), provider
    runtime events, and a tool-loop-specific error kind.
  - Kept: `servedModel` comes from provider metadata and never from generated
    prose.
- **Changed in Wave 1 review fixes:**
  - **Request shape re-decided.** `dynamicPrompt` plus optional
    `currentUserText` overlapped in responsibility and erased role boundaries.
    Replaced with `systemPrompt: string` and `messages: ChatMessage[]`, where
    the last message is the current user input. Everything the model reads as
    dialogue now carries an explicit role, so a caller cannot present
    assistant text as user text. Non-dialogue per-turn context belongs in
    `systemPrompt`.
  - **Error kinds made provider-neutral.** `spawn_failure` and `nonzero_exit`
    assumed a CLI subprocess; v0.1's only planned adapter is an HTTP client,
    so neither could ever be produced. Replaced with conditions rather than
    mechanisms: `configuration`, `authentication`, `rate_limit`, `timeout`,
    `network`, `invalid_response`, `provider_error`, `cancelled`. A test
    asserts no kind names a transport mechanism.
  - Removed `ProviderCapabilities` entirely rather than leaving an empty
    interface behind after its only member was dropped.

### `tests/model-provider-contract.test.ts`

- **Source:** **none.** Written fresh. No private test fixture was migrated.
- **Fixtures:** entirely synthetic — an in-process `RecordingProvider` that
  never reaches the network, synthetic identifiers, and placeholder questions.
- **Changed in Wave 1 review fixes:**
  - The file now states its own limits: it exercises the port's *shape* using
    one synthetic provider. It does **not** establish how any real adapter
    behaves. The earlier framing implied a fake could prove adapters never
    throw; it cannot.
  - The "idempotency" test was renamed to what it actually shows —
    turn-id pass-through. Real idempotency needs a real adapter and observable
    side effects.
  - Added role-boundary tests: the system prompt stays outside the message
    list, the last message is the current user input, roles and order survive
    unchanged, assistant history is never re-attributed to the user, and a
    turn ending in an assistant message is rejected rather than silently
    accepted.

---

## Removed port capabilities — reintroduce on evidence, not on speculation

Recorded so they can be restored deliberately when a real need appears. None
should be reintroduced as an empty contract ahead of an implementation.

| capability | why removed | what would justify restoring it |
|---|---|---|
| reasoning channel (`AssistantThinking`, `thinking`, `reasoningChannel`) | no consumer, no adapter that proves it has one | an adapter with a genuine independent reasoning field, a runtime consumer that displays or audits it, and tests |
| explicit prompt caching | vendor-specific; no adapter can honour it | an adapter that can actually emit and observe cache control |
| web search capability and audit record | out of v0.1 scope | a real retrieval tool, plus the audit record that says what left the machine |
| image input | out of v0.1 scope | an adapter with a verified non-interactive image path |
| turn-context kinds | every member named an excluded subsystem | the subsystems themselves |
| provider runtime events | stateful-provider thread management, unused | a stateful adapter that changes threads |
| subprocess error kinds (`spawn_failure`, `nonzero_exit`) | assumed a CLI transport that v0.1 does not have | a subprocess adapter, and even then they should map onto the neutral kinds |

---

## Scanner

`scripts/scan.py` replaced an earlier shell version. Four defects were found
and fixed, all of the false-clean class — the worst kind, because a scanner
that reports "clean" incorrectly is worse than no scanner at all.

1. **A repository-wide Chinese-text scan run from a Windows shell returned `0`
   for all 297 files of the private repository.** The identical scan inside
   WSL returned 135. The scanner now self-tests its matchers before reporting.
2. **Substring matching false-positived on ordinary code** — `Partial`,
   `article`, `particle`, `partition`, `martial` all contain a persona name as
   a substring.
3. **The word-boundary fix that followed then produced false NEGATIVES**: it
   covered only one name's camelCase form, so `ameliaProfile`, <!-- scan-allow-persona -->
   `currentAmeliaProfile`, `defaultAmelia`, `gwenContext`, `currentGwenState`, <!-- scan-allow-persona -->
   `artemisMode` and `ArtemisProfile` all passed. Found in review, not by me. <!-- scan-allow-persona -->
   The scanner now splits identifiers into words — handling separators and
   case transitions — and compares whole words. All of the above are in the
   self-test's known-positive set; the ordinary English words are in the
   known-negative set.
4. **Whole-file allowlists** exempted `docs/PROVENANCE.md` and the scanner
   itself. A whole-file exemption silently swallows every future mistake in
   that file. Replaced with per-line `scan-allow-persona` markers, so every
   exemption is greppable and countable.

   *Later policy, recorded here so this item is not read as the current rule:*
   path-scoped allowances do now exist, and are enumerated in
   `MANIFEST-v0.1.md` §1. They are narrow in a way the allowlists removed above
   were not — each covers **one category of name in prose only**, never a whole
   file's worth of findings. Secrets, emails, home paths, CJK text and every
   run-together identifier form are still reported in all of these paths.

### Second review round — bypasses found by running the scanner, not reading it

The reviewer ran adversarial inputs against the released tar. Every one of
these wrongly received `SCAN PASS`:

| input | why it passed |
|---|---|
| a real-shaped key on a line carrying a persona marker | the marker did a bare `continue`, so it suppressed **every** category on that line, not just the persona finding |
| `const exampleApiKey = "<real key>"` | a line-wide placeholder allowlist: the word "example" anywhere on the line disabled secret detection for the whole line |
| an all-caps run-together name, and a name split by a digit | word-splitting handled separators and case transitions but not digit boundaries, and never considered run-together forms |
| a key added to `package-lock.json` | the lockfile was skipped **wholesale** rather than only for name noise |
| a default-persona namespace in arbitrary prose | persona rules were applied by file type, not by path policy |
| a legitimate `.env.example` | rejected by the forbidden-path rule, which is a false positive that trains people to disable checks |

Fixes, in the order they matter:

1. **Exemptions are now per line AND per category.** `scan-allow-persona`
   suppresses only the persona finding. Chinese text, emails, home paths,
   private hosts and secrets on that same line are still reported. Two
   adversarial cases lock this in.
2. **Placeholder judgement moved from the line to the matched VALUE.**
   `<your-api-key>`, `$OPENAI_API_KEY` and `changeme` are placeholders; a
   32-character key on a line that happens to contain the word "example" is
   not.
3. **Name matching split by name length.** Long names use case-insensitive
   containment inside identifiers, which catches every run-together and
   digit-separated form. The short default-persona name keeps structural
   matching, because containment would fire on `Partial` and `article` — and
   the manifest now **states that gap** instead of promising coverage the
   scanner lacks.
4. **Lockfiles are scanned** for secrets, home paths, emails and private
   hosts; only the name check is relaxed there.
5. **`.env.example` is allowed by path and fully scanned by content.**
6. **Persona policy is by path**: the default persona is free in `prompts/`,
   requires a marker in governance prose, and is a finding anywhere else.

### The deeper lesson

The scanner's own self-tests passed throughout. They test predicates in
isolation, and **both bypasses were control-flow bugs** — a `continue` in the
wrong place, and a guard evaluated against the wrong scope. No matcher test
could have caught either.

`scripts/scan-adversarial-test.py` was introduced running the scanner end to
end against 22 synthetic trees and asserting the verdict, including that git
mode and directory-walk mode agree. It has grown with each wave since; the
current count is in the verification table at the end of this document. Its probe strings are **assembled from fragments**
rather than written literally, so the repository contains no home path, no
email address and no persona name of its own — the file needs no exemption,
which is stronger than having one.

The scan is reported in four categories rather than one: forbidden tracked
paths, committed symlinks, known private markers (persona and owner names,
absolute home paths, email addresses, private hosts, Chinese text), and
secret-like content (common API-key and token shapes, private key blocks, JWTs,
assigned secret literals). Matched values are **masked** in output; findings
report file, line, and a redacted excerpt only.

This is a pre-flight check, not a guarantee. An independent release-grade
secret scan is still required before the first push to a public remote.

---

## Wave 2

### `core/services/token-estimate.ts`

- **Source:** `core/services/token-estimate.ts` — **category 5**
- CJK ranges rewritten as `\u` escapes so the file is ASCII-only and needs no
  scanner exception. Dropped references to the private runtime's bundled
  dependencies, to one model family, and to an excluded memory subsystem.
- Kept the reasoning that still earns its place: the estimate errs **high** on
  CJK, because over-estimating trims the window early rather than overrunning
  the model. Added an honest caveat that this keeps a budget, not a bill.
- **Scan at import:** clean. Two scanner false positives surfaced here and
  were fixed rather than worked around — see the scanner section.

### `core/services/prompt-loader.ts`

- **Source:** `core/services/prompt-loader.ts` — **contract re-decided, not translated**
- **Kept, rewritten generically:** strict UTF-8 decoding rather than
  replacement characters; typed errors naming the exact file; empty and
  whitespace-only rejection; byte-for-byte content; deterministic order.
- **Rewritten:** a hard-coded six-file list became discovery plus ordering;
  synchronous became async with an options object; paths became relative to
  the prompt root rather than the repository; `sha256` moved from the decoded
  text to the actual bytes.
- **Deleted:** four precompiled chat variants and their membership table; the
  `=== … ===` delimiter protocol; conversation-mode routing; the memory-policy
  accessor; the library description helper. All belong to excluded subsystems.
- **One judgement recorded:** the private module justified its section order
  with a measurement taken against one specific persona. The **order** is kept
  and explained on its own terms — a closing section governs what precedes it
  — but the measurement is not carried over, because it is evidence about
  someone else's prompts.
- Structure is genuinely replaceable: every default section is optional, a
  persona built only from custom sections loads, and no default is re-imposed.
- BOM is stripped from `content` (an encoding artefact would otherwise be an
  invisible first character of the system prompt) while `sha256` still covers
  the bytes on disk. Both halves are tested.

### `core/services/reply-sanitizer.ts`

- **Source:** `core/services/reply-sanitizer.ts` — **nothing survived; written fresh**

| private rule | problem it solved | category | disposition |
|---|---|---|---|
| `stripThinkingBlocks` + marker table | one CLI leaked reasoning containers and echoed runtime context into delivered text | provider workaround **and** excluded subsystems — the marker table is a catalogue of private subsystem names | **deleted** |
| `findBlockEnd` | depth-aware nesting for the above | supporting machinery | **deleted** |
| `stripForeignScaffold` | on one date, one provider appended an instruction scaffold that persisted and re-entered context for 51 turns | provider workaround pinned to one observed shape; the module's own comment says it must not grow | **deleted** |
| trailing `trim()` + newline collapse | tidying the gap left by an excised block | cosmetic, meaningful only with rule 1 | **deleted** |

Keeping any of it to preserve the shape of a migration would have imported
history this product does not have. The public module implements the narrow
scope instead: control characters and terminal escape sequences, nothing else.

Line endings are a **stated contract** — CRLF and lone CR become LF, including
inside fenced code — because replies are stored, compared and hashed, and
identical text must produce identical bytes on every platform.

Tests assert what it must **not** do as well as what it does: HTML and XML are
not stripped, a reasoning container is not removed, a role prefix is not
removed, prose is not rewritten, and the result is not trimmed.

### `docs/ARCHITECTURE-PRINCIPLES.md`

Written fresh. Records the standing ruling that Delos provides **stable
universal sockets**: model connector, memory backend, memory frontend,
surface, identity source and tools each remain replaceable. Also records the
portable-profile direction and the restraint that seams are documented now and
abstracted only when a second real implementation exists.

Consequence for the modules that exist: `prompt-loader` is the **filesystem
identity adapter**, the coming OpenAI-compatible adapter is the **first model
connector**, the recent-context window is a **context strategy and not a
memory system**, and the command line is the **reference surface**.

---

---

## Wave 3

### A word about "removed"

Everything below describes what was **not migrated into the public base
strategy**. Nothing here was deleted from, modified in, or removed from the
private implementation. That was never done and was never authorised.

Verified at the time of writing: the private `core/services/recent-window.ts`
is 4,982 bytes across 144 lines, all eight constructs listed below are still
present in it, and `git status` reports the file unmodified.

Earlier commit messages in this repository used the bare word "DELETED" as a
section heading for this list. That wording was ambiguous and is corrected
here; this document is the authoritative record.

### `core/services/recent-window.ts`

- **Source:** `core/services/recent-window.ts` (144 lines)
- **Category:** 5 (neutral code), heavily re-decided
- **Public role:** a stateless, single-turn context-selection strategy. Not a
  memory backend, conversation database, transcript archive, summariser,
  semantic retriever, session manager, provider context protocol, or
  persistence schema. It defines no shape a future memory system would have
  to inherit.

#### Carried over

| behaviour | why it survives on its own merits |
|---|---|
| pure function, estimator injected | testable without a tokenizer, and replaceable by a real one in one place |
| contiguous newest-first suffix, returned oldest to newest | the only selection rule that keeps the result meaning "recent" |
| `slice()` result, never an alias of the caller's array | a caller's history must not change because it asked a question about it |

#### Not migrated into this base strategy

Each of these exists in the private implementation and remains there. They
are absent from the public base selector, for the reasons given.

| construct | what it solved there | why not here |
|---|---|---|
| `DEFAULT_HARD_RETAIN = 20` | a real adjacent-turn context-reliability incident: a fact stated earlier the same day fell out of the window between turns | unconditional retention **breaks a strict budget**, which is this selector's contract. **Deferred, not discarded — see below.** |
| `DEFAULT_MAX_MESSAGES = 80` | a burst of very short messages inflating the window | a second policy knob outside a single-budget contract. **Deferred, not discarded — see below.** |
| `DEFAULT_TOKEN_BUDGET = 24_000` | a working budget for one deployment | a deployment parameter, not a universal default. **Retained as historical deployment evidence — see below.** |
| `PER_MESSAGE_OVERHEAD_TOKENS = 8` | a specific renderer's structured per-message prefix | one surface's envelope cost baked into a core policy. **Deferred to whoever owns that cost — see below.** |
| `earliestMessageId` / `latestMessageId` | window reporting | approaches cursor and last-seen semantics, which this module must not introduce |
| `boundedByTokens` / `boundedByCount` | diagnostics for which limit stopped growth | redundant metadata beyond the three contracted result fields |

#### Deferred rather than discarded

**Hard retain.** `DEFAULT_HARD_RETAIN = 20` came from a real reliability
incident, not from taste, and the problem it addressed is real: a strict
budget can drop recent continuity that a conversation depends on. It does not
belong in a strict-budget suffix selector, because unconditional retention and
a strict budget cannot both hold.

*Restoration conditions:* a real turn-service consumer that must explicitly
resolve the conflict between a minimum-recent-continuity floor and a
provider's hard context limit, plus synthetic and end-to-end tests. It should
arrive as a replaceable context strategy or a composition-level reliability
policy — **not** as a modification to this base selector.

**Message-count cap.** `DEFAULT_MAX_MESSAGES = 80` addresses something a token
budget genuinely cannot: a very large number of very short messages. A budget
bounds total cost, not cardinality, and some consumers care about the latter.

*Restoration conditions:* a real provider or turn-service configuration that
needs it, or a separate bounded strategy. Not a second knob on this one.

**24k budget.** `DEFAULT_TOKEN_BUDGET = 24_000` is preserved here as
historical deployment evidence: it is a value that worked in practice for one
real instance. It may reasonably appear in example configuration or in a
specific profile. It must not be hardcoded into core again.

**Per-message overhead.** `PER_MESSAGE_OVERHEAD_TOKENS = 8` is a real cost —
some renderer or provider envelope does surround each message. It belongs to
whoever owns that envelope: an adapter, a budget planner, or an estimator that
models it. The base selector charges exactly what the estimator says the text
costs, and nothing else.

**The two id fields and two diagnostic flags** are recorded as metadata not
migrated. If a real consumer later needs to know *why* the window stopped, the
answer is to design a `stopReason` against that requirement — not to restore
these fields pre-emptively.

### Contract decisions made in the public implementation

- **Over-reserving clamps to zero.** `available = max - reserve`, floored at
  zero. Both values are individually readable; only their difference is
  negative, so it is an arithmetic outcome rather than an unusable input, and
  `omittedCount` tells the caller everything was dropped.
- **Unreadable option values throw** `RecentWindowConfigError`: NaN, Infinity,
  negative, fractional. Silently repairing a budget hides the bug in whatever
  computed it, and the symptom — an assistant that quietly forgot the
  conversation — surfaces far from its cause.
- **An oversized message stops the search.** Not truncated, not skipped, and
  no older cheaper message is taken behind it. Skipping would turn a recent
  window into a content-blind sparse sample while keeping the name.
- **Roles do not influence selection.** A window beginning on an assistant
  message is left alone. Reaching back for an older user message to balance it
  would break the budget and bake one provider's format preference into a
  general strategy.

### `tests/recent-window.test.ts`

Written fresh; no private fixture migrated. Most cases inject a stub
estimator so costs are exact and the assertions describe the **selection
rule** rather than the heuristic's arithmetic — testing a policy through an
estimator you cannot predict tests neither.

### Wave 3 review fix — estimator output validation

The first implementation validated the budget options but trusted whatever
the injected estimator returned. A negative cost would let the window grow
without bound; `NaN` makes every comparison false, so nothing is ever
selected; a fraction makes the budget depend on an undocumented rounding
direction. All three corrupt the budget silently.

Every estimator result is now required to be finite, integer and zero or
greater. Anything else throws `RecentWindowEstimateError` and **no partial
selection is returned** — a window built on a corrupt budget is worse than no
window.

The error carries the message index and the offending value, and
**deliberately never the message text**: an error is one of the places
conversation text leaks into logs. A test asserts the text does not appear.

An exception raised *by* the estimator propagates unchanged rather than being
wrapped. It is the caller's own injected code failing, and wrapping would bury
their stack trace under ours while adding nothing. This is stated in the
contract and tested.

---

---

## Wave 4 — the runnable vertical slice

Every module in this wave was **written fresh**. Nothing was migrated. Where a
private counterpart exists it was inspected read-only and is named below;
where none exists that is stated too.

Private Delos was not modified at any point in this wave.

### `adapters/config/filesystem/runtime-config.ts` — local runtime configuration

- **Origin:** written fresh. **No private configuration file, environment
  file, or credential fixture was inspected or migrated.** The private
  implementation's configuration is coupled to a messaging platform and to
  deployment secrets, and none of it is applicable here.
- **Responsibility:** read and validate one small JSON file. It loads no
  prompts, reads no environment, and constructs nothing.
- **Not a Delos Profile.** This is a local runtime configuration for the v0.1
  reference composition. The portable profile described in the architecture
  principles is a different, later artefact, and this format is deliberately
  too narrow to grow into it by accident.

**Decisions worth recording**

- **A credential cannot be written here.** There is no `apiKey` field, and
  `apiKey`, `token`, `password` and `secret` are refused as unknown fields
  with the offending value never echoed into the error. `apiKeyEnv` names an
  environment variable; resolving it belongs to composition. A secret
  therefore never passes through a file this adapter reads or an error it
  prints. There is no `${...}` interpolation and no general environment
  expansion.
- **Unknown fields are refused at every level.** Ignoring them would let a
  typo silently disable a setting, and would let a credential-bearing field be
  quietly accepted and stored on disk.
- **Plaintext HTTP is allowed only to loopback** — `localhost`, the whole of
  `127.0.0.0/8`, and `::1`. A copied example must not be able to send a
  credential unencrypted across a network. HTTPS is unrestricted.
- **A relative `promptRoot` resolves against the configuration file's
  directory**, never the process working directory, so the same file means the
  same thing wherever the command is run from. The resolved path is absolute.
- **`schemaVersion` must be exactly 1.** Another version is a typed failure,
  never a silent reinterpretation.
- **`timeoutMs` defaults to 60000** when absent; when present it must be a
  finite positive integer. Zero, negative, fractional, NaN and Infinity are
  refused.
- **The private 24k window budget was not reintroduced**, and no message-count
  cap or hard-retain setting exists here. Those remain deferred exactly as
  recorded in Wave 3.
- File-level failures are distinguished from schema failures: missing, not a
  regular file, unreadable, invalid UTF-8, invalid JSON, invalid schema,
  unsupported version. A symlinked configuration path is followed by contract
  and by test — the path is what the user typed.
- A leading UTF-8 BOM is treated as an encoding artefact and stripped before
  parsing, consistent with the identity adapter.

**Fixtures:** entirely synthetic. Credential-shaped strings and userinfo URLs
in the tests are assembled from fragments, so the repository contains no such
literal of its own and needs no scanner exemption — the same rule production
code is held to.

**Scan at commit:** four categories clean, SCAN PASS.

---

### `adapters/models/openai-compatible/openai-compatible-provider.ts`

- **Origin:** written fresh. **There was nothing to migrate.** The private
  repository's `adapters/models/openai-compatible/` directory contains only a
  README; the adapter was never implemented there. Its Claude and Codex
  adapters are subprocess-based CLI integrations against a different wire
  contract and were not used as a source.
- **Responsibility:** translate the provider-neutral port into one HTTP wire
  protocol. It is one adapter, not the definition of all future connectors.

**Decisions worth recording**

- **The credential lives only in the object's runtime lifetime.** Composition
  supplies it; the adapter reads no file and no environment variable. A test
  drives five distinct failure paths — including a transport error whose
  message deliberately embeds the key — and asserts it never reaches `detail`.
- **A non-success response body is never read.** An error body can carry
  account identifiers, quota detail, or an echo of the request. The status
  code is enough to classify, and a test plants a marker in a 500 body and
  asserts it does not appear.
- **Transport errors are not inspected for their message**, which can contain
  a resolved address or proxy detail. They become one neutral sentence.
- **Only `choices[0].message.content` as a string is supported.** Content-part
  arrays, tool calls without text, and multiple simultaneous replies are
  refused as `invalid_response` rather than half-supported — guessing at an
  unfamiliar shape is how a caller ends up believing it received an answer it
  did not.
- **`servedModel` comes from response metadata only**, never from generated
  prose, carrying the port's rule into the first real implementation.
- **No retries.** A retry can duplicate a paid request, duplicate
  non-idempotent provider state, and hide the original failure. Retry policy
  belongs to a later caller. A test asserts exactly one request per `generate`.
- **No invented parameters.** A test asserts the payload keys are exactly
  `model`, `messages`, `stream`, and that the headers are exactly
  `Content-Type` and (when a key exists) `Authorization`. No temperature, no
  sampling defaults, no tools, no response-format, no client identification.
- **`conversationId` and `turnId` are not smuggled into the payload**; a test
  asserts neither string appears in the serialised body.
- **URL joining normalises only the boundary slash.** A missing `/v1` is not
  guessed and a full chat-completions URL is not reinterpreted as a root —
  either would make the configured value mean something the user did not write.
- **Construction never throws.** An unusable configuration produces a provider
  whose `generate` returns a `configuration` failure, so every failure reaches
  the caller through the single channel the port defines. A test asserts fetch
  is not called in that case.
- The timeout uses an `AbortController` local to one request. The port has no
  caller-supplied cancellation signal and was not expanded to pretend it does.

**Fixtures:** entirely synthetic; `fetch` is always injected and no test
reaches a network. The test key is assembled from fragments so the repository
holds no credential-shaped literal.

**Scan at commit:** four categories clean, SCAN PASS.

---

### `core/services/turn-service.ts`

- **Origin:** written fresh. The private `core/services/chat-service.ts` was
  inspected read-only and **deliberately not used as a source**: it imports six
  ports and thirteen services — retrieval, proactive behaviour,
  conversation-mode routing, current-situation state, requested history,
  delimiter guarding — every one of which is excluded from v0.1. Reducing it
  would have meant carrying its assumptions; this is a smaller thing that only
  composes what already exists here.
- **Responsibility:** run one turn. Select history, put the current message
  last, ask the provider, sanitise the reply, return a safe outcome.

**Excluded private mechanisms:** no storage, session lookup, transcript port,
memory port, current-situation state, retrieval, routing, proactive
behaviour, tool execution, provider registry, or surface knowledge.

**Decisions worth recording**

- **It does not own the conversation.** No history is held, appended to, or
  persisted; the caller supplies what it wants considered and decides what a
  success does to its own record. A test drives two turns with different
  history and asserts neither influenced the other, and another asserts the
  service does not accumulate.
- **The current message is appended after selection**, so the recent-window
  budget can never drop it. A test runs with a zero budget and asserts the
  current message still arrives.
- **The prompt bundle is assembled once, at construction**, into a plain
  string. Nothing downstream keeps a filesystem path or knows where the
  identity came from, so a bundle from an editor or an imported profile works
  identically.
- **Provider `detail` is not surfaced.** It is safe operator text, but it is
  written for someone reading a log, not for whoever is having the
  conversation. Every `ModelErrorKind` maps to one stable, provider-neutral
  sentence; a test iterates the imported `MODEL_ERROR_KINDS` — not a copy — and
  asserts the raw detail never appears and the wording mentions no transport.
- **An unexpected provider throw becomes one generic safe failure.** A
  compliant provider returns a result, but a faulty injected one may throw,
  and the thrown value can carry a URL, a header or a request body. It is not
  inspected. A test plants a marker in the thrown message and asserts it does
  not surface.
- **No failure path returns raw model text.** A reply that sanitises to
  nothing becomes "no usable text"; a test plants a marker inside a terminal
  control sequence and asserts it is not echoed.
- **Blank current input is rejected before the provider is called**, so an
  accidental blank line never costs a request, and the rejected text is not
  echoed back.
- **Non-empty user text is preserved exactly**, including surrounding
  whitespace — trimming would silently alter what the user wrote.
- **No retries.**

**Also in this commit:** the stale `ChatMessage.messageId` comment claimed the
recent-window module "renders it as structured provenance". It does not — the
strategy selects and preserves messages and renders nothing. The description
was corrected; the field was not removed.

**Fixtures:** entirely synthetic, provider always stubbed, no network.

**Scan at commit:** four categories clean, SCAN PASS.

---

### `composition/create-runtime.ts`

- **Origin:** written fresh. The private CLI composition root was inspected
  read-only and not used as a source: it wires memory adapters, projection
  stores, transcript archives and platform adapters, all excluded from v0.1.
- **Responsibility:** be the one production place that knows configuration,
  prompt loading, credential resolution, the concrete adapter and turn-service
  construction at the same time. Every other module knows one thing.

**Decisions worth recording**

- **No framework.** There is one provider kind, so there is one branch. No
  dependency container, provider registry, plugin manager, service locator or
  lifecycle framework was built, because a generic mechanism with one
  implementation is a cost with no benefit.
- **Only the named environment variable is read.** A test installs a `Proxy`
  whose `ownKeys` trap throws and asserts exactly one key was read — so
  enumeration is not merely avoided by convention, it is proven.
- **A missing credential names the variable and never prints a value.** Naming
  the variable is what helps a user; printing what was found in it would put a
  credential on a terminal. A test plants an unrelated secret in the injected
  environment and asserts it never appears.
- **Configuration and identity failures are not re-wrapped.** They already
  carry typed kinds and safe messages, and wrapping would bury the field name
  or file path that makes them useful. `RuntimeStartupError` exists only for
  failures that originate in composition itself.
- **Startup is all-or-nothing.** Everything that can fail cheaply happens
  before anything is constructed, so there is no partially initialised runtime
  to clean up. A test forces a late failure after the credential resolved and
  asserts nothing was returned and the credential did not surface.
- **The runtime surface is deliberately small** — a turn service and `close()`.
  A test asserts those are the only keys: no configuration object, no provider
  internals, no credential, no filesystem adapter reaches a surface.
- **`close()` is idempotent.** A surface may call it from both a normal exit
  path and an interrupt handler; double-closing a provider is not its problem.
  What the test proves is exactly that — repeated `close()` is safe. It does
  **not** prove an underlying provider is closed exactly once, because the only
  provider v0.1 builds holds no closeable resource and implements no `close()`,
  so there is nothing to count. See the correction in *Wave 4 review fix*.

**Fixtures:** environment and `fetch` are both injected; every file is written
to a fresh temporary directory. No test reads the real environment or a
network.

**Scan at commit:** four categories clean, SCAN PASS.

---

### `surfaces/cli/run-cli.ts` and `surfaces/cli/main.ts`

- **Origin:** written fresh. The private CLI was inspected read-only and not
  used as a source; it wires excluded subsystems and carries platform-specific
  behaviour.
- **Responsibility:** `run-cli.ts` owns arguments, the interactive loop, and
  process-local history, with every external thing injected. `main.ts` is the
  only file that touches the real process — streams, environment, working
  directory, identifiers, clock, exit code.

**Decisions worth recording**

- **The surface owns nothing beneath it.** It builds no provider payload,
  parses no response, sanitises nothing, reads no prompt file, and makes no
  context-selection decision. A web or desktop surface would replace
  `run-cli.ts` and nothing under it.
- **Everything external is injected**, so the whole surface is testable
  without a terminal, a network, or the real environment. The mutable
  `process` object is never passed into core or adapters.
- **`runCli` returns an exit code instead of exiting**, keeping the process
  boundary in one thin entry point.
- **One-shot prints the reply and nothing else** — no banner, no identifiers,
  no configuration echo — so the output is usable in a pipe. A test asserts
  stdout is exactly the reply.
- **Exactly one implicit configuration location:**
  `./delos.config.json` beside the working directory. Parent directories, home
  directories and other conventional spots are not searched, because magical
  discovery means a user cannot tell which file is in effect.
- **Unknown and duplicate arguments are refused**, since a silently dropped
  flag looks exactly like a flag that did nothing.
- **A failed turn is not appended to history.** Remembering it would replay a
  question that was never answered as though it had been. A test asserts the
  second request carries only the new question.
- **History is process-local and is never written anywhere.** A test snapshots
  the working directory before and after a two-turn session and asserts no
  file appeared.
- **Labels are neutral** (`you>`, `assistant>`). The persona is content and may
  be renamed or replaced; a surface that printed its name would make that
  false.
- **No secret reaches a stream.** A test drives success, an authentication
  failure and a malformed response with the credential present, and asserts it
  appears in neither stdout nor stderr. The missing-credential message names
  the variable and prints no value.

**Not added, deliberately:** persistent shell history, transcript files,
memory files, configuration or persona editors, Markdown rendering, colour
frameworks, streaming, tool commands, model switching, hidden admin commands,
network diagnostics, retries.

**Package metadata:** a `bin` entry and a `start` script were added, `engines`
declares `>=22.0.0` honestly because the adapter depends on the runtime's
built-in `fetch`, and `private: true` is preserved while the repository is
staging.

**Fixtures:** entirely synthetic; streams, environment, working directory,
identifiers, clock and `fetch` all injected.

**Scan at commit:** four categories clean, SCAN PASS.

---

### `tests/vertical-slice.e2e.test.ts` — synthetic end-to-end proof

- **Origin:** written fresh. No private test fixture, transcript, or recorded
  provider exchange was used.
- **Responsibility:** prove the whole configured path is wired, from a JSON
  file to a printed reply, without calling anything real.

**What it proves, and what it does not.** The provider is an HTTP server bound
to `127.0.0.1` on an OS-assigned port, created per test and closed after it.
**No external network is used, no vendor is contacted, and no real credential
exists.** These tests therefore say nothing about whether Delos works against
any particular vendor — only that the path is connected and the boundaries
hold. That claim is not made anywhere in the repository.

The primary test spawns the **real compiled CLI** as a child process, so the
assertions are made from outside the program rather than about its internals:

- the process exited zero and stdout was exactly the sanitised reply;
- the reply arrived carrying CRLF and a terminal colour sequence, and neither
  survived — sanitisation is demonstrated by the output, not asserted about;
- the credential travelled only in the `Authorization` header, and appears in
  neither the request body, stdout, nor stderr;
- the system prompt came from the temporary prompt directory;
- the current user message was last, the configured model was sent, and
  `stream` was false;
- nothing was written beside the configuration.

**Five bounded failure paths**, each deterministic and offline: a missing
credential variable (asserting **no request is made at all**), a 401 whose body
carries a planted marker that must not surface, a malformed success body, a
provider that never answers against a 300 ms deadline, and a missing prompt
root. *Wave 4 review fix* adds six more, including three child-process
interrupt tests.

**The interactive proof** runs through the injected CLI I/O layer rather than a
pseudo-terminal, and asserts the second request carries the first user and
assistant messages as history.

**Fixtures:** synthetic English strings chosen not to resemble conversation
material. The credential is assembled from fragments.

**Scan at commit:** four categories clean, SCAN PASS.

### Documentation

`README.md` no longer says a runnable conversation path does not exist,
because one does. It gains a quickstart, a field-by-field configuration table,
and an explicit **Honest limits** section: no persistent memory, estimated
rather than exact token counts with advice to choose a conservative budget, no
streaming, no tools, no retries, one provider kind.

`MANIFEST-v0.1.md` gains an implementation-status section stating that the
minimum vertical path exists and runs locally **and is not released** — no
remote, nothing pushed, no package published, release gates not run.

`docs/MIGRATION-PLAN.md` no longer claims nothing has been migrated. It now
points to this file as the record and keeps its original planning rationale
unchanged, including the reasoning for writing Wave 4 fresh, because that
reasoning is what makes the result reviewable.

---

## Wave 4 review fix

An independent review of the Wave 4 artifact found four runtime safety gaps and
one over-claim. All five are closed here. No feature was added, and no wave was
started.

### A malformed configuration no longer echoes itself

`JSON.parse` describes a fault by quoting the document around it. Measured on
the runtime this was written against, it quotes about ten characters, or the
**whole document** when the document is short:

```text
JSON.parse('{"apiKey": PASTED-KEY-0123456789abcdef}')
  -> Unexpected token 'P', ...""apiKey": PASTED-KEY"... is not valid JSON
```

(The placeholder above stands in for a real credential. This repository holds
no credential-shaped literal anywhere, including in illustrations — the
scanner caught an earlier draft of this very paragraph, and the fixture was
rewritten rather than exempted.)

That message was being concatenated into the configuration error, so a key
pasted into the file instead of into an environment variable would reach the
terminal. A ten-character prefix is still a leak: it is enough to identify a
key and often which service issued it.

The parser's message is now never used. The error is a fixed phrase, an
optional location made only of digits, and the path the user gave. The location
is extracted with a pattern anchored to the end of the parser's message, where
the runtime writes its own counters; each captured group is re-rendered from a
parsed integer rather than copied as text, so no substring of the parser's
message can survive into the result. When the position cannot be read that way
it is omitted — a missing line number is a smaller loss than a leaked one.

Tests plant a key-shaped value in five malformed documents and assert that
neither the value **nor its first ten characters** appear, that no property
name appears, and that the message matches a shape no document text can pass.
One test drives the **real compiled CLI** and makes the same assertions about
its actual stderr.

### The CLI no longer forwards an arbitrary error message

`startupMessage` returned `.message` from any `Error`, which is a contract only
the errors this project writes actually keep. Startup formatting now lives in
composition, which already knows which adapters exist:
`describeStartupFailure` recognises exactly three types —
`RuntimeConfigError`, `PromptLoadError`, `RuntimeStartupError` — each because
its message contract is documented at its definition and names files, fields,
section names and environment-variable *names* only. Everything else becomes
`Delos could not start.`

Recognition is by type, not by shape: a test throws an object carrying
`name`, `kind` and `message` and asserts it is still treated as unknown. The
CLI does not import any concrete adapter error type, and no error framework was
built — one list of three, and a default.

### The deadline covers reading the reply

The timer was cleared as soon as `fetch` resolved, which is before the body has
been read. A provider that returned `200` and then stopped sending would hold
the caller for as long as the socket stayed open — and the body is the part of
a response most likely to stall.

One request-scoped `AbortController` and one timer now cover sending the
request, awaiting the status, reading the body, and parsing the response shape.
The timer is cleared in the outermost `finally` and nowhere else, so no early
return can leave it armed or disarm it early. A body read that ended because
the deadline aborted it is reported as `timeout`; a body that was genuinely
malformed is still `invalid_response`. No retry was added, the `ModelProvider`
port is unchanged, and no caller-cancellation was faked.

Proven at the adapter (a stalled body returns `timeout` promptly rather than
hanging; a malformed one and a stalled one are told apart; a slow-but-complete
body still succeeds; the captured signal is **not** aborted long after a
successful read, which is how the timer is shown to have been cleared) and end
to end (a loopback server sends headers and the opening of a JSON body, then
stops; the real CLI fails inside the configured 400 ms deadline with the
deadline wording rather than the unsupported-response wording).

### A full endpoint in `baseUrl` is refused

`provider.baseUrl` is an API root. Configuring `/v1/chat/completions` there
would have made the adapter request `/v1/chat/completions/chat/completions`.
Configuration now refuses any URL whose path, after trailing slashes are
normalised away, ends in `/chat/completions`, and says what to write instead.
It is refused rather than silently repaired, because a value that is quietly
rewritten no longer says what it does. The adapter strips **every** trailing
slash before appending its path, so `/v1`, `/v1/` and `/v1///` reach one URL.
`/v1` is still never guessed. Query strings, fragments and embedded credentials
are refused exactly as before.

### Ctrl-C shuts down instead of killing

A narrow process-level handler in `surfaces/cli/main.ts`, and nothing in core.
The first interrupt ends the input wait and lets `runCli` unwind through its own
`finally`, which closes the runtime; the process then exits `130`. The handler
removes itself, so a **second** interrupt falls through to the runtime's default
termination — the escape hatch when a request is inside a long deadline. The
listener is also removed in `finally`.

An in-flight request is **not** cancelled. The model port has no caller
cancellation, and pretending otherwise would mean reporting a request as
abandoned while it was still running. Delos waits for it to answer, fail, or hit
its deadline. That contract is stated in the README and in the handler.

Three child-process tests: an interrupt at the prompt exits `130` with signal
`null`, no stack and no credential on stderr; an interrupt during a request
still prints that request's reply before exiting `130`; a second interrupt
terminates with signal `SIGINT`. The exit code is itself the cleanup evidence —
`130` is written on the last line of `main()`, reachable only after `runCli`
returned, and `runCli` returns only through the `finally` that closes the
runtime.

### The lifecycle claim is corrected

The test named "close is idempotent and closes the provider exactly once"
proved only the first half. The v0.1 provider holds no closeable resource and
implements no `close()`, so there is nothing to count.

The test is renamed to what it shows — repeated `close()` is safe — and a
second test asserts `provider.close === undefined`, stating the limitation as a
fact that will fail the day an adapter grows a `close()`. No provider registry,
DI container or test-only production API was added to manufacture a count;
that machinery would exist to make an assertion true rather than to make the
program work. **The exact-once lifecycle test belongs with the first adapter
that really holds a resource** — a connection pool, a socket, a child process —
and should be written against that implementation.

---

## Wave 5 — Design Notes replacement and release-candidate preflight

### The Design Notes

`docs/DESIGN-NOTES.md` was replaced with the owner-approved short version,
installed byte-for-byte from the authoritative source rather than retyped.

```text
sha256   f2099ab5c19395de9894d4d06dc3c3fd6a8efba28cfaa3e8005974b03d866292
bytes    6435   (was 26664)
lines    125    (was 845)
```

The superseded 845-line draft remains in this repository's history; it was
replaced, not expunged. Nothing in this repository had been published at that
point.

### The scanner policy correction that made it possible

The document cannot explain where the public names came from without saying
them, and it ends with an owner byline carrying names the scanner forbids
everywhere. Two narrow corrections rather than one broad one:

- the existing persona-prose path allowance (`prompts/*.md`) now also covers
  `docs/DESIGN-NOTES.md` — **public** names only; private names and secrets are
  still refused there;
- the byline is permitted as **one exact line in one exact file**, so any other
  occurrence of a private name in that file, and the same line in any other
  file, both still fail.

No marker comment was added inside the document. Six adversarial cases attack
the relaxation, four of them specifically trying to smuggle private material
through it; the suite went from 27 cases to 33.

`MANIFEST-v0.1.md` previously claimed exemptions were "per line, never per
file" with "no whole-file allowlist". That was already inaccurate before this
wave — `prompts/*.md` has always been a path-scoped allowance — and this wave
made it more so. It now states all three exemption kinds and gives both
commands needed to enumerate them. `docs/MIGRATION-PLAN.md`'s enumeration of
files permitted to carry a persona name gained `docs/DESIGN-NOTES.md`.

### Corrections found by the preflight audit

- `scripts/scan-adversarial-test.py` was described in the present tense as
  covering 22 synthetic trees; that was its size when introduced. Re-anchored
  to the past, with the current count left to the verification table.
- "The two id fields and three diagnostic flags" named three where the table it
  summarises lists two (`boundedByTokens` / `boundedByCount`). Corrected.
- The verification table gained a column for this candidate, so the record no
  longer stops at the previous tip.

### Open items recorded, not resolved

Three findings need owner authority and were deliberately left alone, because
each would require either legal drafting or a history rewrite:

1. **No copyright holder or licensor was named anywhere.** The noncommercial
   boundary itself *was* already established — `LICENSE` is the official,
   unmodified PolyForm Noncommercial 1.0.0 text, and `package.json` carries the
   matching SPDX identifier — so the Design Notes sentence about commercial use
   was not load-bearing. But the licence defines the licensor as "the
   individual or entity offering these terms", and no such party was identified
   in the repository, so `LICENSE-NOTES.md`'s instruction to "Ask" for
   commercial permission had no addressee.
   **Resolved in Wave 5.1** — `LICENSE-NOTES.md` now names the licensor and
   gives the contact route, and `README.md` names the same party.
2. **The superseded Design Notes draft is reachable** in this repository's
   local history.
3. **Commit metadata.** Every commit carries a hostname-derived identity, and
   one commit subject names a private reviewer.

Items 2 and 3 are fixable only before a first push, and only by rewriting
history.

---

## Verification

Run against a clean `git archive` export of the commit under review, never
against a working tree.

Each column is the state at that milestone, not a running total. The rightmost
column is the current candidate; the others are closed milestones and are left
as they were recorded.

| check | Wave 1 | Wave 2 | Wave 3 | Wave 4 | review fix | Wave 5 | Wave 5.1 | Wave 6 |
|---|---|---|---|---|---|---|---|---|
| `npm run typecheck` | clean | clean | clean | clean | clean | clean | clean | clean |
| `npm test` | 12 pass | 70 pass | 117 pass | 240 pass | 264 pass | 264 pass | 264 pass | **264 pass** |
| of which end to end | — | — | — | 7 | 13 | 13 | 13 | **13** |
| scanner self-test | ok | ok | ok | ok | ok | ok | ok | ok |
| scanner adversarial suite | 22 cases | 27 cases | 27 cases | 27 cases | 27 cases | 33 cases | 41 cases | **43 cases** |
| `scripts/scan.py` full scan | SCAN PASS | SCAN PASS | SCAN PASS | SCAN PASS | SCAN PASS | SCAN PASS | SCAN PASS | SCAN PASS |
| `npm ci` from the lockfile | — | — | — | 3 packages, exit 0 | 3 packages, exit 0 | 3 packages, exit 0 | 3 packages, exit 0 | 3 packages, exit 0 |
| tracked files | — | — | — | 44 | 44 | 44 | 44 | **45** |
| private implementation | unchanged | unchanged | **unchanged, verified** | unchanged, verified | unchanged, verified | unchanged, verified | unchanged, verified | **unchanged, verified** |

The adversarial suite grows when the scanner's policy changes; each increase is
recorded in the wave that caused it. Wave 5.1 reclassified the authorship names
as public and added attacks on the new rule; Wave 6 added the release notes to
the attribution set.

---

## Public history identity normalization

Before the first push, every commit in this repository was rewritten to
replace a hostname-derived commit address with a deliberate public identity.
**Only the author and committer identity changed.**

### Why

Every commit carried an auto-generated local address derived from the
machine's hostname. It was never a routable mailbox, but it embedded a
personal machine name in metadata that no tracked-file scan can reach and
that a push would publish permanently. The commit identity is now the
project's GitHub noreply address for the `Gwendolenmave` account.

**No public history had ever been pushed.** At the moment of the rewrite the
repository had no remote, no remote refs, no tags and no push refspec, and
nothing had been published. This was therefore the last moment at which the
change was free, and the first at which it was necessary.

### What did not change

Verified mechanically for all 27 commits before the rewritten refs were
adopted, by pairing old and new commits on a content key of tree, author
date, committer date and message, and requiring a perfect bijection:

| property | result |
|---|---|
| every tree | identical, 27 / 27 |
| every parent relationship | old parents map exactly to new parents, 27 / 27 |
| every author date | identical, 27 / 27 |
| every committer date | identical, 27 / 27 |
| every commit message | byte-identical, 27 / 27 |
| branch topology | `master` 26 commits; `wave2-wip` still 1 commit outside it |

Specifically retained, by owner ruling:

- **The Wave 1 review credit.** The subject
  `fix(v0.1): Wave 1 review fixes from Amelia code review` is unchanged. It
  is intentional project attribution, not private material, and the
  tracked-tree name policy does not retroactively govern it.
- **The superseded long Design Notes.** The 845-line, 26,664-byte draft
  (blob `4a3c56866e7efce3f3ae0baa5989cac0a45797d9`) remains present in the
  historical commits that carried it. It is approved public project history.
  The canonical current `docs/DESIGN-NOTES.md` remains the owner-approved
  6,435-byte short version.
- **`wave2-wip`.** Rewritten for identity like everything else, still one
  commit outside `master`, still carrying tree content identical to the
  canonical implementation that superseded it.

### Authorship, by owner ruling

The project's public author identity is **Gwendolen**, who is also its
copyright holder, licensor and maintainer; see `LICENSE-NOTES.md`. The Design
Notes byline naming both Gwendolen and Amelia is intentional public
authorship credit and is not to be removed.

The release scanner was changed to match: authorship names are permitted as
standalone words in the four attribution documents (`README.md`,
`LICENSE-NOTES.md`, `docs/DESIGN-NOTES.md`, `docs/PROVENANCE.md`) and refused
everywhere else. The manifest's naming principle is unaffected - an
authorship name may still never become a namespace, and every run-together
identifier form is still refused in every file including these four.

### Recovery

A complete pre-rewrite bundle of both branches was created, verified,
cloned-from, and archived privately **before any ref was moved**:

```text
DELOS-PUBLIC-V01-PREPUBLIC-HISTORY-BACKUP-01.bundle
sha256  7fa85586f75e7212bc8806348fbfe2d9adbee29a9830b0268bdb27d5c1ac26ad
bytes   202403
```

It is a **private recovery artifact**. It is not a release artifact, and it
must never be placed in this repository or on a public remote.

### Two kinds of commit ID

Every review checkpoint produced during Waves 1-5 necessarily quotes the
commit IDs that existed when it was written. Those artifacts were not
rewritten, because doing so would make them claim to have been generated from
commits they never contained.

- **Pre-publication audit ID** - the ID a Wave 1-5 checkpoint quotes. Valid
  only against the private recovery bundle above.
- **Canonical public-history ID** - the ID after normalization. This is what
  the repository contains and what any future remote would carry.

No document in this repository quoted a commit ID before this section
existed, so no prose needed correcting; nothing was silently replaced.

### Complete map

| pre-publication audit ID | canonical public-history ID | subject |
|---|---|---|
| `a9d5933ee47ef9f2a8b19bbed4098afc5c38739b` | `fe770b21faf012d32a84b72502915d6dbae62a40` | chore: v0.1 inclusion manifest, migration plan, and default persona |
| `516b4c3585baf17db834db389a6c2a60b7930bf3` | `05670da96cbeb181f1cf7d51a75600cf13f5907d` | feat(core): Wave 1 - domain types and model-provider port |
| `999cbf415432d8d88ea45ba8c7c3bce050d2d17d` | `5b0a6a57b493dd4469451445ebd359f11d49176e` | wip(core): Wave 2 module 1 - token estimator |
| `814ed24e9edd835698ecdb350878c94eb00cd09a` | `0b70ccfa03ce88bd13821efc109fb1503f44aa65` | fix(v0.1): Wave 1 review fixes from Amelia code review |
| `75d4a65e668bd9187bae8886fab2962ebffa8b8a` | `f5874605ea6d4c36160cbb6376015a5c1c77707a` | fix(scanner): harden against the bypasses found in review |
| `cd642a6d07c53a8bae6ee4b745d4ebe5f2fd65b6` | `477cbadb36ec36042411d86d9cbb24a6a9cc47de` | chore: Wave 1 housekeeping |
| `85178638f9ceec0595e192efd80c1d4c7b970ac9` | `378029ee4f0f7309e3286a6adcad13dc8ee0a624` | feat(core): Wave 2 module 1 - token estimator |
| `cf7de0a3598054b424b273106ecdbaee827a5e26` | `bace6fab1ccdbe1a82a9af43226371d39d3b5dbd` | content(prompts): update the default identity section |
| `34089e90bb7c660b03982b368a5a42b1a006c1bc` | `493eb5bbedd690ce91004e349384a25f1e7a386a` | feat(core): Wave 2 module 2 - prompt loader |
| `72cefc6b4c8cf6c1b213b4c71907fea166500a1b` | `8510f2823c03563edb8e3b85641455eb87306857` | feat(core): Wave 2 module 3 - reply sanitizer |
| `c17dade34f390fa62d331cfc155569e52bf6b4a4` | `7c901951caaa029883f17a06fda1625a1b850711` | docs(provenance): record Wave 2 migrations and dispositions |
| `7a08cb1d7c0daa14501a8a32391b99c0c30c08bd` | `720d732c3a8339ae1c80aa6df513cda13e50bd67` | fix(v0.1): Wave 2 review fixes - decouple identity source from core |
| `ffdfe47fe7f8ccfeb339ef81c1f879e5956ba460` | `4b3058fd647d1fc6840e885cf581851b3e872df1` | docs(governance): licence, contribution and succession policy |
| `989c6fb67db7fc326cc004aad5c67e72b7cc5e4c` | `297f61c560eebc64f377e68411ac58828df766bb` | docs: add Delos design notes |
| `735c9769df3e3cd479562e71e9d933d1d64ea295` | `8d5edbdf03dcf5fb04c6842667e07c5df3e9837d` | feat(core): Wave 3 recent context window |
| `d8c2c8e42d9b9db2d7d497d756e68d6d71392649` | `46475292651d453803e01c02da2ed12c21f90e01` | fix(core): complete Wave 3 provenance and estimator validation |
| `4cd9eee884508f1d6188a1b375ef4738bbf5072d` | `7466ff05a5fb3d4cfb9fe6f2ce6f358d3a9afcdc` | feat(config): add local runtime configuration |
| `c6963ddef7a8de5fe03980dd23b7b996deef1a57` | `2c76e1033bbb524950d80b38fc782b18c2959d4d` | feat(adapter): add OpenAI-compatible model provider |
| `c5eb8014f9bff849150538e012078ce4c7b67572` | `351defb619da1bff36fe42be0f0d89d1223ac5d2` | feat(core): add thin turn service |
| `9079c6ad2acd043257750397446fea14d732b23a` | `adda3310e795e77f6d85bad4c8df6ef689507b87` | feat(runtime): compose the v0.1 local runtime |
| `366d30b24e543813bde28ef1797640e16522c010` | `d9e379e92256f1cd0e42b40cb16cb659d9fbcf47` | feat(cli): add the reference conversation surface |
| `5203318719d9e314c0ded8649d82d15a02054fb8` | `c1cbabc8bb23d3e1e14d17f222165421ba754364` | test(e2e): prove the configurable conversation path |
| `902457377b550fc1397df980714be3209de83988` | `3b45d1a77812841dfcce2d1706cc93938babe8e8` | docs(v0.1): document the runnable vertical slice |
| `b534096720168d921c9feb79423ab2828b7f03a0` | `7c569e017eee572936681cc548633c40745d2b46` | refactor(v0.1): close Wave 4 architecture findings |
| `496a50882c385fc5b8f59ac6b78df95621e069e7` | `fedb9d97111e6337a9279506402c91c93c23be7a` | fix(v0.1): close Wave 4 runtime safety gaps |
| `880839ded842d7b6582bf636ab47b4eb9a1722c1` | `707e4852e27f5aa32a7c27130774690e78817529` | docs(design): replace the long-form design notes |
| `2aad7a756b0acc35c392a8e34194c336d310f404` | `469489c684d95ea698515dce10002f2d3735c9c3` | chore(v0.1): close release-candidate preflight findings |

Branch tips:

```text
master     2aad7a756b0acc35c392a8e34194c336d310f404
        -> 469489c684d95ea698515dce10002f2d3735c9c3
wave2-wip  999cbf415432d8d88ea45ba8c7c3bce050d2d17d
        -> 5b0a6a57b493dd4469451445ebd359f11d49176e
```

The release-closure commit that carries this section sits on top of the
rewritten `master` and has no pre-publication counterpart.
---

## Wave 6 — source release closure

Preparing the first public source release. **No runtime code, test, prompt,
provider contract, CLI behaviour, dependency or architecture document was
changed**, and `LICENSE` and `docs/DESIGN-NOTES.md` are byte-identical.

### Version closure

`0.1.0-dev` became `0.1.0` in the three places the ROOT project version
appears — `package.json` and the two root entries of `package-lock.json`. No
dependency version moved and dependency resolution was not regenerated; the
lockfile diff is those two lines and nothing else. `"private": true` is kept:
v0.1 is a source release and is not published to any registry.

### Current-facing language

Statements that would have become false the moment the repository was published
were corrected. Historical milestone records were left in the past tense —
where a Wave 1-5 record describes what was true then, it still says so.

| where | was | now |
|---|---|---|
| `README.md` status block | "pre-release staging … not released" | v0.1 source release; build locally; no tag, no published package |
| `MANIFEST-v0.1.md` header | "staging. No public remote is configured. Nothing has been pushed." | v0.1 source release candidate; no tag, no npm package |
| `MANIFEST-v0.1.md` §0 | "It is not released. The repository remains staging…" | no release tagged, no package published, source only |
| `MANIFEST-v0.1.md` §7.4 | local commits are "ordinary, discardable review history" | true before publication; from the first published commit the history is public and permanent |
| `docs/PROVENANCE.md` Wave 5 | "Nothing in this repository has been published." | anchored to that moment |
| `docs/PROVENANCE.md` Wave 5 open item 1 | "No copyright holder or licensor is named anywhere." | marked resolved in Wave 5.1, with the original finding preserved in the past tense |

The README's pointer for release gates named `MANIFEST-v0.1.md`; the gate
checklist is in `docs/MIGRATION-PLAN.md`, and the manifest itself said so. The
README now points where the gates actually are.

Two counts that had already gone stale were removed rather than re-stated:
`MANIFEST-v0.1.md` no longer quotes a number of adversarial cases, because the
suite prints its own count when run. The Verification table gained Wave 5.1 and
Wave 6 columns.

### Release notes

`RELEASE-NOTES-v0.1.md` is new, and is the only added file. It states what v0.1
is, what it is **not** — no persistent memory, no Mnemosyne governance, no
Anamnesis retrieval, no Muse routing, no web/desktop/messaging interface, no
hosted infrastructure, no npm distribution — where to find installation
instructions, the licence and licensor, and briefly why the architecture is
shaped the way it is. It duplicates neither the README nor the Design Notes.

Because it names the licensor, it joins `README.md`, `LICENSE-NOTES.md`,
`docs/DESIGN-NOTES.md` and `docs/PROVENANCE.md` as an attribution document in
`scripts/scan.py`. The rule is unchanged in kind: authorship names are allowed
there as **standalone words only**, so every run-together identifier form still
fails, and two adversarial cases were added to hold that.

### Release archive

A deterministic source archive is produced from the canonical commit for
review. It is **not** the npm tarball — the package stays private — and it
remains a private artifact until an explicit publication work order.

---

## Wave 7a — provider and secret foundation

Development on `wave7a-provider-foundation`; canonical `master` untouched.
Everything below was **written fresh** against public documentation; no private
source was consulted or copied.

### What was added

- `core/ports/secret-store.ts` — credentials as a port; four-outcome lookup
  contract (not_configured / unavailable / lookup_failed / found); stores at
  `adapters/secret-store/` (environment-backed, never enumerating; in-memory,
  never persisting). The directory is not `adapters/secrets/` because
  `.gitignore`'s `secrets/` guard is worth more than the tidier name.
- `core/domain/provider-profile.ts` — versioned non-secret profiles; four
  kinds; auth split into source × transport; structural refusal of any
  credential-named field at any depth; forbidden-header and control-character
  rules; documented timeout bounds. No token-prefix validation anywhere.
- `core/services/redaction.ts` — central redaction: known values plus shape
  rules (auth headers any casing, Bearer any casing, URL userinfo, credential
  query params), across nested error causes.
- `adapters/providers/` — shared HTTP spine (one deadline over send + status +
  body + parse; caller cancellation distinguished from timeout; error bodies
  never read) and four adapters. **Protocol choice recorded:** official OpenAI
  speaks the Responses API; the compatible adapter speaks chat completions;
  Anthropic speaks Messages natively (x-api-key, top-level system, managed
  anthropic-version, required max_tokens) and is never emulated over OpenAI.
- `adapters/providers/registry.ts` — profile in, provider out; per-call
  credential resolution through the store; credential-missing distinct from
  credential-unavailable distinct from connection-failed; no global state.
- `core/services/provider-bridge.ts` — maps the rich contract onto the legacy
  `ModelProvider` port, so the turn service and its tests are unchanged.
- `core/services/connection-test.ts` — probes through the real generate path;
  the probe reply is discarded by design.
- Configuration schemaVersion 2 (profiles + defaultProvider) beside a fully
  preserved v1; CLI `--provider` and `--test-provider`.

### Numbers

348 tests (264 preserved + 84 new), 53 adversarial scanner cases (was 43),
SCAN PASS. Two scanner gaps were found by the new attacks and closed:
key-named assignments of long opaque values, and auth-header lines in
fixtures. The placeholder grammar gained exactly the two reference namespaces
(`provider:`, `env:`) and nothing else.

### Known defect, recorded for review

The commit messages of `783108a` and `46b22a1` are damaged: words that sat in
backticks were eaten by a shell-quoting failure during commit, and the second
message is truncated mid-sentence. The commit discipline for this work order
forbids amend and rewrite, so they stand as committed. The full intended
messages are preserved in the Wave 7a checkpoint, and a message-only repair
before any fast-forward of `master` is left to the independent reviewer's
ruling. The TREES those commits carry are unaffected.

---

## Wave 7 Phase 2 — persona packs, variants, and context continuity

On `wave7-usable-local-delos`, continued from the accepted 7a tip. Everything
written fresh from the public Master Program specification; no private source
consulted or copied.

### Added

- **Persona packs** (`core/domain/persona-pack.ts`, `adapters/persona/`):
  versioned manifest with allowlist-shaped paths; hardened directory loader
  (symlinks refused via lstat, size/count caps, NUL-free UTF-8 only, every
  present file must be manifest-claimed); hand-rolled deterministic ZIP export
  and paranoid ZIP import over node:zlib - central-directory driven, names
  validated before inflation, S_IFLNK external attributes refused,
  declared-size caps enforced during inflation, CRC verified. Zero
  dependencies added.
- **Variant resolution** (`core/services/variant-resolver.ts`): deterministic
  order (base, overlays, contextual, manual; priority ascending), structured
  per-turn metadata with activation reasons and inactive-variant reasons.
  Manual disable wins over everything; a manual-policy variant can never be
  activated by anything but the user's explicit per-session enable.
- **The shipped Arti pack** (`personas/arti/`): the three public base blocks <!-- scan-allow-persona -->
  migrated unchanged, plus two generic variants - intimacy (manual-only) and
  sensitive-content (contextual, visible rules). `prompts/` remains as the v1
  compatibility path; the pack is canonical.
- **Model-output containment** (`core/services/output-containment.ts`):
  reasoning wrappers, whole-reply internal event JSON, system-prompt echo and
  fake role continuations removed before persistence; the record carries
  reason/bytes/sha256/provider/timestamp and never the content; legitimate
  Markdown, fenced role labels and injection discussions pass byte-identical.
- **Trusted time** (`core/services/trusted-time.ts`): injectable clock, IANA
  zone with host default and user override, DST-pinned tests, explicit
  degraded fallback rendering.
- **Structured context** (`core/domain/context-item.ts`,
  `core/services/context-assembly.ts`): nine source categories under the
  documented trust order; current user message never trimmed; corrections
  remove superseded assistant claims before budgeting; content-free assembly
  report including requested-vs-read history honesty.
- **Current Situation** (`core/services/current-situation.ts`): user-authored
  expiring state; supersede-not-overwrite; no code path from model output
  into the store (structurally pinned by test).
- **Deterministic history reads** (`core/services/history-read.ts`): five
  literal query shapes over real records; empty results reported honestly.

### Numbers

427 tests (was 355 at the 7a review-fix tip), 58 adversarial scanner cases
(five new pack-seam cases, four of them attacks), SCAN PASS throughout, zero
dependencies.

---

## Wave 7 Phase 3 — persistent runtime, idempotency, and recovery

### Added

- **TranscriptStore port** (`core/ports/transcript-store.ts`): a transcript
  archive that refuses to be more - literal reads and literal state
  transitions under the durable turn state machine (received .. delivered,
  failed-before/after-model, cancelled), with the machine's edges enforced at
  the store. failed-after-model's only outgoing edge is delivery-pending:
  regeneration after delivery failure is unreachable by construction. The
  contract bans secrets, raw headers, environment dumps, hidden reasoning and
  contained output.
- **SQLite adapter** (`adapters/transcripts/sqlite-transcript-store.ts`).
  **Dependency decision recorded:** the built-in `node:sqlite` DatabaseSync -
  no native compilation, nothing added to the supply chain; rejected
  alternative better-sqlite3 (equivalent, but a native module with a build
  step); honest caveat that node:sqlite is flagged experimental in Node 22.x,
  contained by the port boundary. Versioned append-only ATOMIC migrations
  (DDL + version bump in one transaction; a broken migration provably rolls
  back leaving no partial DDL). Dense per-conversation ordinals assigned
  under BEGIN IMMEDIATE; cascade deletion; records-only JSON export;
  `:memory:` as the non-persistent session; restart persistence proven
  against a real file reopened by a second store instance.
- **External-turn identity**: (surface, externalConversationKey,
  externalTurnKey) unique at the database; INSERT OR IGNORE + SELECT makes
  concurrent duplicates converge by the database's own arbitration.
- **Turn coordinator** (`core/services/turn-coordinator.ts`): exactly-once
  model calls over at-least-once surfaces. Duplicates join in-flight work or
  are answered from the stored result; provider failure fabricates no
  assistant message; delivery failure never regenerates; every transition
  persists before its action, so crash recovery redelivers completed turns
  with zero model calls and honestly fails turns caught mid-model rather
  than silently regenerating. Turns serialise per conversation while
  conversations overlap.
- **Provider observations**: served-model match/mismatch/unknown stored as
  evidence with a source enum (provider-metadata / protocol-behaviour /
  configuration). Model prose is not a source; unknown stays unknown; a
  mismatch is stored, not repaired.

### Numbers

448 tests (427 at the Phase 2 tip), 58 adversarial, SCAN PASS, still zero
runtime dependencies.

---

## Wave 7 Phase 4 — local daemon, typed client, and web application

### Added

- **Daemon** (`surfaces/daemon/`): /api/v1 behind an enforced security layer
  (loopback-only binding refused otherwise; session token in a header, never
  a query string; Origin judged before the token; no CORS at all; bounded
  bodies drained not reset; literal-segment routing; one public error shape).
  Full API per the programme including honest 501 cancellation and truthful
  phase-5 status stubs. SSE per conversation with buffered assistant events.
- **Typed client** (`surfaces/api-client/client.ts`): the single contract for
  all surfaces including the future PWA; version-negotiating handshake; typed
  errors; header-authenticated SSE parsed from the body.
- **Web application** (`surfaces/web/`): framework-free; textContent-only
  rendering (compiled bundle asserted free of innerHTML assignment and of
  localStorage/sessionStorage/indexedDB); onboarding, chat with live events
  and idempotency-key retry, conversations, personas (wizard/paste/duplicate),
  situations, providers with real-path tests, backup, diagnostics, settings.
  Static serving is allowlist-shaped and traversal-tested. `npm run app:web`.
- **Gate e2e**: production fetch (no injection) against real loopback servers
  speaking both wire protocols; onboarding through the typed client only;
  variants on the shipped pack; situation expiry in real time; restart-and-
  continue; **durable idempotency across a daemon restart** - the same key
  after restart returns the stored reply with zero provider calls.

### Numbers

466 tests (448 at the Phase 3 tip), 58 adversarial, SCAN PASS, zero runtime
dependencies. tsconfig gains the DOM lib for the browser surface.

---

## Wave 7 Phase 5 - desktop, Telegram, and delegated providers

### Added

- **Telegram surface** (`surfaces/telegram/`): long polling through the
  shared coordinator; disabled by default, DM-only, allowlisted, token by
  reference with redaction, webhook conflict detected never deleted;
  delivery through the coordinator so restart recovery redelivers stored
  replies with zero model calls. Daemon persists non-secret config and
  refuses token-shaped values in reference fields.
- **Delegated provider kinds** (`adapters/providers/delegated/`):
  delegated-codex (app-server stdio JSON-RPC) and delegated-claude-code
  (structured --print JSON). Tool-owned auth enforced at profile
  validation; no secret-store consultation; no filesystem API in the
  compiled modules; bounded workdir; shell-less spawn; timeout kill.
  Contracts proven against committed fake executables; real detection on
  /api/v1/delegated/status reports detected-untested / not-installed.
- **Desktop shell** (`desktop/`, separate package): Electron main +
  minimal typed preload; safeStorage secret store with honest
  session-only fallback; daemon secret-store chain; security policy as
  pure tested decisions; packaging script (current platform, unsigned,
  SHA-256 manifest); GitHub Actions packaging workflow authored, never
  run.
- **Runtime fixes surfaced by this phase**: coordinator recover() takes a
  surface filter; failed-after-model turns are recoverable (delivery
  retry) walking legal state edges for turn AND message; the environment
  secret store rebuilds when profile mappings change.
- **Scan harness correction, disclosed**: the phase-gate repository sweep
  had been invoked as `scan.py .`, which scanned nothing (the argument was
  treated as a file). The adversarial suite always exercised the scanner
  for real; the sweep quoted in earlier gate evidence was vacuous. The
  harness now runs the scanner bare, rule/reality drift found by the first
  real sweep is reconciled, and the sweep passes non-vacuously.

### Dependency record

Root: still zero runtime dependencies. Desktop subpackage only:
electron (MIT; Tauri rejected - larger unverifiable surface),
@electron/packager (BSD-2-Clause; electron-builder rejected - unused
signing/updater machinery). npm audit: 0 vulnerabilities at install time.

### Phase 5 audit and remediation

Before the phase gate, the implementation was audited against Section 11 by
five independent reviewers (desktop, telegram, codex, claude, gate/privacy),
with every claimed gap adversarially verified against the spec as written.
Fifteen gaps were claimed; eleven were confirmed (eight unique defects);
four were refuted and kept as advisory notes. All eight defects were fixed
in the same phase: the desktop dev-mode asset path, the packaging recipe's
missing web assets (now a tested pure manifest plus a real verified
linux-x64 package), the unwired file dialogs (now wired for persona pack
import/export, conversation export, and backup export/restore), a
surrogate-pair hazard in Telegram's message split, missing Codex auth-state
inspection through the official surface (plus its login-flow pointer), an
overstated Codex tool-confinement comment (now an honest stated
limitation), and delegated working-directory fallback to the caller's cwd
(now fail-closed everywhere).

Environment facts recorded for this host: the Electron v43.2.0 linux-x64
binary was fetched resumably through the local proxy and verified against
the official SHASUMS256.txt; the packaged app's resources layout was
verified on disk; the LIVE desktop launch smoke remains DEGRADED here
because the WSL distribution lacks the GUI system libraries (libnspr4 /
libnss3 family) and installing them needs administrator action. The
@electron/packager 19.0.0 registry tarball ships without its dist/
directory (verified with npm pack) - the dependency is pinned to 20.0.4.

---

## Wave 7 Phase 6 - full backup, restore, and doctor

### Added

- **Backup** (`adapters/backup/backup-archive.ts`): one versioned
  deterministic ZIP - transcripts via a new stable-ordered
  `exportEverything`, situations, non-secret providers and telegram
  documents, user persona packs, and a manifest with counts and per-entry
  SHA-256. Exclusions are structural: references only, no secret-store
  consultation, entry grammar that cannot express a foreign path. The ZIP
  paranoia is now one generic reader shared with persona packs.
- **Restore** (`adapters/backup/restore.ts`): inspect/validate/preview/
  apply/verify with policy replace or merge-skip; files swap with .bak
  kept, situations hold a rollback snapshot, the transcript snapshot lands
  last inside one transaction (`importEverything`), so failure rolls
  everything back; the result names profiles needing credential
  reconfiguration. The daemon reloads its in-memory state after apply.
- **Doctor** (`core/services/doctor.ts` + `adapters/doctor/doctor-checks.ts`):
  the required checks as PASS/DEGRADED/BLOCKED with worst-of aggregation
  and a crashing check reported as a finding; exposed on the API, the
  Diagnostics page, and offline CLI `--doctor` with a read-only database
  connection; redacted exportable report. Doctor repairs nothing, ever.
- **Gate e2e**: deterministic backup bytes, no-secret inclusion, fresh
  restore with credential-required truth, atomic rollback through the API,
  doctor states, online webhook-conflict diagnosis against a fake Bot API,
  and the redacted report.

### Fixed along the way

The real CLI smoke on this host caught two doctor defects before the gate:
a nonexistent data directory reported BLOCKED (it is a first-run state),
and version probes spawned with that nonexistent directory as cwd made an
INSTALLED claude report as missing (ENOENT from the cwd, not the tool).

### Phase 6 audit and remediation

Before the phase gate, the implementation was audited against Section 12 by
five independent reviewers (backup, restore, doctor checks, doctor safety,
gate), every claimed gap adversarially verified against the spec as
written. Eleven gaps were claimed; nine were confirmed (two major) and all
were fixed in the same phase; two were refuted and recorded as advisory
notes. The majors: a post-commit verification hole that could strand a
half-restored machine (closed by re-deriving manifest counts from entry
content at inspection and making everything after the database commit
reporting-only), and the missing ACTIVE-persona doctor check (a broken
Telegram default persona now blocks). The minors: honest verified
semantics for merge-skip, merge-skip situation overlay, duplicate
situation ids, a backup path grammar subtly stricter than the pack
loader's own, a restore transport cap smaller than the largest legal
backup, provider connections joining doctor's online mode, and Codex auth
state probed through its official surface online with the Claude CLI's
lack of a read-only auth query stated as a limitation.

---

## Wave 7 evidence revalidation ruling - adopted 2026-08-02

Mandatory ruling `DELOS-PUBLIC-V01-WAVE7-EVIDENCE-REVALIDATION-RULING-20260802.md`
(7,932 bytes, 141 lines, sha256
`537db3cc413f4c9c8717520e2c8fc13fd575b8ec179743b261c0f49575e804fd`),
fetched from Relay-Outbox and verified against all three published
metrics before adoption. It responds to this programme's own disclosure
that the historical repository-sweep invocation `scan.py .` produced an
empty-input PASS for the Phase 2-4 gates.

### Status correction (ruling section 2, recorded verbatim)

```text
Phase 2 implementation checkpoint: complete; repository scan evidence pending revalidation
Phase 3 implementation checkpoint: complete; repository scan evidence pending revalidation
Phase 4 implementation checkpoint: complete; acceptance pending runtime and evidence closure -> see sidecar
Phase 5 implementation checkpoint: complete; acceptance pending runtime and evidence closure
Phase 6: authorised and in progress (its scoped implementation and checkpoint are complete)
```

No prior checkpoint artifact was rewritten, replaced, deleted, or
amended; every original hash stands.

### Scanner hardening (forward commit)

`scripts/scan.py` now prints walk evidence (files and bytes actually
visited) before any verdict, hard-fails a zero-file or zero-byte sweep
in every mode, and gains `--root DIR` as the supported recursive-walk
entry point for scanning extracted archive trees. Commit `e6ece58`;
file sha256
`8d9b97486741768406548e05c0e40d96546856515676b35e4e2ba5b0e4badf2f`.
The historical `scan.py .` misuse now fails structurally.

### Phase 2-4 archive revalidation (ruling section 3) - COMPLETE

Each original candidate archive was fetched from Relay-Outbox, verified
against its originally recorded SHA-256 (all MATCH), extracted read-only
into a fresh directory, and swept with the corrected scanner via
`--root`. Adversarial suite at time of record: 58/58 PASS.

```text
phase 2: walk 91 files / 716,875 bytes  -> FAIL 12 findings
phase 3: walk 96 files / 774,526 bytes  -> FAIL 14 findings
phase 4: walk 109 files / 896,531 bytes -> FAIL 23 findings
```

Every finding falls into two content-benign classes: the shipped PUBLIC
sample persona's name in tests/docs predating the per-line
`scan-allow-persona` markers, and one test-fixture variable whose NAME
matched the assigned-secret keyword heuristic. Zero findings in every
high-risk class (credentials, private names, home paths, emails, private
hosts, forbidden paths, symlinks). Both classes were already repaired on
this branch in `fb145fe`; no further forward commit was needed.

The original repository-scan PASS claims for Phases 2-4 were invalid at
creation time. Replacement evidence, uploaded to Relay-Outbox with
byte-identical raw readback verification:

```text
DELOS-PUBLIC-V01-WAVE7-PHASE2-SCAN-REVALIDATION-01.md  4,964 B, 127 lines
  sha256 57149e23fd752dd4c7a6372e8cfae8b8d818e1d7e9a03c0da7a438f20b651fe0
DELOS-PUBLIC-V01-WAVE7-PHASE3-SCAN-REVALIDATION-01.md  5,110 B, 129 lines
  sha256 e5f1a4b493d53f8fe8556916990eba77f2728f696d0a7f77951410dfd4e9606d
DELOS-PUBLIC-V01-WAVE7-PHASE4-SCAN-REVALIDATION-01.md  5,664 B, 138 lines
  sha256 57f8c66cfb96b46b79345853b0b0209b693b5cd8766b4a93e9ee733d7f5fcd39
```

### Packaging provenance (ruling section 4.3) - reproduced

The `@electron/packager` 19.0.0 claim was independently reproduced on
2026-08-02 from a freshly fetched official registry tarball using an
empty npm cache. Registry metadata and the fresh tarball agree exactly:

```text
dist.shasum    d5f4714f1684c9d8b7334bf9c108dcb012701a4f   (fresh sha1: identical)
dist.integrity sha512-Vn4G3SgZVudZmg7rcGWt1MFxkU+yraTdJpBsUr9oREMmamdwDDqzvcXAJmsZ0EeJAZFIQD10fiOV2qhBCn0qDw==
               (fresh sha512: identical)
contents       8 entries, ZERO package/dist/ entries, while its own
               package.json "files" lists "dist"
```

The 19.0.0 registry publication genuinely ships without its compiled
dist/ directory; this is an upstream publication defect, not a local
cache artifact. The dependency remains pinned to 20.0.4.

### Still blocked until the ruling closes

Declaring the complete Wave 7 candidate ready; touching canonical
`master`; any remote, push, tag, release, or public artifact; and
describing Phases 2-5 as independently accepted. Remaining closure
gates: Phase 5 runtime closure (packaged desktop acceptance on a
supported platform, or honest retention of DEGRADED; authorised real
delegated smokes, or explicitly untested/disabled) and the independent
high-risk review of ruling section 5, cited by hash in the final Master
Program checkpoint.

---

## Wave 7 Phase 7 - public-safe extensions

Executed under the evidence revalidation ruling of 2026-08-02 (sha256
`537db3cc...e804fd`): every gate quotes real walk evidence, and final
Wave closure remains gated on that ruling's section 4 and section 5.

### Added

- **Reply segmentation** (13.3, `core/services/reply-segmentation.ts`):
  fence-preserving, paragraph/sentence-boundary, tiny-fragment-merging,
  surrogate-safe segmentation with a VISIBLE truncation notice at the
  segment cap. Telegram delivers through it; one canonical assistant
  message is stored regardless of wire segmentation.
- **Voice and attachment boundary** (13.1, `core/ports/attachment.ts`,
  `adapters/attachments/`): safe basenames, streamed size enforcement,
  atomic .part staging, abandoned-temp sweeps; a pluggable LOCAL
  external-command STT adapter (no external service required or
  contacted, ever); the full Telegram voice path against the fake Bot
  API; image input truthfully unsupported until a provider EVIDENCES
  image capability.
- **Proactive runtime** (13.2, `core/services/proactive.ts`): OFF by
  default; quiet hours, follow-up/reconnect/long-gap policies, jittered
  thresholds, multiplicative unanswered backoff, self-pause, echo guard;
  reasons are elapsed-time arithmetic - never inference from silence;
  proactive text is never user speech; a user turn is never pre-empted;
  the daemon drives it through an explicit tick seam - no hidden timers.
- **Persona tools** (13.4, `delos persona validate|snapshot|test`):
  deterministic pack hash, content-free snapshot, variant leakage checks
  (disable-wins proven; over-broad contextual rules flagged), synthetic
  cases through a built-in OFFLINE provider, append-only public-safe
  evidence records.
- **Addendum B closed out**: B2 consent-gated SSRF-guarded egress policy,
  off by default, with one judgement seam; B3 model pinning - no silent
  fallback, absence of served-model evidence refuses under a pin; B4
  input-side delimiter guard on every textual render seam; B5 the public
  ADR set (docs/adr/0001-0008); B6 executable repo hygiene tests; B7
  containment BEFORE persistence, proven end to end against storage,
  messages API, export and backup.

### Numbers

578 tests (522 at the Phase 6 tip), 58 adversarial cases, repository
sweep with walk evidence PASS, zero runtime dependencies at the root.

---

## 2026-08-07 - provider recovery field note

- `docs/PROVIDER-RECOVERY-FIELD-NOTE.md`: **written fresh** from
  reusable, public-safe lessons verified during a private provider recovery.
  No prompt text, transcript content, credential, account identifier, incident
  detail, deployment metric, private host, or absolute path was copied. The
  guide does not expand the v0.1 support claim.
- `docs/PROVIDERS.md`: added one link and a bounded description of the field
  note. No provider behavior or configuration contract changed.
