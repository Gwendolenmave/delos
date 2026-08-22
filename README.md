# Delos

A local-first, self-hosted personal assistant runtime that runs on your own machine.

Delos keeps the assistant runtime, provider choice, local transcripts, persona files, and optional long-term memory under the host's control. It does not operate a hosted service, account, subscription, or telemetry backend.

Delos is named after the island where, in myth, Leto bore Artemis and <!-- scan-allow-persona -->
Apollo. The name describes a place that hosts an identity rather than defining it:

**Delos is where they are born, not who they must become.**

The bundled example persona is **Arti**. She is a default, not a requirement. Persona identity is plain content and can be renamed, rewritten, or replaced without changing the runtime architecture.

## Quickstart

Requires **Node.js 22.22 or newer**.

```bash
npm install
npm run build

cp delos.config.example.json delos.config.json
# edit delos.config.json: choose your provider and model

# only when your provider profile references this environment variable
export DELOS_MODEL_API_KEY="your-key-here"

# one message, print the reply, exit
npm run start -- --once "Hello."

# interactive conversation
npm run start
```

In an interactive session, `/exit` or `/quit` leaves the session and `/clear` archives the current CLI conversation and starts a fresh one. Completed interactive turns are stored locally and can resume after restart inside the same configuration/provider scope. One-shot `--once` runs remain isolated.

## Providers

Delos can use official OpenAI and Anthropic protocols, OpenAI-compatible relays or local servers, and delegated local provider tools. Provider profiles are non-secret configuration; credentials stay behind the secret-store boundary.

Start with:

- [Providers](docs/PROVIDERS.md) for supported provider kinds and protocol behavior.
- [Provider profiles](docs/PROVIDER-PROFILES.md) for configuration examples.
- [Secrets](docs/SECRETS.md) for credential handling.

## Optional long-term memory with Mnemosyne

Long-term memory is provided by the separate public package [`@delos/mnemosyne`](https://github.com/Gwendolenmave/mnemosyne). It is optional and defaults off.

Install Mnemosyne beside Delos:

```bash
npm install github:Gwendolenmave/mnemosyne
```

Then enable it explicitly:

```bash
export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

If Mnemosyne is explicitly enabled but cannot be attached, startup fails closed instead of pretending memory is active. Retrieved memory is bounded host data and never becomes system/persona authority.

See [Memory integration](docs/MEMORY.md) for the full boundary.

## Personas

The assistant's identity and response style live in plain files rather than code or database identifiers.

```text
prompts/
├── identity.md
├── relationship.md
└── response-style.md
```

Persona packs add a portable manifest, variants, and contextual activation rules. See [Persona packs](docs/PERSONA-PACKS.md).

## Surfaces

The same runtime can be reached through the CLI, browser UI, desktop shell, or Telegram surface. Local surfaces use the daemon's versioned loopback API instead of creating separate assistant implementations.

- [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md)
- [Surface API](docs/SURFACE-API.md)
- [Desktop, Telegram, and delegated providers](docs/SURFACES-BEYOND-THE-BROWSER.md)

## Privacy and local ownership

Delos itself sends data only where the configured model/provider path requires it. A remote model provider receives the prompt and selected conversation/context needed for a turn under that provider's own privacy, retention, and billing terms; pointing Delos at a local model keeps model traffic on the host machine.

Credentials do not belong in Delos JSON configuration. Runtime transcripts, local state, persona data, and an optional Mnemosyne database stay under the host's storage boundary.

Backup, restore, and health tooling are described in [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md).

## Architecture

Delos is deliberately low-coupling: providers, models, identities, interfaces, memory stores, and tools are replaceable implementations around stable runtime contracts. Changing one should not force the user to rebuild the rest of the system.

See [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md).

## Documentation

| Document | Use it for |
| --- | --- |
| [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) | runtime ownership and dependency boundaries |
| [Providers](docs/PROVIDERS.md) | supported provider kinds and protocol behavior |
| [Provider profiles](docs/PROVIDER-PROFILES.md) | model/provider configuration |
| [Secrets](docs/SECRETS.md) | credential storage and references |
| [Memory integration](docs/MEMORY.md) | connecting Mnemosyne |
| [Persona packs](docs/PERSONA-PACKS.md) | portable assistant identities and variants |
| [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md) | backup, restore, and health checks |
| [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md) | daemon and local application layout |
| [Surface API](docs/SURFACE-API.md) | supported local integration API |
| [Other surfaces](docs/SURFACES-BEYOND-THE-BROWSER.md) | desktop, Telegram, and delegated providers |

## Licence

**PolyForm Noncommercial License 1.0.0** — see [LICENSE](LICENSE) for the official text and [LICENSE-NOTES.md](LICENSE-NOTES.md) for a plain-language explanation. The project is source-available for noncommercial use; commercial use requires separate permission.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance and is not accepting substantive external code contributions. Bug reports remain welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
