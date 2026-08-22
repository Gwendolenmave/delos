# Providers

Delos speaks to a model through a **provider profile** — a small, non-secret
document naming a protocol, an endpoint, a model, and where a credential can
be found. This page explains the four provider kinds and how their protocols
differ. The profile format itself is in `PROVIDER-PROFILES.md`, and credential
handling is in `SECRETS.md`.

## The four kinds

| kind | protocol spoken | endpoint | auth convention |
|---|---|---|---|
| `openai` | OpenAI **Responses** (`POST /v1/responses`) | official | `Authorization: Bearer` |
| `openai-compatible` | OpenAI **chat completions** (`POST {root}/chat/completions`) | yours | your choice |
| `anthropic` | Anthropic **Messages** (`POST /v1/messages`) | official | `x-api-key` |
| `anthropic-compatible` | Anthropic **Messages** | yours | your choice |

**Official and compatible are different things, deliberately.** The official
OpenAI adapter speaks the Responses API — the interface OpenAI's current
documentation presents as primary — while the compatible adapter speaks chat
completions, the wire format local servers and relays actually implement.
Diagnostics always name the protocol actually spoken, and a compatible relay
is never described as "official OpenAI".

## Protocol differences that matter

- **System content.** The Responses protocol carries the assembled persona in
  a dedicated `instructions` field; chat completions carries it as a leading
  `system` message; the Anthropic Messages protocol carries it in a top-level
  `system` field and has **no system role at all**. Each adapter uses its
  protocol's own convention — none of them fakes one protocol over another.
- **Authentication.** Official Anthropic uses the `x-api-key` header, not a
  bearer token. The two are not interchangeable, and the adapters do not
  pretend they are.
- **Required fields.** The Messages protocol requires `max_tokens`; the
  adapter supplies a documented default output budget.
- **Version headers.** The Anthropic adapters manage `anthropic-version`
  internally. A profile can neither remove it nor supply its own — a silently
  altered protocol version changes what every other field means.

## Official kinds are pinned

An `openai` or `anthropic` profile is a claim, and the profile cannot make it
falsely: **`baseUrl` is refused**, the auth transport is fixed to the official
protocol's shape (`bearer` for OpenAI, `x-api-key` for Anthropic), and a
credential is required. A profile wanting a different endpoint or transport is
a *compatible* profile and says so. This is what makes it impossible to point
an official credential at a profile-supplied host. Omitting `auth` entirely on
an official profile defaults it to the conventional environment variable.

**Official OpenAI requests carry `store: false`** on every request, including
connection tests, with no switch to turn it off in this version: Delos is
local-first and does not opt you into avoidable provider-side response-state
retention. This does not eliminate the provider's abuse-monitoring retention
and does not override your account's own data-control policy.

## Redirects are refused

Provider requests can carry credentials, so Delos **never follows an HTTP
redirect** (301, 302, 303, 307 or 308) on provider calls. That rule applies to
both the simple schemaVersion 1 OpenAI-compatible path and the four
schemaVersion 2 HTTP profile adapters. A redirecting endpoint surfaces as a
safe protocol/provider error that names neither the target nor anything from
the exchange; configure the final endpoint directly.

## Deadlines and cancellation

`timeoutMs` is a hard whole-exchange deadline: it covers connection/request,
status handling, and reading/parsing the complete response body. Delos also
hard-bounds the public/injected transport seam itself, so a custom `FetchLike`
that ignores `AbortSignal` cannot make an expired exchange hang forever or
turn a late response into success.

The profile HTTP core composes caller cancellation with that same bound. An
already-cancelled request does not invoke the transport. The reference CLI
still deliberately does not claim that its first Ctrl-C cancels an already
in-flight provider call; it waits for the call to finish or reach its provider
deadline, as documented in the README.

Delos does **not** automatically retry a failed provider request. Retryable
classification is evidence for a caller or future policy layer, not permission
to silently duplicate a request that may be billable or may already have been
processed remotely.

## Requested versus served model

Every result records the model you **requested** and, when the provider's
metadata evidenced it, the model that actually **served** the request. A
mismatch is reported, never repaired, and never guessed: if the provider sent
no model metadata, the served model is *unknown*, not assumed.

## Connection testing

```bash
node build/surfaces/cli/main.js --config delos.config.json --test-provider
```

The test runs the **real** provider path with the smallest message the
protocol accepts — a TCP connection is not evidence that a credential works or
a protocol is spoken. It reports profile validity, credential resolution,
endpoint acceptance, requested/served model, latency and protocol. The probe's
reply text is discarded and never enters a conversation.

## Errors

Failures are normalised into stable categories (`authentication-failed`,
`rate-limited`, `timeout`, `connection-failed`, `malformed-response`, and so
on) with a safe message, a retryable flag and, where relevant, a redacted
HTTP status. Provider error bodies are never read into messages, and every
surfaced error passes through central credential redaction — including errors
from providers that echo request headers back.

## Field note: a real provider loss and recovery

A private Delos deployment recovered from the loss of one delegated provider
by adding another behind the same port. Prompt assembly, transcripts, memory,
and the conversation surface remained in place; provider-specific
authentication, process protocol, proxy handling, and optional capabilities
stayed inside the adapter and deployment boundary.

See [Provider recovery field note](PROVIDER-RECOVERY-FIELD-NOTE.md) for the
parallel-adapter sequence, authentication and proxy boundaries, live preflight,
private transcript replay, capability gates, receipts, and rollback checklist.
The note is an architecture guide, not a claim that every described delegated
route is enabled in the v0.2 public source candidate.

## Not yet implemented

This public candidate does not yet provide browser setup, desktop credential
storage, public Codex delegated-login setup, public Claude Code delegated-login
setup, Telegram, or persona-pack import. Durable reference-CLI conversation
continuity **is** implemented in v0.2; see the README for its configuration and
provider-scoped recovery boundary.
