# 0003. Loopback-only daemon behind a startup session token

Status: accepted (Wave 7 Phase 4)

## Context

One local daemon serves every surface. Anything reachable beyond loopback,
or callable by another local process or web page, becomes an attack
surface for everything Delos stores.

## Decision

The daemon binds `127.0.0.1` only and refuses any other host at startup.
Every request carries a startup-generated session token in a header -
never a query string. The Origin check runs BEFORE the token comparison;
no CORS headers exist at all; bodies are bounded; errors have one public
shape with no stack traces or paths.

## Consequences

A hostile web page with a stolen token still fails on Origin. LAN and
remote access are out of scope by design, not by omission - a future
remote story must be its own decision record.
