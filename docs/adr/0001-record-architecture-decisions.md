# 0001. Record architecture decisions

Status: accepted (2026-08-02)

## Context

Delos's decisions were recorded narratively in provenance and design notes.
A public codebase needs the load-bearing ones findable in one place, each
with its reasoning, so future changes argue with the reasoning rather than
rediscovering it.

## Decision

Keep this `docs/adr/` set: one short record per standing decision,
append-only in spirit - a reversal is a NEW record that supersedes an old
one, never an edit that pretends the past agreed.

## Consequences

Reviewers can hold a change against the recorded reasoning. The set is
public-safe by construction: it references no private deployment, persona
content, or account detail.
