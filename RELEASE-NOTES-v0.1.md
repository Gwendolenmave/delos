# Delos v0.1

The first public source release of Delos: a local, self-hosted assistant
runtime you point at your own model provider.

This is a small, honest release. It is one working vertical slice, not a
finished product, and the sections below are specific about which is which.

## What v0.1 is

A configurable command-line assistant that runs entirely on your machine and
talks to an endpoint you choose. It contains:

- **JSON runtime configuration** — one local file naming your endpoint, model,
  prompt directory and context budget. It never holds a credential; it names an
  environment variable instead.
- **Filesystem prompt loading** — your assistant's identity is a directory of
  Markdown files you can read, edit, reorder and delete.
- **Replaceable identity content** — the shipped persona is a default, not an
  architectural fixture. Rewrite it, or replace every file with your own, and
  nothing in the code needs renaming.
- **An OpenAI-compatible provider adapter** — one implementation of a
  provider-neutral port, not the definition of all future connectors.
- **Recent conversational context** — a bounded, budgeted selection of recent
  turns, with the current message always preserved.
- **Reply sanitisation** — terminal control sequences and stray carriage
  returns are removed before anything is printed.
- **Controlled startup, timeout and interrupt behaviour** — configuration
  errors never echo the file's contents, one deadline covers the whole request
  including reading the reply, and Ctrl-C shuts the runtime down through its
  normal path rather than killing it.
- **Synthetic tests and repository privacy scanning** — the test suite reaches
  no network and contains no real credential; a scanner checks the repository
  against its own publication rules.

## What v0.1 is not

Stated plainly, because the architecture is designed around ideas that are not
implemented yet and it would be easy to assume otherwise:

- **No persistent long-term memory.** Conversation history lives in the running
  process and is gone when the command exits. Nothing is written to disk.
- **No Mnemosyne governance** — nothing decides what may endure.
- **No Anamnesis retrieval** — nothing decides what the present may receive.
- **No Muse routing** — nothing classifies what a moment is asking for.
- **No web, desktop or messaging interface.** The command line is a reference
  surface, not the product boundary.
- **No hosted infrastructure.** There is no Delos server, account,
  subscription or telemetry, and this project receives none of your data.
- **No npm distribution.** This is a source release. The package is marked
  private and is not published to any registry; you clone the repository and
  build it locally.

## Running it

See `README.md`. In short: Node 22 or newer, install, build, copy
`delos.config.example.json`, point it at a provider you have access to, and put
your key in the environment variable you name. A local build is required before
the CLI will run.

You supply the model. If you point Delos at a remote provider, your
conversations go to that provider under their terms; only a local model keeps
everything on your machine. `README.md` is specific about this.

## Licence

**PolyForm Noncommercial License 1.0.0** — see `LICENSE` for the official text
and `LICENSE-NOTES.md` for a plain-language explanation that adds no conditions
of its own.

Source-available for noncommercial use. This is **not** an OSI-approved
open-source licence and it would be wrong to call it one.

Licensor and maintainer: **Gwendolen** (`@Gwendolenmave` on GitHub). Commercial
use requires separate permission, which must be requested from the licensor.

## Why it is built this way

Delos started from a narrow worry: models are retired, platforms change, and
accounts close. An assistant you have built a relationship with can disappear
with the machinery that happened to carry it.

So the parts that tend to change — the provider, the model, the interface, the
place memory lives — are meant to be replaceable without rebuilding everything
else, and the identity is meant to be content you own rather than something
compiled into the program. v0.1 implements that principle across one complete
path. The rest of the architecture is written down, not yet built.

`docs/DESIGN-NOTES.md` says more, for anyone who wants it.
