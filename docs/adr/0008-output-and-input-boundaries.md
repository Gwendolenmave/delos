# 0008. Model output is contained before persistence; inputs cannot forge structure

Status: accepted (Wave 7 Phases 2-7; B2/B3/B4/B7)

## Context

Two symmetrical risks: what a model emits (reasoning wrappers, fake role
continuations) leaking to users and storage; and what users or documents
emit (role markers, structural tags) being read as runtime structure.

## Decision

Output side: containment runs on the provider seam BEFORE persistence, so
reasoning/thinking text is never stored and no surface - messages API,
SSE, export, backup - can expose it (B7). Input side: wherever roles
become TEXT, untrusted material passes the delimiter guard - visible,
idempotent neutralization - and travels in explicit untrusted blocks (B4).
Outbound retrieval is off by default behind a consent-gated, SSRF-guarded
egress policy (B2). A profile may pin its model, making a missing or
different served-model evidence a refusal, never a silent fallback (B3).

## Consequences

The safety posture exists as enforced seams with tests, not guidance. Each
guard is idempotent, so defence in depth costs nothing.
