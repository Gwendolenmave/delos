# 0007. Delegated providers: the installed tool owns its login

Status: accepted (Wave 7 Phase 5)

## Context

Codex and Claude Code arrive with their own authenticated CLIs. The
tempting integration - lift their stored tokens - would make Delos a
credential parser of other vendors' private state.

## Decision

Delegated profiles carry auth "none" BY VALIDATION: they cannot hold a
credential, an endpoint, or headers. The adapters spawn the installed tool
without a shell in a bounded working directory (fail-closed when no bound
is supplied), never read credential files (asserted against the compiled
output), inspect auth state only through the tool's official surface, and
route an unauthenticated tool to its own documented login flow. An
Anthropic API key and a Claude subscription login are different
authentication modes and are never conflated.

## Consequences

Real interoperability is proven against committed fake executables;
integration with an installed tool stays truthfully DEGRADED until
observed. No Delos artifact can contain another vendor's token.
