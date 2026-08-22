# Delos

[简体中文](README.zh-CN.md)

**A personal AI runtime that runs on your own machine — so you can change the model, provider, interface, or memory system without rebuilding the assistant from scratch.**

Delos is not trying to be one more chatbot. It is trying to solve a more annoying long-term problem: personal AI systems tend to glue identity, model access, conversation state, memory, and UI together. Change one piece and everything else becomes migration work.

Delos separates those pieces behind stable boundaries:

| The problem | The Delos piece | What it buys you |
| --- | --- | --- |
| Changing models feels like changing assistants | **Provider profiles** | Swap OpenAI, Anthropic, compatible APIs, local models, or delegated providers without rewriting the persona |
| Persona is buried in application code | **Plain-file persona + persona packs** | Identity and response style stay readable, editable, and portable |
| CLI, web, and messaging each grow their own state | **One runtime, multiple surfaces** | Different interfaces share the same turn, transcript, and configuration boundaries |
| Conversation continuity disappears after a restart | **Local transcripts + optional Mnemosyne** | Delos keeps local conversation continuity; Mnemosyne adds governed long-term memory when you want it |
| API keys spread through config files | **Secret references** | Configuration points to secrets instead of storing secret values |
| A broken installation is hard to reason about | **Backup / restore / doctor** | State can be backed up, restored, and checked for consistency |

Delos operates no hosted service, account, subscription, or telemetry backend. You choose the model path, where local state lives, and whether long-term memory is enabled.

The name comes from the island of Delos in Greek myth: a place that hosted a birth without defining the identity of those born there.

**Delos is where they are born, not who they must become.**

The repository ships with an example persona named **Arti**. She is a default, not the product identity. You can replace her completely without renaming runtime code or migrating the database. <!-- scan-allow-persona -->

## Run it in five minutes

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

In an interactive session:

- `/exit` or `/quit` leaves the session;
- `/clear` archives the current CLI conversation and starts a fresh one;
- completed turns are stored locally and can resume after restart inside the same configuration/provider scope;
- `--once` runs stay isolated from that interactive continuity.

## How the pieces fit

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

The important part is not the diagram itself. It is that **the blocks are replaceable**. Changing provider should not migrate persona. Changing surface should not fork transcript state. Enabling Mnemosyne should not turn memory into system/persona authority.

If you are modifying or extending Delos, treat [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) as the normative contract.

## Models and providers

Delos can talk to official OpenAI and Anthropic protocols, OpenAI-compatible relays or local servers, and delegated local provider tools.

Provider profiles describe *how to reach a model*. They do not contain credential values.

- [Providers](docs/PROVIDERS.md) explains the supported provider kinds and protocol behavior.
- [Provider profiles](docs/PROVIDER-PROFILES.md) shows configuration examples.
- [Secrets](docs/SECRETS.md) explains how credentials are referenced and stored.

## Persona: identity is content, not code

The default identity is deliberately boring to inspect:

```text
prompts/
├── identity.md
├── relationship.md
└── response-style.md
```

That is the point. You should be able to read, edit, replace, and version the assistant's identity without touching runtime internals.

For portable manifests, variants, and contextual activation rules, see [Persona packs](docs/PERSONA-PACKS.md).

## Long-term memory: add Mnemosyne when you need it

Delos owns the runtime and local conversation continuity. Governed long-term memory is provided by the separate public project [Mnemosyne](https://github.com/Gwendolenmave/mnemosyne), and it is **off by default**.

```bash
npm install github:Gwendolenmave/mnemosyne

export DELOS_MEMORY_BACKEND=mnemosyne
export DELOS_MEMORY_DB_PATH=./local-state/mnemosyne.db
npm run start
```

If you explicitly enable Mnemosyne and Delos cannot attach it correctly, startup fails closed rather than pretending memory is active. Retrieved memory is bounded host data; it never becomes system/persona authority.

See [Memory integration](docs/MEMORY.md) for the complete boundary.

## Many interfaces, one Delos

CLI, browser UI, desktop shell, and Telegram are ways into the same runtime, not four separate assistants.

- [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md) explains the daemon and local app layout.
- [Surface API](docs/SURFACE-API.md) defines the stable local integration API.
- [Desktop, Telegram, and delegated providers](docs/SURFACES-BEYOND-THE-BROWSER.md) covers the other surfaces and delegated providers.

## Privacy and local ownership

Delos does not send data to a “Delos cloud.” Network traffic depends on the model path you configure.

A remote provider receives the prompt and selected conversation/context needed for a turn under that provider's own privacy, retention, and billing terms. Pointing Delos at a local model keeps model traffic on the host machine.

Credentials do not belong in Delos JSON configuration. Runtime transcripts, local state, persona data, and an optional Mnemosyne database stay inside the host's storage boundary.

Backup, restore, and health tooling are described in [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md).

## Documentation

| Document | What problem it answers |
| --- | --- |
| [Architecture principles](docs/ARCHITECTURE-PRINCIPLES.md) | rules for agents and maintainers changing the system without breaking boundaries |
| [Providers](docs/PROVIDERS.md) | which provider kinds exist and how their protocols behave |
| [Provider profiles](docs/PROVIDER-PROFILES.md) | how to configure model access |
| [Secrets](docs/SECRETS.md) | how credentials stay out of ordinary config |
| [Memory integration](docs/MEMORY.md) | how Mnemosyne plugs into Delos |
| [Persona packs](docs/PERSONA-PACKS.md) | how portable assistant identities work |
| [Backup, restore, and doctor](docs/BACKUP-AND-DOCTOR.md) | how to back up, recover, and diagnose local state |
| [Local app architecture](docs/LOCAL-APP-ARCHITECTURE.md) | how the daemon and local app fit together |
| [Surface API](docs/SURFACE-API.md) | how to add or talk to a local surface |
| [Licensing notes](docs/LICENSING.md) | the licensing boundary in plain language |

## Licence and maintenance

Delos uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md). It is source-available for noncommercial use; commercial use requires separate permission. The official terms are in [LICENSE.md](LICENSE.md), with a plain-language explanation in [Licensing notes](docs/LICENSING.md).

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance and is not accepting substantive external code contributions. Bug reports remain welcome; see [Contributing](CONTRIBUTING.md).
