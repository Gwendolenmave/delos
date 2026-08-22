# Public Delos staging

Status: `PUBLIC_DELOS_MNEMOSYNE_INTEGRATION_SOURCE_READY`

This branch is source-only construction for the next Public Delos candidate. It is based on the preserved Aug-18 public candidate and is not publication authority. The source-ready status in this document is valid only for the exact commit containing this receipt after that exact commit carries `public-delos-staging/verify=success`; the PR receipt records the resulting SHA.

## Product boundary

Public Delos remains the provider-neutral conversation/runtime host. Long-term governed memory belongs to the separately packaged Public Mnemosyne library. Delos consumes Mnemosyne through its public package API; no Mnemosyne source is copied into Delos.

## Phase B1 — durable CLI transcript continuity

Status: `PUBLIC_DELOS_DURABLE_TRANSCRIPT_VERIFIED`

The reference CLI persists completed turns locally and resumes them across restart inside a configuration/provider-scoped application-data boundary. User messages are durable before a model request; assistant replies are durable before display; `/clear` archives rather than destroys the old conversation; one-shot invocations remain isolated. Transcript scope binds the resolved config path, exact startup config bytes and selected provider identity so prior history cannot silently cross a provider boundary.

Exact verified B1 head: `040e9ced0f1578e5c3de970aef06bde32e1d7e46`.

## Phase B2 — Public Delos → Public Mnemosyne package integration

Status: `PUBLIC_DELOS_MNEMOSYNE_PACKAGE_INTEGRATION_VERIFIED`

Public Delos has a bounded host-memory seam that attaches Mnemosyne only through the root `@delos/mnemosyne` package surface. Memory-off preserves the established v0.1 request path. Explicit Mnemosyne activation opens the package backend, retrieves through Anamnesis and places the rendered packet inside a bounded data-only host-context envelope. Retrieved data never enters system authority, retrieval failure degrades to the memoryless path, and host context consumes the same recent-window budget rather than silently expanding it.

Exact verified B2 head: `02175f28b5fbc8f3d77a56a1816d09bc98af773f`.

## Phase B3 — metadata-only auditable context receipt

Status: `PUBLIC_DELOS_CONTEXT_RECEIPT_VERIFIED`

Every successful assembled turn returns a versioned `TurnContextReceipt` containing metadata for the exact prompt/context selection without storing prompt, dialogue, current-user or retrieved-memory bodies. An optional receipt sink runs before provider invocation and fails closed if it cannot record the receipt.

Implementation head `9497dba7cea78ad63f6da6fbd1a5c41b1710d5e3` passed self-hosted staging CI. Exact verified B3 marker head: `3bc6c95678fb9067e85996e1505f07feff851338`.

The core receipt/sink boundary is source-ready; this candidate does not invent a second durable receipt store merely to close staging.

## Phase B4a — package dependency contract

Status: `PUBLIC_DELOS_DEPENDENCY_CONTRACT_VERIFIED`

- the next Delos candidate identifies itself as `0.2.0-dev.0` while remaining `private: true`, so an accidental `npm publish` is refused;
- `@delos/mnemosyne` is an **optional peer dependency** on the intended first-public compatibility line `^0.1.0`;
- Mnemosyne is absent from ordinary/dev dependency installation in this private staging branch, so construction does not pretend the empty public destination or an unpublished registry package is already installable;
- the lockfile and Node `>=22.22.0` floor match the candidate contract.

Implementation head `d786e00cf942b359ebcca8a8bb30f8fef575a9c1` passed self-hosted staging CI. Exact verified B4a marker head: `e95f11e10bec846ab6438b6557e2b58d6358d27b`.

## Phase B4b — publication-facing memory configuration and documentation

Status: `PUBLIC_DELOS_MEMORY_CONFIG_DOCS_VERIFIED`

- `DELOS_MEMORY_BACKEND` is the stable host activation switch: unset/`off` preserves the memoryless path; `mnemosyne` explicitly requests the optional peer package;
- `DELOS_MEMORY_DB_PATH` is required only for `mnemosyne`; relative paths resolve against the selected Delos config file, never `process.cwd()`;
- unsupported backend values are rejected without echoing supplied text, and memory-off never loads the optional peer package;
- explicit memory startup is fail-closed, while per-turn recall failure degrades to the ordinary memoryless turn;
- schemaVersion 1 and 2 provider JSON stay migration-free; memory semantics remain versioned by `@delos/mnemosyne` rather than duplicated in Delos;
- README and `docs/MEMORY.md` state the package/runtime/path/authority/privacy and publication-order boundaries honestly.

Implementation head `7305f2f30d4dd9dab7fbf1324a74ed66d4a58d1b` and exact marker head `c279f7bc35cfce6c45fc50019676bb2b03039460` passed the self-hosted staging verification status.

## Phase B5 — provider/runtime reliability closure

Status: `PUBLIC_DELOS_PROVIDER_RUNTIME_RELIABILITY_VERIFIED`

The bounded provider/runtime closure adds no automatic retries and does not change provider-selection authority.

- schemaVersion 1 OpenAI-compatible requests use manual redirect handling; credential-bearing POSTs are never replayed along 301/302/303/307/308 and redirect targets/bodies are not inspected;
- both the schemaVersion 1 transport and the shared profile HTTP core hard-bound transport completion and body parsing to the configured deadline even if a custom/injected `FetchLike` ignores `AbortSignal` or never settles;
- the profile HTTP core applies the same hard boundary to caller cancellation, and an already-cancelled request never invokes its transport;
- retryable classification remains metadata only; Delos does not silently duplicate a possibly billable request;
- synthetic regressions exercise never-settling transport/body seams and caller cancellation, while a real loopback regression proves the schemaVersion 1 307 target receives no request.

Exact verified B5 head: `69e3c3fc41bb38b25a2cd10cc802ae63b414415d`, with `public-delos-staging/verify=success`.

## Final Phase-B source-ready receipt

Status: `PUBLIC_DELOS_MNEMOSYNE_INTEGRATION_SOURCE_READY`

The Phase-B source programme is bounded and complete when the exact commit carrying this receipt passes `public-delos-staging/verify`.

Source-ready means all of the following are simultaneously true:

1. durable CLI transcript/restart continuity is verified and provider/config scoped;
2. optional Mnemosyne memory is consumed only through the public package API, with memory-off compatibility and no copied memory implementation;
3. exact per-turn context policy has a metadata-only audit receipt/fail-closed sink boundary;
4. the future Delos↔Mnemosyne package relation is an honest optional peer contract rather than a fake unpublished dependency;
5. memory host configuration and publication-order documentation are explicit and migration-free for existing provider JSON;
6. provider HTTP redirects, whole-exchange deadlines and profile cancellation have verified fail-safe transport behavior without automatic retries;
7. reference CLI/provider documentation no longer claims persistent conversations are absent;
8. synthetic/public staging fixtures and scanners remain the verification authority for this branch.

This receipt does **not** mean published, deployed or live. It does not authorize writes to either public destination, a canonical merge, a tag/release, live service changes, real memory/transcript mutation or provider cutover.

## Verification state

The construction-only self-hosted workflow verifies the exact staging head with an isolated single-commit checkout, locked install, Node 22.22.1, typecheck, real CLI child-process gates, complete repository tests and the public adversarial privacy/scanner gate. The exact source-ready marker is accepted only after that status is green.

A later publication phase must separately construct publication-shaped history and run the full public privacy/history gates. Passing this staging CI is not a publication gate.

## Authority boundaries

- Public destination repositories remain untouched.
- Private canonical source is read-only evidence for this programme and is not modified by this branch.
- No live service, runtime database, transcript, memory store, provider login, secret, or deployment state is touched.
- `spec != source bytes != committed != verified != published/live`.
