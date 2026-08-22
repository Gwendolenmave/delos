# 0005. Durable external-turn identity; delivery through the coordinator

Status: accepted (Wave 7 Phase 3)

## Context

Surfaces redeliver: Telegram is at-least-once, browsers retry, daemons
restart mid-turn. The one unacceptable failure is charging the user two
model calls - or showing two answers - for one question.

## Decision

Every inbound turn carries a durable external identity (surface,
conversation key, turn key) unique at the database. The coordinator runs
the model at most once per identity, answers duplicates from the stored
result, and owns DELIVERY through its own callback, so crash recovery can
redeliver a generated-but-unsent reply with zero model calls. Recovery
never regenerates: a turn that died before its result is failed honestly.

## Consequences

Retries are free and safe on every surface. A surface-specific deliverer
must pass its surface filter to recovery so it can never misdeliver
another surface's turns.
