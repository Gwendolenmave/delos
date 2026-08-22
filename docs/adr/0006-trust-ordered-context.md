# 0006. Trust-ordered context assembly; the current message is never trimmed

Status: accepted (Wave 7 Phase 2)

## Context

Under a token budget something must be dropped, and the dropping rule is a
security property: if recency wins, whoever spoke last controls the
prompt.

## Decision

Context items are TYPED by source and ranked by a fixed trust order; under
pressure, lower-trust categories drop first. The current user message is
never trimmed. Assistant prior claims are never promoted to user facts. An
explicit user correction knocks out the claims it supersedes before
budgeting. The assembly emits a content-free report of what was included
and omitted, and why.

## Consequences

Prompt composition is deterministic and auditable. Anything rendering
OUTSIDE material into prompt text passes the delimiter guard (see 0008).
