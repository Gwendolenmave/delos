# 0004. Secrets are references, never values

Status: accepted (Wave 7a, extended through Phase 6)

## Context

The fastest way to leak a credential is to let it exist in more places
than the one that needs it: config files, logs, error messages, backups,
checkpoints.

## Decision

Configuration stores secret REFERENCES (a secret id plus, for the
environment store, a variable NAME). Values are resolved per call through
the SecretStore port and exist only in the request that uses them. Every
error path passes a redactor that knows the live values and their shapes.
Token-shaped values are refused where a reference belongs. Backups and
diagnostics exclude secret values structurally, not by filtering.

## Consequences

Rotation is immediate (next call reads the new value). No artifact this
programme produces - config, transcript, backup, checkpoint - can carry a
credential without first defeating a validator built to refuse it.
