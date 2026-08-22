# Provider replacement and recovery guide

## Replace the model path without rebuilding the assistant

This guide records a provider replacement pattern verified in a real private
Delos deployment. It keeps the reusable method and intentionally omits private
prompts, transcripts, paths, credentials, incident details, and deployment
metrics.

The goal is simple:

> A provider may disappear without forcing the user to rebuild the assistant,
> move local continuity data, or rewrite the conversation surface.

It is an architecture guide, not a promise that every provider or delegated
login is enabled in the v0.1 source release.

## Keep three boundaries separate

### Delos-owned continuity

These parts should not change during a provider replacement:

- prompt files and deterministic prompt assembly;
- recent-dialogue selection;
- transcript storage;
- memory retrieval and governance;
- conversation and delivery state;
- provider-neutral turn inputs and results.

### Adapter-owned protocol

Each provider adapter owns only what is genuinely provider-specific:

- request and response protocol;
- process or HTTP lifecycle;
- requested and served model receipts;
- provider thread or session identifiers;
- capability evidence;
- safe error normalization.

Different providers do not need to pretend to share one wire format. They need
to satisfy the same small Delos port honestly.

### Deployment-owned environment

Deployment configuration owns:

- which provider profile is active for each lane;
- the exact executable and version for a delegated provider;
- proxy injection;
- credential references or tool-owned login state;
- rollback anchors and service restart procedure.

Keeping these concerns out of prompts and memory code is what makes the swap
reversible.

## Recovery procedure

### 1. Freeze and preserve

Before changing the active provider:

- stop editing the failed path;
- preserve exact configuration preimages;
- record hashes for files that will change;
- confirm that transcripts, memory, and runtime state remain local and
  untouched;
- write down one direct rollback action.

Do not remove the old adapter merely because its account or endpoint is
currently unavailable.

### 2. Add the replacement in parallel

Implement the new provider behind the existing port. Keep the old adapter and
select between them in composition or configuration.

The replacement should receive the same assembled prompt and conversation
meaning. Provider-specific flags, authentication, session recovery, and proxy
rules stay inside the new adapter or deployment layer.

This produces a useful invariant:

> Changing providers is a selection change, not a data migration.

### 3. Keep authentication in its proper owner

An API adapter may resolve a credential reference through the configured
secret store. A delegated command-line adapter may use login state owned by
that tool.

Do not copy tool-owned credentials into Delos, put credential values in a
profile, or translate one provider's authentication into another provider's
environment variables.

### 4. Give the child a stable proxy boundary

If delegated tools need a proxy, pass an explicit stable endpoint into the
child process. Let a separate local bridge discover the currently active
upstream proxy.

This prevents provider code from depending on one desktop proxy product, one
port, or one manually selected node. The adapter needs only a stable injected
contract and a fail-closed reachability check.

### 5. Run a real live preflight

A process that starts and completes a local handshake has not proved that it
can serve a model turn.

The live preflight should use the exact production:

- executable and version;
- authentication route;
- proxy route;
- requested model and effort;
- sandbox and tool policy.

Run one isolated, ephemeral, minimal turn. Verify a real reply and the
provider's requested-versus-served receipt, then close the process and discard
the temporary session.

### 6. Replay representative conversations

Hold prompt bytes constant and compare the old and new routes with locally
held transcript trajectories. Include the interaction shapes that matter to
the deployment, not only single-turn factual questions.

Keep private cases and raw outputs local. A public report should contain only
the method, aggregate gates, and public-safe conclusions.

Change one factor at a time:

1. compare provider or model with one fixed prompt and effort;
2. compare reasoning effort among the surviving choices;
3. compare an optional bridge prompt only after the model and effort are
   fixed.

This keeps the result attributable instead of mixing three causes in one
matrix.

### 7. Treat capabilities independently

A successful text reply proves only text generation. It does not prove image
input, tools, web retrieval, streaming, cancellation, or any other optional
channel.

Each optional capability should be one of:

- **verified on this route**;
- **unsupported**;
- **unknown and disabled**.

Unknown capabilities fail closed. Never infer support from a model name or
from generated prose.

### 8. Keep chat and background lanes independent

The main conversation provider and a background worker may need different
models, reasoning levels, credentials, and evaluation gates.

Do not let a chat-provider cutover silently select the model used for memory
governance, summarization, indexing, or another background lane. Each lane
gets an explicit provider selection and its own receipts.

### 9. Cut over by selection

After the live preflight and conversation replay pass:

- change only the intended provider selection;
- restart through the canonical launcher;
- verify one live process and one writer;
- verify the active provider, requested model, and served receipt;
- leave the old adapter and rollback anchor intact.

Do not combine the cutover with unrelated cleanup, refactoring, or deletion.

### 10. Leave a complete recovery record

The handoff should let an unfamiliar maintainer continue without reconstructing
the incident from chat history. Record:

- previous and new provider selections;
- exact executable version where relevant;
- files changed and their preimage hashes;
- authentication and proxy checks without credential values;
- requested and served model receipts;
- targeted and full test results;
- capabilities verified, disabled, or still unknown;
- rollback instructions;
- the final `PASS`, `HOLD`, or `STOP` decision.

## Why this pattern worked

The provider was already a replaceable edge. Prompt assembly, local
continuity, memory, and the conversation surface did not know which delegated
tool carried the turn. The new adapter could therefore be developed and
tested in isolation, selected explicitly, and rolled back without converting
local data.

The practical test for low coupling is not how elegant the port looks on the
day it is written. It is whether a real provider loss can be recovered from
without asking the user to rebuild everything around it.

This pattern passed that test.

