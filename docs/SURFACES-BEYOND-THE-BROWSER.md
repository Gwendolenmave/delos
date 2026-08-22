# Desktop, Telegram, and delegated providers

Three ways into the same runtime. None of them is a second Delos: every
surface reaches the one daemon, the one turn coordinator, the one transcript
store.

## Desktop

The desktop app (`desktop/`) is a lifecycle owner around the daemon plus an
OS-encrypted secret store - the window loads the daemon's own served page,
so the web application, typed client and session gate are byte-identical to
the browser path.

Security posture, applied verbatim from `desktop/src/security-policy.ts`
and unit-tested without an Electron binary: contextIsolation on,
nodeIntegration off, sandbox on, webviews off, navigation pinned to the
daemon origin, new windows denied, all permission requests denied, and a
minimal typed preload as the renderer's only extra capability. The preload
surface has set/delete/status for secrets and native file dialogs - there
is deliberately NO secret-get: a plaintext credential never crosses into
the renderer.

Secrets persist through Electron's safeStorage only when the OS provides
encryption (`encrypted-persistent`); otherwise the store is honestly
`session-only` - in memory, gone at quit, never written to disk as
plaintext. The daemon consults the desktop store through an ordered
secret-store chain ahead of environment variables.

Packaging (`desktop/scripts/package.mjs`) builds the CURRENT platform only,
unsigned, with a SHA-256 manifest. Other platforms are configured in the
GitHub Actions workflow, which is authored but has never run - this
repository has no remote. Unsigned candidates warn on first launch;
that is stated, not worked around.

## Telegram

Bot API long polling (`surfaces/telegram/`), disabled by default. Direct
messages only, user-id allowlist with deny-by-default, bot senders ignored.
The bot token is a secret REFERENCE (`telegram:bot` -> an environment
variable name); a token-shaped value pasted into configuration is refused
before it can reach the settings file, and the token is redacted from every
error path. A registered webhook is detected and reported - long polling
will not fight it, and Delos never deletes it without the user.

Update identity maps onto the durable external-turn key, so Telegram's
at-least-once redelivery meets the coordinator's exactly-once model calls
at the database. Delivery itself goes through the coordinator, which is
what makes restart recovery redeliver a generated-but-unsent reply with
zero model calls. Long replies are split under the 4096-character limit at
the wire only - the canonical transcript keeps the full text.

## Delegated providers

Two provider kinds run an INSTALLED tool instead of speaking HTTP:

- `delegated-codex` - the official `codex app-server` stdio surface
  (line-delimited JSON-RPC).
- `delegated-claude-code` - the official structured non-interactive
  surface (`--print --output-format json`, prompt on stdin, one turn).

The boundary: the tool owns authentication. A delegated profile cannot
carry a credential, an endpoint, or headers; the registry never consults
the secret store for one; and the compiled delegated modules import no
filesystem API at all - Delos never reads any tool's credential files.
Auth STATE is inspected only through each tool's official surface at turn
time (Codex: the app-server's auth-status method; Claude Code: the CLI's
own auth error), and an unauthenticated tool is routed to its own
documented login flow - Delos launches nothing and holds nothing. An
Anthropic API key and a Claude subscription login are different
authentication modes, and nothing here conflates them.

Delos owns multi-turn history: each call renders the assembled system
prompt and transcript into one self-contained invocation. Child processes
spawn without a shell in a bounded empty directory, output is capped, and
the profile timeout kills the process.

One stated limitation on the Codex side: the app-server protocol offers
no full tool-disable switch for ordinary conversation. Delos requests the
tightest documented confinement - read-only sandbox, auto-approval (which
approves rather than disables the built-in exec tool), and the optional
plan/apply-patch tools explicitly excluded. A read-only sandbox bounds
writes, not reads. This is a protocol limitation reported honestly, not a
met requirement; Claude Code conversations run with a single turn and no
tool round-trips.

Codex is not functional on the development host (a Windows npm shim is
visible in WSL but its Linux native dependency is absent), so the protocol
contracts are proven against committed fake executables, and
`/api/v1/delegated/status` reports real detection with integration
honestly `detected-untested` or `not-installed` - never "working" without
observation.

## Dependency record (programme rule: record choice, alternative, licence)

The root package still has ZERO runtime dependencies. The desktop shell is
a separate package (`desktop/package.json`) so its dependencies never touch
`npm ci` at the root:

- `electron` (MIT) - the programme names Electron unless a documented
  incompatibility requires otherwise; none arose. Rejected alternative:
  Tauri - a Rust toolchain and WebView2/WebKitGTK runtime variance are a
  larger surface than this phase can verify on one host.
- `@electron/packager` (BSD-2-Clause) - produces unsigned per-platform
  directories plus our own SHA-256 manifest. Rejected alternative:
  electron-builder - its installer/auto-update/signing machinery is unused
  here and would widen the audit surface for no gain.
