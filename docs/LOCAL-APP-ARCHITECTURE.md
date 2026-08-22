# The local application

```text
   web browser (served UI)          future PWA / desktop / Telegram
        |  typed client                     |  same typed client
        v                                   v
   +----------------- local daemon (127.0.0.1) -----------------+
   |  /api/v1  - session token + origin gate, bounded bodies    |
   |                                                            |
   |  turn coordinator  - exactly-once model calls,             |
   |                      crash recovery, per-conversation lanes|
   |  persona packs     - shipped read-only, user packs in data |
   |  variant resolver  - deterministic, manual-only intimacy   |
   |  context assembly  - trust-ordered, current-msg-first      |
   |  containment       - output filtered before persistence    |
   |  situations        - user-authored, expiring, file-backed  |
   |  transcript store  - SQLite, atomic migrations             |
   |  provider registry - profiles + secret store + redaction   |
   +------------------------------------------------------------+
```

One daemon owns runtime composition; every surface is a caller. The web
application is framework-free DOM code that renders model text exclusively
through `textContent`, holds no secret in any browser storage, and reaches
the network only through the typed client.

Data lives under the platform application-data directory (`DELOS_DATA_DIR`
overrides): `transcripts.db`, `providers.json` (non-secret profiles),
`personas/` (user packs), `situations.json`.

`npm run app:web` builds, starts the daemon on a free loopback port, prints
the URL, and opens the browser.
