# Backup, restore, and doctor

## The backup

`GET /api/v1/backup` (or the web/desktop Backup page) produces ONE
versioned, deterministic ZIP: transcripts (conversations, messages,
external turns, provider observations), Current Situation, non-secret
provider profiles, non-secret Telegram settings, user persona packs, and a
manifest with schema versions, counts and a per-entry SHA-256 integrity
table. The same state produces the same bytes - two backups are comparable
by hash.

What can NEVER be in a backup, structurally rather than by filtering:
secret values (profiles and Telegram settings hold references; the secret
stores are not consulted), Codex/Claude login state (owned by those tools;
never read), environment variables, logs, temporary files, Private Delos
anything. The entry grammar cannot express a foreign path.

## Restore

Inspect -> validate -> preview counts -> choose policy (replace or
merge-skip) -> apply -> verify. The archive is re-validated on the way in:
schema gate, bidirectional integrity (every listed file present and
matching, every present file listed), manifest counts re-derived from the
entries' actual content (the manifest cannot vouch for itself, so a
tampered count is refused at inspection), duplicate-id refusal for
transcripts AND situations, the same ZIP paranoia as persona packs
(symlink attributes, bomb caps, checksums, duplicates), and both config
documents re-parsed under their own domain rules - which re-refuses any
credential-shaped content. The backup's persona path grammar is the pack
loader's own grammar: what the product accepted, backup accepts.

Apply order is what makes rollback complete: files swap in with .bak
copies kept, situations are replaced with a rollback snapshot held, and
the transcript snapshot lands LAST inside one database transaction.
Verification is deliberately front-loaded - hashes and counts are proven
BEFORE anything commits, and nothing after the database commit is allowed
to throw - so any failure swaps everything back and a "verified" result
never depends on a check that could strand a half-restored machine.
Replace-policy restores report verified: true on that basis; merge-skip
keeps pre-existing rows by design, is accounted per row, and says so
instead of claiming a global verification it cannot perform. Under
merge-skip, "skip" applies to every store: a local situation whose id
also appears in the archive keeps the local text.

A restore that succeeded is not "the providers work": profiles carry
references, never values, so the result names every profile whose
credential this machine cannot resolve. Reconfigure those by hand - that
is the design, not a limitation.

## Doctor

The same read-only checks everywhere: `GET /api/v1/doctor` (the
Diagnostics page renders it), `GET /api/v1/doctor/report` (redacted,
downloadable), and offline `delos --doctor [--data-dir <p>] [--json]`
(exit 0 PASS / 1 DEGRADED / 2 BLOCKED). Checks cover version, data
directory, SQLite integrity and schema, secure-storage mode, loopback
binding, persona packs, ACTIVE personas (the ones conversations and
surface defaults reference must load - a broken Telegram default blocks),
provider credential PRESENCE (never values; connections probed only with
?online=1), served-model evidence, Codex/Claude detection scoped by
whether a profile depends on them (Codex auth state probed through its
official surface with ?online=1; the Claude CLI offers no read-only auth
query, so its auth surfaces per turn - a stated limitation), Telegram
(webhook state only probed with ?online=1), pending recoveries, backup
schema support, and disk space.

Doctor repairs nothing: it never deletes data, never removes a webhook,
never logs anything out, never recreates a database, never touches a
credential or the binding. The CLI opens the database READ-ONLY (the
normal store migrates on open; doctor must not even do that) and a missing
database or data directory reports as a state, not a fault. The exported
report passes a belt-and-braces redaction - paths, key shapes, token
shapes - on top of check text that is written to be safe.
