# Public status

This page describes the **current public Delos repository**. It is not a claim of current-private parity, package publication, deployment, or live activation.

| Capability | Public source | Public tests | Runtime boundary |
| --- | ---: | ---: | --- |
| Provider-neutral chat runtime | yes | yes | host-owned |
| Durable local transcript continuity | yes | yes | host-owned |
| Optional Mnemosyne package attachment | yes | yes | package-root API |
| Bounded Anamnesis recall | yes | yes | optional / fail-soft per turn |
| Portable retention classification | yes | yes | package-root `Retention` API |
| Generic D0 compatibility | yes | yes | legacy/off only |
| Retention-mode single long-term ingress | yes | yes | generic D0 parked evidence-only |
| Memory-specific admin/recovery mutation surface | no | n/a | intentionally not invented |
| Embedding/vector/hybrid retrieval | no | n/a | explicitly outside this status slice |

## Memory authority in one sentence

When portable retention is authoritative, generic completed-turn D0 receipts cannot become a second long-term admission lane: they are parked as evidence-only, while ordinary long-term candidates may advance only through the retention-classified governed path.

Session-only, episodic, quarantined, and correction outcomes are not promoted to ordinary long-term memory by that generic path. `EPISODIC_ONLY` preserves evidence/episode value without becoming an ordinary long-term card.

## Verification vocabulary

Keep these states separate:

```text
specification
!= source bytes
!= tests
!= merged public main
!= package publication
!= deployed/live state
```

The current public CI runs typecheck, build/tests, and the public privacy scanners. A green exact-head run is evidence for that public revision only.

## Package boundary

Public Delos remains the host. Public Mnemosyne remains a standalone governed-memory package. Delos consumes stable package-root APIs rather than copying Mnemosyne internals.

The non-embedding governance/retention integration described here is merged public source. Embedding/vector/hybrid retrieval remains separately scoped and is not included in this parity status.
