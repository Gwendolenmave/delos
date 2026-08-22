# Persona packs

A persona is **content**: a manifest plus a directory of Markdown blocks. You
can read every word your assistant is built from, edit any of it, replace all
of it, and carry it between Delos installations as a single ZIP.

## Shape

```text
personas/<persona-id>/
  persona.json                     # the manifest
  base/
    identity.md                    # ordered base blocks - the persona's spine
    relationship.md
    response-style.md
  variants/
    intimacy.md                    # optional blocks with activation policies
    sensitive-content.md
  rules/
    contextual-activation.json     # optional transparent activation rules
  overlays/
    telegram.md                    # optional per-surface adjustments
```

`persona.json` names everything: ordered `base` blocks, `variants` with an
`id`, `path`, `policy` and `priority`, per-surface `overlays`, and optionally
a `rules` file. **Every file in a pack must be named by the manifest** — an
unclaimed file is refused at load, so nothing rides along unreviewed.

## Activation policies

| policy | when the block speaks |
|---|---|
| `always` | every turn (unless you disable it) |
| `manual` | **only** after you enable it for the session — nothing else can turn it on |
| `contextual` | when the current message matches a literal term in the pack's visible rules file |
| `surface` | on the surfaces the variant lists |

Two rules with teeth: **your disable always wins**, over every policy
including `always`; and a `manual` variant — intimacy is the canonical case —
can never be activated by a rule, a surface, or any classifier. There is no
invisible model call deciding what loads: read the rules file, predict the
behaviour.

Every turn exposes structured metadata: the active persona, which blocks
loaded, why each variant activated (down to the matched term), and why each
inactive variant stayed out.

## The shipped pack

`personas/arti/` is the default guest: three generic base blocks and two <!-- scan-allow-persona -->
generic variants — `intimacy` (manual) and `sensitive-content` (contextual,
with its rules in plain sight). Neither claims to override provider policy;
the shipped rules never reference intimacy, because serious is not the same
as close. Rename her, rewrite her, or export-and-edit a copy. The `prompts/`
directory remains as the schemaVersion 1 compatibility path; **the pack is
the canonical form.**

## Creating and importing

- **Wizard**: answer concrete questions (who are you, what are you to the
  user, how do you speak) and get a valid pack of plain Markdown.
- **Directory** or **ZIP** import of an existing Delos pack.
- **Plain text files** or a **pasted prompt** become a clearly-labelled basic
  pack you can organise later.

Delos does **not** automatically import ChatGPT exports, Claude Project
exports, character cards, or private-instance memory.

Import hardening (both directory and ZIP): path traversal, absolute paths,
hidden segments, symlinks (including by ZIP external attributes), device
files, binary content, oversized entries, declared-size lies, checksum
failures, duplicate entries and secret-bearing manifest fields are all
refused before any content is trusted.

## Exporting

One persona exports as a **deterministic** ZIP — same pack, same bytes. The
format has no field for secrets, transcripts, local paths or provider
configuration, so a pack export structurally cannot leak them.
