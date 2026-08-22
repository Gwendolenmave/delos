# Architecture principles

> **Delos provides stable universal sockets for a personal AI system.**
> Providers, accounts, models, interfaces, memory stores, tools and identities
> are replaceable implementations — not the product itself.

This is not a v0.1 requirement list. It is the standing shape of the project,
and it constrains every version. v0.1's command line is a **reference shell
for proving one vertical path**, not the product's boundary.

## What "low coupling" means here

It does **not** mean fewer features or less code.

It means: **any one part can be replaced without forcing the user to rebuild
the rest of their personal system.** A user who changes their model provider
should not lose their assistant's personality. A user who changes interface
should not migrate their memory. A user who renames their assistant should not
rename code or touch a database.

The test for any design decision is that sentence, not line count.

## The axes that must stay replaceable

### 1. Model connector

One core contract must be able to sit in front of an OpenAI-compatible API,
another vendor's API, an OAuth or account-based connection, a local model, or
a CLI/agent runtime.

v0.1 implements exactly one OpenAI-compatible adapter. Even so:

- **Core must not assume an API key is the only form of authentication.**
  Authentication belongs to a connector's own configuration and lifecycle.
- **HTTP, any single provider, and any specific model must not appear in the
  domain types.** The port already names failure *conditions* rather than
  transport mechanisms for exactly this reason.
- A future connector may declare its own auth strategy and capabilities.

### 2. Memory backend

Core must not bind to one store. Plain files, SQLite, a vector store, a remote
database, an external memory service, or something a user writes must all be
possible behind the same contract.

The memory **domain contract** and its **persistence implementation** are
separate concerns. No memory backend may require the user to change persona,
provider, or interface as a condition of using it.

### 3. Memory frontend

*How a user views, searches, edits, deletes, imports and exports memory* is
separate from *where memory is stored*.

A future web or desktop interface talks to a stable memory service contract.
It must never read or write a particular SQLite schema or file layout
directly, because that would weld the frontend to one backend and quietly
remove axis 2.

### 4. Surface and transport

The command line, a web interface, a desktop application, a messaging bridge —
all are adapters.

The core turn service must not know which surface a turn came from. Changing
surface must not change or migrate the user's persona, memory or provider
configuration.

### 5. Identity source

The filesystem prompt loader is **the default identity-source implementation,
not the only possible one.** Core depends on `PromptBundle` and nothing more.

A bundle may later come from a local prompt directory, an editor in a user
interface, an imported persona bundle, a synced folder, or a user-authored
source. Downstream modules must therefore never reach back to a file path or a
repository directory.

### 6. Tools and external connectors

Calendar, mail, file storage, code hosting and similar capabilities arrive as
connectors or plugins.

Installing one must never add a dedicated field to a core domain type or a
dedicated branch to persona logic. If it would, the seam is in the wrong place.

## Portable profile — planned after v0.1

A **Delos Profile** is a portable description of a user's instance, holding
non-secret configuration:

- active identity source
- model connector selection
- memory backend selection
- surface preferences
- enabled tools
- response and relationship configuration
- schema version

**Secrets are never written into a portable profile.** It carries secret
*references*; a new device asks the user to reconnect or re-authorise.

The experience this is meant to produce:

| the user changes | what should happen |
|---|---|
| computer | copy or import the profile and user data, reconnect secrets |
| provider | replace the model connector, nothing else |
| interface | core state untouched |
| memory backend | migrate through a stable export/import contract |
| persona | replace the identity bundle — no code renamed, no database migrated |

## First-run assembly

First run is where these sockets are connected, not merely where an API key is
pasted:

1. connect a model, account or runtime
2. choose or import an identity
3. choose relationship and response preferences
4. choose where local data and memory live
5. optionally connect tools
6. anchor the profile and enter Delos

Skipping persona customisation yields the shipped default identity. The
uninitialised state before assembly is a **lifecycle state**, never a persona
and never an architectural namespace.

## What this means for the modules that exist today

These now exist and run. None of them is a product boundary; each is one
implementation behind a seam that another may replace.

| module | what it actually is |
|---|---|
| `adapters/identity/filesystem/prompt-loader.ts` | the filesystem identity adapter — one implementation of axis 5 |
| `adapters/models/openai-compatible/` | the first model connector — one implementation of axis 1 |
| `adapters/config/filesystem/runtime-config.ts` | a **local runtime configuration**, deliberately too narrow to become the portable profile by accident |
| `core/services/recent-window.ts` | a temporary context strategy. **Not a memory system**, and it defines no shape a memory system must inherit |
| `core/services/turn-service.ts` | one turn. It owns no history and holds no state |
| `composition/create-runtime.ts` | the one place that knows the concrete wiring — a function, not a container |
| `surfaces/cli/` | the reference surface. A web or desktop surface would replace it and nothing beneath it |

## The restraint that makes this work

**Do not build a plugin system, a UI, or a wall of empty interfaces now.**

Speculative abstraction is its own kind of coupling: it fixes the shape of an
extension before anything real has tested it, and every later implementation
has to fight the guess.

The rule is narrower and harder:

- **Record extension seams explicitly** — in ports, in configuration, and in
  these documents.
- **Never close a replacement path** in a domain type, a schema, or a stored
  format.
- **Abstract when the second real implementation arrives**, and not before.

A seam that is documented but not yet abstracted is honest. An abstraction
with one implementation is a guess wearing a contract's clothes.
