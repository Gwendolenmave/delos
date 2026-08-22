# The local surface API

Every Delos surface - the web application today, desktop, Telegram and a
future PWA later - speaks to the daemon through one versioned HTTP API on
loopback. Nothing else is a supported integration point.

## Connecting

- The daemon binds `127.0.0.1` on a free port and refuses any other host.
- Authentication is a **startup-generated session token**, sent as the
  `x-delos-session` header on every request. It is never accepted in a query
  string. The web page served by the daemon itself carries the token in a
  meta tag; that page's origin is the only origin the daemon accepts.
- Version negotiation: `GET /api/v1/health` returns `apiVersion`; the typed
  client refuses to operate across an API major version it does not know.
- `GET /api/v1/schema` returns the machine-readable route inventory.

## The typed client

`surfaces/api-client/client.ts` is the one client every surface uses - typed
DTOs, the connect() handshake, typed errors, and SSE event streaming parsed
from the response body (EventSource cannot send headers, and lowering auth
into a query string is exactly what the daemon refuses). A future PWA
connects through this same contract. LAN access, internet relays, cloud sync
and multi-device pairing are explicitly out of scope for v0.1.

## Events

`GET /api/v1/conversations/:id/events` is an SSE stream: `turn-accepted`,
`variants` (the resolved variant metadata for the turn), `context` (the
content-free assembly report), `assistant-text` (buffered output - providers
that cannot stream still emit through the same contract), `turn-completed`,
`turn-failed`.

## Idempotency

`POST /api/v1/conversations/:id/messages` requires an `idempotencyKey`. The
same key never runs the model twice - across retries, concurrent duplicates,
and daemon restarts - and returns the stored result with `reused: true`.
Surfaces mint the key when a send is attempted and keep it until the send
succeeds.

## Errors

One public shape: `{ "error": { "code", "message" } }`. No stack traces, no
paths, no prompts, no credentials. Cancellation currently answers `501` with
its reason - honestly unsupported rather than pretended.
