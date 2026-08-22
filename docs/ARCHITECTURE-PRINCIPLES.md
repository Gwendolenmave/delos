# Delos architecture contract

This document is written for **agents and maintainers changing Delos**. It is normative. README files explain the product to people; this file explains what code may depend on what, where a change belongs, and which boundaries must not be crossed.

When code and this document disagree, do not guess. Inspect the current implementation and tests, then update whichever side is stale as part of the same change.

## 1. The system in one sentence

**Delos is a host runtime with replaceable providers, personas, surfaces, storage, and optional memory behind stable contracts.**

Replacing one implementation must not require rebuilding unrelated parts of the system.

A provider change must not migrate persona. A surface change must not fork transcript state. A persona rename must not rename runtime code or database tables. Enabling long-term memory must not grant memory system/persona authority.

## 2. Dependency direction

Use this direction unless a more specific rule below says otherwise:

```text
surfaces / desktop
        │
        ▼
composition / daemon
        │
        ▼
core services
        │
        ▼
core ports + domain types
        ▲
        │
adapters implement ports
```

### MUST

- `core/domain` and `core/ports` stay provider-, surface-, filesystem-, and database-neutral.
- Concrete providers, storage engines, prompt loaders, secret stores, and other integrations live under `adapters/`.
- Concrete wiring belongs in `composition/` or the daemon bootstrap path, not in domain types.
- Surfaces enter through supported runtime/application contracts instead of reaching directly into concrete storage.

### MUST NOT

- Core domain types must not contain provider-specific HTTP concepts, API-key assumptions, Telegram fields, desktop fields, or SQLite schema details.
- A surface must not become a second state owner for transcripts, persona, provider configuration, or memory.
- UI code must not read or mutate SQLite schemas directly.
- Persona identity must not become a code namespace, table name, environment variable prefix, or provider identity.
- A connector must not add special-case branches to unrelated persona logic.

## 3. Current ownership map

Use this table before editing. It describes where each kind of change belongs today.

| Concern | Owner / entry point | Rule |
| --- | --- | --- |
| Turn semantics | `core/services/turn-service.ts`, `turn-coordinator.ts` | Surface-neutral; no concrete provider/storage logic |
| Context assembly | `core/services/context-assembly.ts`, recent-window/current-situation services | Inputs are data with explicit trust/authority boundaries |
| Provider contract | `core/ports/provider.ts`, `model-provider.ts` | Core names capabilities/failure semantics, not vendor transport |
| Concrete providers | `adapters/providers/`, `adapters/models/` | Implement provider ports here |
| Provider selection | `adapters/providers/registry.ts`, runtime config | Registry/config concern, not core branching |
| Persona loading | `adapters/identity/`, `adapters/persona/` | Persona is content loaded through contracts |
| Transcript persistence | `adapters/transcripts/sqlite-transcript-store.ts` | Storage implementation; callers depend on transcript port |
| Secrets | `core/ports/secret-store.ts`, `adapters/secret-store/` | Ordinary config carries references, not credential values |
| Optional long-term memory | `core/ports/memory-context.ts`, `adapters/memory/` | Optional host data path; must not become persona/system authority |
| Runtime wiring | `composition/create-runtime-base.ts`, `composition/create-runtime.ts` | Concrete assembly belongs here |
| Local daemon | `surfaces/daemon/` | Owns the local application boundary and shared surface API |
| CLI | `surfaces/cli/` | Reference interactive surface |
| Web | `surfaces/web/` | Uses the shared local runtime boundary |
| Telegram | `surfaces/telegram/` | Transport adapter; not a separate assistant runtime |
| Desktop | `desktop/` | Lifecycle/shell around the same local runtime |

If a proposed change does not fit one row, first decide whether a new seam is genuinely needed. Do not add an abstraction merely because a future implementation might exist.

## 4. Stable replacement axes

### 4.1 Provider

A provider may be an official API, compatible relay, local model server, account-based/delegated runtime, or another implementation of the provider contract.

Rules:

- Authentication belongs to the provider/secret-store edge.
- Core must not assume authentication means `Authorization: Bearer <api-key>`.
- Provider-specific request/response translation stays in adapters.
- Adding a provider should normally require: adapter + registry/config + tests + docs, **not** changes to turn semantics or persona files.

### 4.2 Persona

Persona is content, not product identity.

Rules:

- Default plain files and persona packs are implementations of identity loading.
- Downstream code consumes resolved persona/prompt data, not repository paths.
- Renaming or replacing a persona must not require code/database migration.
- Contextual variants may change supplied persona content, but must not change core architecture.

### 4.3 Surface

CLI, web, desktop, Telegram, and future surfaces are interfaces to the same runtime.

Rules:

- A new surface should use the existing daemon/client/turn boundary where applicable.
- It must not create its own canonical transcript, memory, provider registry, or persona store.
- Surface-only UX state may remain surface-local; assistant state may not fork silently.

### 4.4 Storage

Persistence implementation is separate from domain meaning.

Rules:

- SQLite schemas are adapter details.
- Frontends and core services use ports/services, not SQL.
- A storage replacement may require explicit migration tooling, but must not force provider/persona/surface migration.

### 4.5 Long-term memory

Delos can operate without long-term memory. Mnemosyne is the reference governed memory package.

Rules:

- Memory is opt-in and defaults off.
- Explicit activation that cannot be attached must fail closed at startup.
- Per-turn memory retrieval failure may degrade to a memoryless turn where the runtime contract allows it; it must not fabricate success.
- Retrieved memory is bounded host data. It must never be promoted to system/persona authority merely because it was retrieved.
- Ordinary chat must not gain durable-write authority implicitly.

See `docs/MEMORY.md` for the integration contract.

### 4.6 Secrets

Rules:

- Credential values never belong in ordinary JSON config, portable persona/profile data, transcript state, or memory records.
- Config stores secret references; the active secret-store resolves values at use time.
- Backup/export code must preserve this separation.

## 5. Runtime assembly

Concrete assembly belongs at the composition/bootstrap edge.

Conceptually:

```text
config
  ├─> provider profile ─> provider adapter
  ├─> persona source ───> resolved prompt/persona
  ├─> transcript config -> transcript store
  ├─> optional memory ---> memory adapter
  └─> surface config ----> CLI / daemon / Telegram / desktop

all concrete pieces
        │
        ▼
composition / runtime
        │
        ▼
turn coordinator + core services
```

Do not move this knowledge downward into domain types to make wiring “easier”. The fact that composition knows concrete implementations is intentional.

## 6. Turn authority rules

These rules matter more than convenience:

1. System/persona instructions come from the configured persona/system authority path.
2. Transcript/history/context are data supplied to the turn, not new system authority.
3. Retrieved Mnemosyne memory is host context data, not system authority.
4. The current user message remains the current user message; helper context must not impersonate it.
5. Provider output is untrusted model output until the surface/runtime handling path accepts and delivers it.
6. Failure receipts and persisted state must describe what actually happened. Never report a read, write, delivery, backup, or recovery as successful unless it completed.

## 7. How to add common features

### Add a provider

1. Implement the provider contract under `adapters/providers/` or `adapters/models/`.
2. Register/configure it at the provider registry/config edge.
3. Add contract and runtime tests.
4. Update provider docs.
5. Do **not** add vendor branches to turn-service, persona, or transcript domain types.

### Add a surface

1. Reuse the daemon/client or established turn boundary.
2. Keep surface UX state local.
3. Reuse canonical provider/persona/transcript/memory state.
4. Add surface-specific tests.
5. Do **not** fork a second assistant runtime.

### Add or replace persona handling

1. Produce the same resolved persona/prompt contract from a new source.
2. Keep identity names/content outside code identifiers and database schema.
3. Test replacement without provider/storage changes.

### Add a memory implementation

1. Implement the memory-context/host contract at the adapter edge.
2. Preserve data-vs-authority rules.
3. Make activation explicit.
4. Define startup and per-turn failure behavior.
5. Do not teach unrelated core modules about its storage schema.

## 8. What not to abstract prematurely

A documented seam is enough until a second real implementation proves the abstraction.

Do not create plugin frameworks, generic containers, or empty interface families only to make the architecture look extensible. A wrong abstraction is coupling with nicer names.

Create a new abstraction when:

- two real implementations need the same stable contract; or
- an existing concrete dependency is actively preventing replacement.

## 9. Agent acceptance checklist

Before finishing a structural change, answer all of these with evidence:

- Did any provider-specific detail leak into `core/domain` or unrelated core services?
- Did any surface become a new canonical state owner?
- Did persona identity become encoded in code/schema/config names?
- Did any credential value enter ordinary config, logs, transcripts, memory, fixtures, or backups?
- Did memory/context gain system/persona authority accidentally?
- Can the changed implementation still be replaced without migrating unrelated axes?
- Are startup and failure semantics explicit and truthful?
- Do tests cover the new boundary, not only the happy path?
- Did docs change if the actual architecture changed?

If any answer is uncertain, the task is not finished.
