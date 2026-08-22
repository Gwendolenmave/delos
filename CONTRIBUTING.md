# Contributing

**This project is under closed maintenance.** It is not accepting substantive
external code contributions, and pull requests are disabled on the canonical
repository.

That is a deliberate position, not an oversight or a temporary backlog.

## Why

Delos is maintained by one person. Accepting outside code creates obligations
that come with it — review capacity, provenance and copyright arrangements,
and a duty to keep contributed work alive. Until there is a contribution
policy and a copyright arrangement worth signing, taking patches would mean
accepting those obligations without being able to meet them.

Saying no clearly is more respectful of your time than leaving a pull request
open for a year.

## What is welcome

- **Bug reports.** Especially anything where Delos is dishonest: a memory
  attributed to the wrong source, a claim it read something it did not, a
  failure it reported as success.
- **Security reports.** Please report privately rather than in a public issue.
- **Questions about the architecture**, and disagreement with it. The
  reasoning is written down in `docs/ARCHITECTURE-PRINCIPLES.md` precisely so
  it can be argued with.
- **Telling us it did not work on your machine**, with enough detail to
  reproduce.

## What to do instead of a pull request

**Fork it.** The licence permits noncommercial use and modification, and the
architecture is built for replacement: the persona is content, the model
connector is an adapter, the memory backend is behind a contract, and the
interface is a surface. You should be able to change any of those in your own
copy without asking anyone.

If you build something interesting that way, say so — but keep it yours.
Nothing here needs to be upstreamed to be legitimate.

## If this changes

If a contribution policy and copyright arrangement are ever settled, this file
will say so and pull requests will be re-opened. Until then, assume the answer
to "can I send a patch?" is no, and that this costs you nothing you could not
do in a fork.
