# Delos

[简体中文](README.zh-CN.md)

**Keep the assistant. Swap the machinery.**

Delos is a local-first runtime for personal AI. It keeps the parts that usually get glued together — **persona, model access, conversation state, interfaces, and long-term memory** — behind separate boundaries.

That matters when you want to change one thing without rebuilding everything else. Switch providers without rewriting the persona. Add a Telegram or web interface without creating a second assistant. Replace the persona without renaming runtime code. Add long-term memory only when you actually want it.

Delos itself runs on your machine. It operates no hosted service, account system, subscription, or telemetry backend. The model path and storage boundary are yours to choose.

## Start here

| I want to… | Start with |
| --- | --- |
| run Delos locally and chat | [Quick start](#quick-start) |
| use a different model or provider | [Providers](docs/PROVIDERS.md) + [provider profiles](docs/PROVIDER-PROFILES.md) |
| change who the assistant is | [`prompts/`](prompts/) + [persona packs](docs/PERSONA-PACKS.md) |
| add governed long-term memory | [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne) + [memory integration](docs/MEMORY.md) |
| add or integrate another interface | [Surface API](docs/SURFACE-API.md) |
| modify Delos itself | **read [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) first** |
| back up, restore, or diagnose local state | [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md) |

## Quick start

Requires **Node.js 22.22 or newer**.

```bash
npm install
npm run build

cp delos.config.example.json delos.config.json
# edit delos.config.json and choose a provider + model

# only if your provider profile refers to this environment variable
export DELOS_MODEL_API_KEY="your-key-here"

# send one message and exit
npm run start -- --once "Hello."

# or start an interactive session
npm run start
```

Interactive sessions keep completed turns locally so the same configuration/provider scope can resume after restart. `/clear` starts a fresh conversation; `/exit` and `/quit` leave the session. `--once` stays isolated from interactive continuity.

## The idea in one diagram

```text
CLI / Web / Desktop / Telegram
              │
              ▼
        Delos runtime
   ┌──────────┼──────────┐
   ▼          ▼          ▼
Persona    Provider   Transcript
 files      adapter      store
   │          │          │
   └──────────┴──────┬───┘
                     ▼
             optional Mnemosyne
```

The important part is not the boxes. It is the **seams between them**:

- **Persona is content.** Identity and response style live in readable files instead of being baked into application code.
- **Providers are replaceable.** OpenAI, Anthropic, compatible APIs, local model servers, and delegated providers sit behind provider contracts.
- **Interfaces share one runtime.** CLI, browser, desktop, and Telegram are surfaces over the same assistant state rather than separate assistants.
- **Long-term memory is optional.** Delos can run without it; [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne) adds governed long-term memory when enabled.

## Common changes

### Change the model without changing the assistant

Provider profiles describe **how to reach a model**. Credentials are referenced separately rather than stored directly in ordinary configuration.

Use [Providers](docs/PROVIDERS.md) to understand protocol behavior, [Provider profiles](docs/PROVIDER-PROFILES.md) for configuration examples, and [Secrets](docs/SECRETS.md) for credential handling.

### Change the assistant without changing the runtime

The default persona is plain text:

```text
prompts/
├── identity.md
├── relationship.md
└── response-style.md
```

Edit or replace those files to change the assistant. For portable manifests, variants, and contextual activation, use [Persona packs](docs/PERSONA-PACKS.md).

The repository also ships with an example persona named **Arti**. She is a default example, not Delos's product identity. <!-- scan-allow-persona -->

### Add long-term memory when you need it

Delos owns the runtime and local conversation continuity. Mnemosyne is a separate memory package and is **off by default**.

```bash
npm install github:Gwendolenmave/mnemosyne

export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

If you explicitly require Mnemosyne and Delos cannot attach it correctly, startup fails closed instead of pretending memory is active. Retrieved memory remains bounded host data; it does not become system/persona authority.

See [Memory integration](docs/MEMORY.md) for the full boundary.

### Add another interface without creating another assistant

A surface should enter through the shared runtime boundary, not create its own transcript, provider registry, persona store, or memory system.

Use [Surface API](docs/SURFACE-API.md) for the integration contract. [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md) explains the daemon/browser layout, and [Surfaces beyond the browser](docs/SURFACES-BEYOND-THE-BROWSER.md) covers desktop, Telegram, and delegated-provider edges.

## Local-first means you choose the network boundary

Delos does not send data to a “Delos cloud.” Network traffic depends on the provider path you configure.

- A remote provider receives the prompt and selected context needed for that turn under its own terms.
- A local model can keep model traffic on the host machine.
- Credentials should not live in ordinary Delos JSON configuration.
- Transcripts, local state, persona files, and an optional Mnemosyne database stay inside the host's storage boundary.

## If you are changing the code

README is the human map. [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) is the normative contract for agents and maintainers.

The most useful next documents are:

- **model access:** [Providers](docs/PROVIDERS.md), [Provider profiles](docs/PROVIDER-PROFILES.md), [Secrets](docs/SECRETS.md)
- **identity:** [Persona packs](docs/PERSONA-PACKS.md)
- **memory:** [Memory integration](docs/MEMORY.md)
- **interfaces:** [Surface API](docs/SURFACE-API.md), [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md)
- **operations:** [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md)

When implementation and Architecture disagree, inspect the current code and tests rather than guessing which one is authoritative.

## Why the name Delos?

In Greek myth, Delos is a place of birth. The name fits the design goal: the runtime can host an identity without defining that identity for it.

**Delos is where they are born, not who they must become.**

## Licence and maintenance

Delos uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md). It is source-available for noncommercial use; commercial use requires separate permission.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance and is not accepting substantive external code contributions. Bug reports remain welcome; see [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
