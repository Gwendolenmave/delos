# Delos ↔ Mnemosyne integration

Delos is the conversation/runtime host. Mnemosyne is the separately packaged long-term-memory system. Delos consumes the public `@delos/mnemosyne` package API and does not copy Mnemosyne source into its own tree.

## Runtime activation

Memory is opt-in and defaults off.

```bash
export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

The attachment contract is intentionally small:

| variable | values | meaning |
|---|---|---|
| `DELOS_MEMORY_BACKEND` | unset, `off`, `mnemosyne` | Unset/`off` keeps the established memoryless Delos path. `mnemosyne` explicitly requests the optional peer package. |
| `DELOS_MEMORY_DB_PATH` | filesystem path | Required only when the backend is `mnemosyne`. Relative paths resolve against the selected Delos configuration file. |

No credential is accepted through either variable. Unsupported backend values are rejected with fixed text and are never echoed back to the terminal.

The environment seam is a host-local activation contract, not memory authority. Existing schemaVersion 1 and schemaVersion 2 provider configuration files therefore remain valid without migration, and the separately versioned `@delos/mnemosyne` package owns memory semantics.

## Package contract

Public Delos declares `@delos/mnemosyne` as an optional peer dependency on the `^0.1.0` line. Delos itself does not bundle that package.

Hosts consume stable package-root namespaces such as `Anamnesis`, `Governance`, and `Retention`. Delos does not import Mnemosyne service-file internals or copy its governance implementation.

A release that documents memory activation must therefore be published only after a compatible Mnemosyne release is available. Source in either repository is not the same state as a tagged package release or a deployed host.

## Startup semantics

Explicit memory activation is fail-closed.

Delos refuses startup when:

- `DELOS_MEMORY_BACKEND` is neither `off` nor `mnemosyne`;
- `mnemosyne` is requested without `DELOS_MEMORY_DB_PATH`;
- the optional package is not installed or cannot expose the required public API;
- the configured Mnemosyne database cannot be attached safely.

Startup errors use bounded public wording. Package-loader details and database contents are not surfaced.

Memory-off never imports or opens Mnemosyne.

## Per-turn recall

Once a memory-enabled runtime is attached, Delos asks Mnemosyne's public Anamnesis read path for context using the current user text and an explicit turn timestamp.

A successful memory packet is inserted as bounded **host-retrieved data**. It does not become system/persona authority, and it shares the same context budget rather than silently expanding the provider request.

If retrieval fails during a turn, Delos degrades to the ordinary memoryless path. It does not claim memory was used and it does not block a conversationally valid turn merely because optional recall was unavailable.

## Long-term admission and the single-ingress rule

Recall and durable admission are separate authorities.

Public Delos preserves the historical generic D0 decision path only in legacy compatibility mode. Set:

```bash
export DELOS_MEMORY_RETENTION=portable-retention
```

to make portable retention classification authoritative for new long-term admission.

Under portable retention authority:

- generic completed-turn receipts are stamped into an **evidence-only** ingress generation;
- the generic D0 worker cannot claim those receipts;
- older legacy D0 rows remain append-oriented evidence but are not bulk-drained by the retention lane;
- switching later back to legacy/off does not make retention-era parked receipts executable;
- the retention lane uses a separate decision backlog;
- the only ordinary long-term admission seam is Delos's retention-classified path, which calls the package-root `Retention.dispatchPortableRetention` contract;
- only a retention decision with `longTermCandidateAdmissionAllowed=true` may enter the ordinary governed long-term candidate lane.

Session-only, episodic, quarantined, and correction outcomes therefore do **not** become ordinary long-term candidates through the generic completed-turn path. `EPISODIC_ONLY` preserves evidence/episode value without promoting it to ordinary long-term memory.

This closes the dual-ingress failure mode where a legacy generic worker could otherwise become a second long-term admission authority beside retention-aware routing.

## Recovery and admin boundary

Public Delos currently has no separate memory-specific admin/recovery mutation surface that can re-decide historical evidence into Mnemosyne.

The generic backup/restore facility covers Delos-owned host state such as transcripts and non-secret local configuration; it is not a hidden Mnemosyne governance writer. Doctor remains inspection-oriented and does not repair memory authority.

If a future recovery mutation surface is added, it must obey the same retention/governance admission rules instead of creating a third writer.

## Authority boundaries

These remain separate:

```text
prompt/persona authority
!= durable transcript authority
!= Mnemosyne memory authority
!= provider-native session state
```

Delos owns host routing and conversation continuity. Mnemosyne owns governed memory lifecycle, curation, projections, recall policy, and durable memory mutation behind its package API.

Ordinary chat does not receive blanket authority to write durable memory. A host may enable an explicit governed decision runtime, but under portable retention authority ordinary long-term admission must pass the single retention-classified ingress described above.

## Path behavior

`DELOS_MEMORY_DB_PATH=./memory.db` resolves relative to the directory containing the selected Delos config file. It does not resolve against `process.cwd()`.

This is deliberate: invoking the same configuration from another shell directory must not silently select a different memory database.

Absolute paths are used as given.

## Privacy, verification, and publication

The repository must never contain a real memory database, transcript, provider credential, private prompt corpus or fixture derived from private conversation material. Tests for this integration use synthetic temporary data only.

Public verification proves only the exact public source revision that ran it. It does not prove private-source parity, package publication, deployment, or live activation.

The current non-embedding memory/governance/retention integration is public source. Embedding/vector/hybrid retrieval is intentionally outside this boundary and must be evaluated separately when that line is ready.
