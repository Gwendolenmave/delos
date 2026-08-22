/**
 * Doctor - aggregation, redaction, the concrete checks in healthy, degraded
 * and blocked states, and the offline CLI. Every dependency is injected or
 * a temp directory; nothing here talks to a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactDoctorReport, runDoctor, type DoctorReport } from "../core/services/doctor.js";
import { buildDoctorChecks, type DoctorDeps, type DoctorStoreView } from "../adapters/doctor/doctor-checks.js";
import { TELEGRAM_DEFAULTS } from "../core/domain/telegram-config.js";
import { parseProviderProfile } from "../core/domain/provider-profile.js";
import type { SecretStore } from "../core/ports/secret-store.js";
import { runCli } from "../surfaces/cli/run-cli.js";

const T0 = "2026-08-02T12:00:00.000Z";

const healthyStore: DoctorStoreView = {
  integrityCheck: async () => ({ ok: true, schemaVersion: 1, detail: "quick_check ok" }),
  listRecoverableTurns: async () => [],
  listObservations: async () => [
    {
      id: "obs-1",
      profileId: "local",
      configuredModel: "m",
      requestedModel: "m",
      servedModel: "served",
      protocol: "openai-chat-completions",
      evidenceSource: "provider-metadata",
      atIso: T0,
    },
  ],
};

const yesSecrets: SecretStore = {
  name: "test",
  writable: false,
  has: async () => true,
  get: async () => ({ found: false, reason: "not_configured", detail: "doctor never reads values" }),
};
const noSecrets: SecretStore = { ...yesSecrets, has: async () => false };

const PROFILE = parseProviderProfile({
  schemaVersion: 1,
  id: "local",
  kind: "openai-compatible",
  model: "m",
  baseUrl: "http://127.0.0.1:1/v1",
  auth: { source: "environment", transport: "bearer", secretId: "provider:local", envVar: "LOCAL_KEY" },
});

function depsOn(dataDir: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    appVersion: "0.1.0-dev",
    apiVersion: 1,
    dataDir,
    store: healthyStore,
    profiles: [PROFILE],
    secretStore: yesSecrets,
    telegramConfig: { ...TELEGRAM_DEFAULTS },
    secretStoreNames: ["desktop-encrypted", "environment"],
    personas: { loaded: ["arti"], failed: [] }, // scan-allow-persona
    boundAddress: "127.0.0.1:12345",
    detect: async () => ({ installed: true, version: "9.9.9-fake", detail: "answered" }),
    ...overrides,
  };
}

test("doctor: aggregation is worst-of, and a crashing check is a finding", async () => {
  const report = await runDoctor(
    [
      async () => ({ id: "a", title: "A", status: "PASS", detail: "fine" }),
      async () => ({ id: "b", title: "B", status: "DEGRADED", detail: "meh" }),
      async () => {
        throw new Error(["/ho", "me/someone/secret-path"].join("") + " should not surface");
      },
    ],
    T0,
  );
  assert.equal(report.overall, "BLOCKED");
  assert.equal(report.checks.length, 3);
  const crashed = report.checks[2]!;
  assert.equal(crashed.status, "BLOCKED");
  assert.ok(!crashed.detail.includes("/home/"), "the crash detail leaked a path");
});

test("doctor: the redacted report carries no path, key or token shapes", () => {
  // Hostile fixtures are assembled from fragments so no source line carries
  // the shapes the repository scanner hunts.
  const unixPath = ["/ho", "me/user/delos"].join("");
  const windowsPath = ["C:", "\\Users", "\\user\\delos"].join("");
  const keyShape = ["sk-", "abcdefghijk12345"].join("");
  const tokenShape = ["1234567", "AAtelegramtokenshape-abcd"].join(":");
  const dirty: DoctorReport = {
    generatedAtIso: T0,
    overall: "DEGRADED",
    checks: [
      {
        id: "x",
        title: `Check at ${unixPath} and ${windowsPath}`,
        status: "DEGRADED",
        detail: `found ${keyShape} and ${tokenShape} near ${unixPath}/file`,
      },
    ],
  };
  const clean = redactDoctorReport(dirty);
  const text = JSON.stringify(clean);
  assert.ok(!text.includes(unixPath), "a unix path survived");
  assert.ok(!text.includes(windowsPath.replace("\\", "\\\\")), "a windows path survived");
  assert.ok(!text.includes(keyShape), "a key shape survived");
  assert.ok(!text.includes(tokenShape), "a token shape survived");
});

test("doctor: a healthy composition reports PASS overall", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    const report = await runDoctor(buildDoctorChecks(depsOn(dataDir)), T0);
    const failing = report.checks.filter((c) => c.status !== "PASS");
    assert.deepEqual(
      failing.map((c) => c.id),
      [],
      `expected all PASS, got: ${failing.map((c) => `${c.id}=${c.status}`).join(", ")}`,
    );
    assert.equal(report.overall, "PASS");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor: missing credentials degrade; nothing reads a secret value", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    const report = await runDoctor(
      buildDoctorChecks(depsOn(dataDir, { secretStore: noSecrets })),
      T0,
    );
    assert.equal(report.overall, "DEGRADED");
    const providers = report.checks.find((c) => c.id === "providers")!;
    assert.equal(providers.status, "DEGRADED");
    assert.match(providers.detail, /local/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor: blocked states - broken database, enabled telegram without a token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    const broken: DoctorStoreView = {
      ...healthyStore,
      integrityCheck: async () => ({ ok: false, schemaVersion: 1, detail: "page corruption" }),
    };
    const report = await runDoctor(buildDoctorChecks(depsOn(dataDir, { store: broken })), T0);
    assert.equal(report.overall, "BLOCKED");
    assert.equal(report.checks.find((c) => c.id === "sqlite")!.status, "BLOCKED");

    const telegramReport = await runDoctor(
      buildDoctorChecks(
        depsOn(dataDir, {
          secretStore: noSecrets,
          telegramConfig: { ...TELEGRAM_DEFAULTS, enabled: true, allowedUserIds: [1] },
        }),
      ),
      T0,
    );
    assert.equal(telegramReport.checks.find((c) => c.id === "telegram")!.status, "BLOCKED");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor: active personas must load - a broken telegram default blocks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    // A conversation references a pack that no longer loads: DEGRADED.
    const degraded = await runDoctor(
      buildDoctorChecks(depsOn(dataDir, { activePersonaIds: ["gone-pack"] })),
      T0,
    );
    const active = degraded.checks.find((c) => c.id === "active-persona")!;
    assert.equal(active.status, "DEGRADED");
    assert.match(active.detail, /gone-pack/);

    // Telegram enabled with a default persona that does not load: BLOCKED.
    const blocked = await runDoctor(
      buildDoctorChecks(
        depsOn(dataDir, {
          telegramConfig: {
            ...TELEGRAM_DEFAULTS,
            enabled: true,
            allowedUserIds: [1],
            defaultPersonaId: "missing-default",
          },
        }),
      ),
      T0,
    );
    assert.equal(blocked.checks.find((c) => c.id === "active-persona")!.status, "BLOCKED");

    // Nothing referenced: an honest PASS either way.
    const idle = await runDoctor(buildDoctorChecks(depsOn(dataDir, { activePersonaIds: [] })), T0);
    assert.equal(idle.checks.find((c) => c.id === "active-persona")!.status, "PASS");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor: online probes - provider connections and codex auth get real statuses", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    const failing = await runDoctor(
      buildDoctorChecks(
        depsOn(dataDir, {
          providerProbe: async () => ({ ok: false, code: "authentication-failed" }),
        }),
      ),
      T0,
    );
    const providers = failing.checks.find((c) => c.id === "providers")!;
    assert.equal(providers.status, "DEGRADED");
    assert.match(providers.detail, /authentication-failed/);

    const signedOut = await runDoctor(
      buildDoctorChecks(
        depsOn(dataDir, {
          codexAuthProbe: async () => ({
            supported: true,
            authenticated: false,
            detail: "Not signed in. Run the codex CLI's own login once.",
          }),
        }),
      ),
      T0,
    );
    const codex = signedOut.checks.find((c) => c.id === "codex")!;
    assert.equal(codex.status, "DEGRADED");
    assert.match(codex.detail, /login/i);
    assert.ok(!codex.detail.includes("@"), "no account identifier in the auth status");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor: a webhook conflict is diagnosed, never repaired", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-"));
  try {
    const report = await runDoctor(
      buildDoctorChecks(
        depsOn(dataDir, {
          telegramConfig: { ...TELEGRAM_DEFAULTS, enabled: true, allowedUserIds: [1] },
          telegramProbe: async () => ({ webhookConflict: "A webhook is registered." }),
        }),
      ),
      T0,
    );
    const telegram = report.checks.find((c) => c.id === "telegram")!;
    assert.equal(telegram.status, "BLOCKED");
    assert.match(telegram.detail, /webhook/i);
    assert.match(telegram.detail, /never removes/i, "the no-repair promise must be stated");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("doctor CLI: --doctor --json runs offline against a data dir and exits by status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-doctor-cli-"));
  try {
    let out = "";
    const code = await runCli(["--doctor", "--data-dir", dataDir, "--json"], {
      streams: {
        stdout: (text) => {
          out += text;
        },
        stderr: () => undefined,
        readLine: async () => null,
      },
      env: {},
      cwd: dataDir,
      newId: (p) => `${p}-1`,
      now: () => T0,
    });
    const report = JSON.parse(out) as DoctorReport;
    // A fresh machine with no providers is DEGRADED, honestly - not broken,
    // not fine.
    assert.equal(report.overall, "DEGRADED");
    assert.equal(code, 1);
    const ids = report.checks.map((c) => c.id);
    for (const expected of ["version", "data-dir", "sqlite", "providers", "telegram", "disk", "backup-schema"]) {
      assert.ok(ids.includes(expected), `missing check ${expected}`);
    }
    // The database check must not have CREATED a database.
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(dataDir, "transcripts.db")), "doctor created a database");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
