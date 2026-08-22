# Secrets

How Delos handles credentials, and the properties you can rely on.

## The rule

**Nothing above the secret store ever holds a credential.** Configuration and
provider profiles carry *references* — a `secretId` such as
`provider:my-relay` or `env:OPENAI_API_KEY` — and the store resolves a
reference to a value at the moment of use. That is what makes a profile a
plain, shareable document: there is nothing secret in it to leak.

## Where credentials live

**Environment variables** are the supported source in this foundation. A
profile whose auth uses `"source": "environment"` names its variable
explicitly:

```json
"auth": { "transport": "bearer", "source": "environment", "envVar": "OPENAI_API_KEY" }
```

The store reads **exactly the named variable**. It never enumerates the
environment — not for listing, not for diagnostics — and a test enforces this
with a proxy that fails the suite if anything walks the environment.

An **in-memory store** exists for tests and type-it-once sessions: nothing is
written to disk, so there is no file to leak, forget, or commit. Durable
desktop credential storage (OS keychain) belongs to a later stage and will sit
behind the same port.

Delos never creates a `secrets.json`, never generates a `.env`, and refuses a
profile carrying a credential value in any field at any nesting depth.

## Opaque tokens

A credential is an opaque string. Delos does not trim it, does not transform
it, and **does not judge its shape** — a token is not rejected for lacking an
`sk-` prefix, and a relay token with no recognisable shape is handled
identically to an official one.

An *empty* variable is reported as "set but empty" rather than "missing",
because you did set it, and "missing" would send you to fix the wrong thing.

## How a credential travels

The profile's `transport` decides placement on the request — `bearer`,
`x-api-key`, or a `custom-header` you name — and placement is the only thing
the credential is used for. It appears in no URL, no log, no error, no test
report, and no profile export.

## Redaction

Every provider-facing error passes through central redaction with two
independent strategies:

1. **Known values** — whatever the store resolved for this request is removed
   wherever it appears, including inside error `cause` chains. This catches a
   provider that echoes your credential back at you.
2. **Shapes** — `Authorization`/`x-api-key`/`api-key` headers in any casing,
   `Bearer` values in any casing, URL userinfo, and common credential query
   parameters are removed even when the value was never known.

The repository scanner enforces the same rules on the codebase itself: a
key-shaped literal, a key-named constant with a long opaque value, an
auth-header line in a fixture, or a credential-bearing URL all fail the scan.
