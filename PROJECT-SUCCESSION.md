# Project succession

This file states what happens to the canonical repository if the maintainer
becomes unable to maintain it.

It exists because a personal system people rely on should not simply go
silent, and because the answer should be written down before it is needed
rather than improvised afterwards.

## What a successor is for

A successor's role is **custodial, not editorial**:

1. **Preserve** the canonical repository and its history.
2. **Transfer** it to a hosting location that remains reachable.
3. **Archive** it publicly, in a readable state, if it is no longer to be
   hosted actively.

That is the whole mandate.

## What a successor does not inherit

- **Development rights.** A successor does not become the maintainer, does not
  gain authority to set direction, and does not speak for the project.
- **Authority to relicense.** The licence travels with the code as it is.
- **Authority to accept contributions** on the project's behalf, or to reopen
  it to outside code.
- **Anything private.** No credentials, no personal data, no private instance,
  no persona content beyond what the public repository already contains.

A successor who wants to *develop* the software does what anyone else does:
forks it under the licence, and continues under their own name. That is
permitted, and it is honest — a fork is visibly a different project with a
different person behind it, which is what it would be.

## What is explicitly not covered

The maintainer's **private instance** — its persona, memories, transcripts,
credentials and configuration — is not part of this repository, is not part of
any succession, and is not to be published, transferred or archived. It is
personal material that happens to run on this software.

## Practical notes

- Preserve the full commit history rather than a squashed snapshot. The
  reasoning in the commit messages is part of what makes the code
  maintainable.
- Keep `LICENSE`, `LICENSE-NOTES.md`, `CONTRIBUTING.md` and this file with the
  code. They describe the terms under which it may be used and continued.
- An archived-and-readable repository is a better outcome than an actively
  maintained one under someone who does not want the job.
