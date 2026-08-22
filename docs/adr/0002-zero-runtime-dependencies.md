# 0002. Zero runtime dependencies in the core

Status: accepted (during Waves 1-6)

## Context

Every runtime dependency is supply-chain surface the user must trust and a
future maintenance obligation. The application's needs - HTTP, JSON, ZIP,
SQLite, processes - are all served by Node's standard library.

## Decision

The root package ships with zero runtime dependencies. HTTP uses native
fetch; archives are hand-rolled over `node:zlib`; persistence uses the
built-in `node:sqlite` (its experimental status is documented rather than
hidden; `better-sqlite3` was considered and rejected to keep zero native
build steps). The desktop shell keeps its own `package.json` so Electron
tooling never touches the root install.

## Consequences

`npm ci` at the root installs nothing executable from the network at
runtime. The cost is more first-party code (ZIP, wire clients), each under
its own tests.
