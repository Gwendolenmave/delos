# Provider profiles

A provider profile is a versioned, **non-secret** JSON document describing one
way to reach one model. Profiles live in your configuration file under a
schemaVersion 2 layout.

## A complete configuration

```json
{
  "schemaVersion": 2,
  "promptRoot": "./prompts",
  "providers": [
    {
      "schemaVersion": 1,
      "id": "local-model",
      "displayName": "Local Model",
      "kind": "openai-compatible",
      "model": "example-model",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "auth": { "transport": "none" }
    },
    {
      "schemaVersion": 1,
      "id": "openai-official",
      "kind": "openai",
      "model": "example-openai-model",
      "auth": { "transport": "bearer", "source": "environment", "envVar": "OPENAI_API_KEY" }
    },
    {
      "schemaVersion": 1,
      "id": "anthropic-official",
      "kind": "anthropic",
      "model": "example-anthropic-model",
      "auth": { "transport": "x-api-key", "source": "environment", "envVar": "ANTHROPIC_API_KEY" }
    },
    {
      "schemaVersion": 1,
      "id": "my-relay",
      "kind": "anthropic-compatible",
      "model": "example-model",
      "baseUrl": "https://relay.example/anthropic",
      "auth": {
        "transport": "custom-header",
        "source": "environment",
        "envVar": "MY_RELAY_TOKEN",
        "headerName": "X-Gateway-Auth"
      },
      "headers": { "X-Gateway-Region": "local" }
    }
  ],
  "defaultProvider": "local-model",
  "recentWindow": { "maxEstimatedTokens": 8000 }
}
```

Select at run time with `--provider <id>`; otherwise `defaultProvider` (or the
only profile) is used. The schemaVersion 1 single-provider layout keeps
working unchanged — it is the simplest environment-driven path and the README
quickstart uses it.

## Fields

| field | required | meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1` (the profile schema's own version). |
| `id` | yes | Stable, lowercase, path-safe: letters, digits, hyphens, ≤64 chars. Duplicates are refused across a configuration. |
| `displayName` | no | Defaults to the id. |
| `kind` | yes | `openai`, `openai-compatible`, `anthropic`, `anthropic-compatible`. |
| `model` | yes | Sent exactly as written. Not validated against any hard-coded model list — providers add models faster than software releases. |
| `baseUrl` | compatible kinds: yes | The **API root**, not an endpoint. The adapter appends its own protocol path. **Official kinds refuse it** — use a `-compatible` kind for any other endpoint. |
| `auth.transport` | yes | How the credential is placed: `bearer`, `x-api-key`, `custom-header`, `none`. Official kinds are pinned to their protocol's shape (`bearer` for `openai`, `x-api-key` for `anthropic`) and refuse `none`; omitting `auth` entirely on an official kind defaults it to the conventional environment variable. |
| `auth.source` | no | Where it lives: `environment`, `secret-store`, `none`. Defaults sensibly from the transport. |
| `auth.envVar` | environment source: yes | The variable to read. The reference id `env:<VAR>` is derived from it. |
| `auth.secretId` | secret-store source: yes | A reference, never a value. |
| `auth.headerName` | custom-header: yes | A valid, non-forbidden header name. |
| `timeoutMs` | no | 1000–600000; default 60000. Covers the whole exchange including reading the reply. |
| `headers` | no | Extra non-secret headers. |
| `enabled` | no | Default `true`. |

## What a profile refuses

The refusals are the design: a profile that can carry a secret is a profile
that will eventually leak one.

- any credential-named field (`apiKey`, `token`, `secret`, …) at any nesting
  depth — the refusal names the field and never echoes the value;
- credentials embedded in the URL (userinfo), query strings, fragments,
  non-HTTP schemes;
- framing headers (`Host`, `Content-Length`, `Connection`, …) — configuration
  must not become a request-smuggling primitive;
- auth headers riding in as "extra" headers, even under custom-header
  transport — the credential comes from the store, never from the profile;
- header values containing control characters (header injection);
- timeouts outside the documented bounds;
- unsupported schema versions and duplicate ids.

There is **no token-prefix validation** anywhere: an opaque relay token is as
valid as an `sk-` one.

## Split of source and transport

Where a credential is stored and how it is placed on the wire are independent
questions. An environment-stored credential sent as `X-Api-Key`, a
store-resolved credential sent as `Bearer` — any combination is expressible
without new profile kinds, which is why relays need no named presets.
