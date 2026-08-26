# Changelog

This changelog describes public Delos source. It does not treat private construction checkpoints, package publication, or live deployment as releases.

## Unreleased

- Add durable local transcript continuity with restart-safe conversation scoping.
- Integrate optional `@delos/mnemosyne` through its package-root API while preserving memory-off behavior.
- Keep retrieved memory as bounded host data rather than system/persona authority.
- Add portable retention-aware long-term admission: retention-mode generic D0 receipts are parked as evidence-only and cannot be claimed by the generic worker.
- Admit ordinary long-term candidates only through the retention-classified governed lane; session, episodic, quarantine, and correction outcomes are not promoted through generic D0.
- Preserve legacy/off D0 compatibility without allowing a later mode switch to resurrect retention-era parked evidence.
- Record that Public Delos has no separate memory-specific admin/recovery mutation surface; no third memory writer is introduced.
- Keep embedding/vector/hybrid retrieval outside this non-embedding public memory parity slice.

Verification claims here refer only to exact public source revisions and their public CI/privacy gates. They are not shorthand for current-private parity, a published package, or a deployed/live system.
