# Delos

A lightweight, self-hosted personal assistant runtime that runs on your own machine.

> **Status: v0.2 source candidate.** This branch is still staging, not a published release or package. The candidate adds durable CLI conversation continuity and an optional Public Mnemosyne read path while keeping the model/runtime host provider-neutral.
>
> You bring your own model provider, credentials and local storage. Delos operates no service, account, subscription or telemetry.

Delos is named after the island where, in myth, Leto bore the twins Artemis and <!-- scan-allow-persona -->
Apollo. It was chosen deliberately over naming the project after a character:
Delos is a place that *hosted* a birth, and never claimed the ones born on it.

**Delos is where they are born, not who they must become.**

The assistant that ships with Delos is called **Arti**. She is a default, not a <!-- scan-allow-persona -->
requirement — you can rename her, rewrite her personality, or replace her
entirely, and the software will not pull you back toward the default.

## Quickstart

Requires **Node 22.22.0 or newer**.

```bash
npm install
npm run build

cp delos.config.example.json delos.config.json
# edit delos.config.json: choose your provider and model

# only if your provider profile names this environment variable
export DELOS_MODEL_API_KEY="your-key-here"

# one message, print the reply, exit
npm run start -- --once "Hello."

# an interactive conversation
npm run start
```

In an interactive session, type `/exit` or `/quit` to leave. `/clear` archives
the current CLI conversation and starts a fresh one. Completed interactive
turns are stored in Delos application data and can resume after restart inside
the same configuration/provider scope. One-shot `--once` invocations remain
isolated from that interactive continuity.

**Ctrl-C** ends the session under control rather than pretending an in-flight
provider request was cancelled. Delos stops accepting input, waits for the
current request to answer, fail or hit its provider deadline, then exits with
code `130`. A second Ctrl-C terminates immediately.

Exit codes: `0` success, `1` a failure explained on stderr, `2` a usage error,
`130` interrupted.

`--config <path>` selects a different configuration file. With no `--config`,
Delos reads `./delos.config.json` from the directory you run it in.

## Configuration

`delos.config.example.json` is the simple schemaVersion 1 layout. Its fields:

| field | required | meaning |
|---|---|---|
| `schemaVersion` | yes | `1` for the simple inline-provider layout. |
| `promptRoot` | yes | Directory holding prompt files. Relative paths resolve against the configuration file. |
| `provider.kind` | yes | `"openai-compatible"` in schemaVersion 1. |
| `provider.baseUrl` | yes | API root, normally ending in `/v1`; the full `/chat/completions` endpoint is refused. Plain HTTP is allowed only for loopback hosts. |
| `provider.model` | yes | Model identifier sent exactly as configured. |
| `provider.apiKeyEnv` | no | Name of an environment variable holding the credential. The credential itself never belongs in this file. |
| `provider.timeoutMs` | no | Whole-request deadline in milliseconds; defaults to `60000`. |
| `recentWindow.maxEstimatedTokens` | yes | Estimated budget for recent conversation/context. |
| `recentWindow.reserveTokens` | no | Budget reserved before recent history; defaults to `0`. |

Unknown fields are refused rather than silently ignored. Raw credential-like
fields such as `apiKey`, `token`, `password` or `secret` are not part of the
runtime config contract.

### Provider profiles

schemaVersion 2 supports multiple provider profiles — official OpenAI and
Anthropic protocols plus compatible relays/local servers — and an optional
default selection. Choose a profile with `--provider <id>` and probe it with
`--test-provider`. See `docs/PROVIDERS.md`, `docs/PROVIDER-PROFILES.md` and
`docs/SECRETS.md`.

## Optional long-term memory with Mnemosyne

Delos does **not** embed or copy the Mnemosyne implementation. Long-term governed
memory is a separate optional peer package: `@delos/mnemosyne`.

The v0.2 host activation contract is deliberately explicit and defaults off:

```bash
# after a compatible @delos/mnemosyne package is installed beside Delos
export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

`DELOS_MEMORY_BACKEND` accepts only `off` or `mnemosyne`. Unset is the same as
`off`; in that state Delos does not load the optional package. `mnemosyne`
requires `DELOS_MEMORY_DB_PATH`. A relative database path resolves against the
selected Delos configuration file, not the shell working directory.

Explicit activation is fail-closed at startup: if the optional package cannot
be attached, Delos refuses to pretend memory is active. Once running, a
per-turn retrieval failure degrades to the ordinary memoryless turn rather than
blocking the conversation. Retrieved memory is rendered as bounded host data;
it never becomes system/persona authority.

This staging branch does not claim that `@delos/mnemosyne` is already available
from the empty public destination repository or a registry. Publication order
must make a compatible Mnemosyne release available before a Delos release that
documents activation. See `docs/MEMORY.md` for the full boundary.

## What "self-hosted" means

Delos itself operates nothing. There is no Delos account, sign-in, subscription
or hosted backend. Configuration, prompts, transcript storage and any local
Mnemosyne database stay under the host's control.

The model may still be remote. If you configure a remote provider, the prompt,
selected recent conversation, current user message and any selected host
context are sent to that provider under its own privacy, retention and billing
terms. Pointing Delos at a local model keeps model traffic on your machine.

## Continuity and privacy boundaries

- Completed interactive CLI turns are durable local transcript state.
- Transcript recovery is scoped to the resolved configuration bytes and active provider identity so switching providers does not silently carry prior history across that boundary.
- Failed turns remain evidence but are not replayed as completed dialogue.
- Mnemosyne memory is optional and separate from transcript authority.
- Provider-native session history is not Delos memory authority.
- Delos does not store provider credentials in its JSON configuration.

## Honest limits in v0.2 candidate

- No streaming in the reference CLI reply path.
- No general tool/function-calling surface.
- No automatic provider retries that could silently duplicate a paid request.
- Ctrl-C does not claim to cancel an already in-flight provider request.
- The recent-window token budget is an estimate rather than a provider tokenizer.
- Mnemosyne integration in this candidate is a governed **read** path; Delos does not silently grant ordinary chat authority to write durable memory.
- Publication privacy/history gates are separate from this private staging branch's construction CI.

## The default persona lives in plain files

```
prompts/
├── identity.md         who the assistant is
├── relationship.md     how it relates to you
└── response-style.md   how it writes
```

Edit or replace them and the assistant changes. Persona identity is content,
not a code/schema/database identifier. Additional prompt blocks may be added;
the defaults load first when present, then additional sections in name order.

## Licence

**PolyForm Noncommercial License 1.0.0** — see `LICENSE` for the official text
and `LICENSE-NOTES.md` for a plain-language explanation. This is source-available
for noncommercial use, not an OSI-approved open-source licence. Commercial use
requires separate permission.

The project's licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

## Contributing

The project is under closed maintenance and is not accepting substantive
external code. Bug reports — especially cases where Delos is dishonest about
what it read, stored, resumed or remembered — are welcome. See
`CONTRIBUTING.md` and `PROJECT-SUCCESSION.md`.

---

[Design notes](docs/DESIGN-NOTES.md) · [Memory integration](docs/MEMORY.md)
