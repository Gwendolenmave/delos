# Delos ↔ Mnemosyne integration

Delos is the conversation/runtime host. Mnemosyne is the separately packaged long-term-memory system. Delos consumes the public `@delos/mnemosyne` package API and does not copy Mnemosyne source into its own tree.

## Runtime activation

Memory is opt-in and defaults off.

```bash
export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

The contract is intentionally small:

| variable | values | meaning |
|---|---|---|
| `DELOS_MEMORY_BACKEND` | unset, `off`, `mnemosyne` | Unset/`off` keeps the established memoryless Delos path. `mnemosyne` explicitly requests the optional peer package. |
| `DELOS_MEMORY_DB_PATH` | filesystem path | Required only when the backend is `mnemosyne`. Relative paths resolve against the selected Delos configuration file. |

No credential is accepted through either variable. Unsupported backend values are rejected with fixed text and are never echoed back to the terminal.

The environment seam is a host-local activation contract, not memory authority. Existing schemaVersion 1 and schemaVersion 2 provider configuration files therefore remain valid without migration, and the separately versioned `@delos/mnemosyne` package owns memory semantics.

## Package contract

Public Delos declares `@delos/mnemosyne` as an optional peer dependency on the `^0.1.0` line. Delos itself does not bundle that package.

A release that documents memory activation must therefore be published only after a compatible Mnemosyne release is available. The current private staging branch is construction evidence and does not claim that the empty public destination repository or a registry already provides the package.

## Startup semantics

Explicit memory activation is fail-closed.

Delos refuses startup when:

- `DELOS_MEMORY_BACKEND` is neither `off` nor `mnemosyne`;
- `mnemosyne` is requested without `DELOS_MEMORY_DB_PATH`;
- the optional package is not installed or cannot expose the required public API;
- the configured Mnemosyne database cannot be attached safely.

Startup errors use bounded public wording. Package-loader details and database contents are not surfaced.

Memory-off never imports or opens Mnemosyne.

## Per-turn semantics

Once a memory-enabled runtime is attached, Delos asks Mnemosyne's public Anamnesis read path for context using the current user text and an explicit turn timestamp.

A successful memory packet is inserted as bounded **host-retrieved data**. It does not become system/persona authority, and it shares the same context budget rather than silently expanding the provider request.

If retrieval fails during a turn, Delos degrades to the ordinary memoryless path. It does not claim memory was used and it does not block a conversationally valid turn merely because optional recall was unavailable.

## Authority boundaries

These remain separate:

```text
prompt/persona authority
!= durable transcript authority
!= Mnemosyne memory authority
!= provider-native session state
```

Delos currently integrates the governed Mnemosyne **read** path. Ordinary chat does not receive blanket authority to write durable memory. Governance, memory lifecycle, projection recovery and recall policy remain Mnemosyne responsibilities behind its package API.

## Path behavior

`DELOS_MEMORY_DB_PATH=./memory.db` resolves relative to the directory containing the selected Delos config file. It does not resolve against `process.cwd()`.

This is deliberate: invoking the same configuration from another shell directory must not silently select a different memory database.

Absolute paths are used as given.

## Privacy and publication

The repository must never contain a real memory database, transcript, provider credential, private prompt corpus or fixture derived from private conversation material. Tests for this integration use synthetic temporary data only.

Passing private staging CI is not publication proof. A real public release still requires publication-shaped history/privacy scanning after the destination repository is populated under separate authorization.
