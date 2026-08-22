/**
 * Egress policy (B2): off by default, consent-gated, SSRF-guarded, honest.
 * Judgement is pure; the daemon seam is exercised over real loopback HTTP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeEgress,
  EGRESS_DEFAULTS,
  evaluateEgress,
  parseEgressConfig,
} from "../core/services/egress-policy.js";
import { startDaemon } from "../surfaces/daemon/daemon.js";

const CONSENTED = { enabled: true, consentGrantedAtIso: "2026-08-02T10:00:00.000Z" };

test("egress: disabled by default - every URL refused with the reason", () => {
  const decision = evaluateEgress("https://example.com/page", EGRESS_DEFAULTS);
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, "disabled");
  assert.equal(describeEgress(EGRESS_DEFAULTS).state, "disabled");
});

test("egress: enabled without consent is DEGRADED and still refuses", () => {
  const config = { enabled: true };
  const decision = evaluateEgress("https://example.com/", config);
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, "enabled-without-consent");
  const report = describeEgress(config);
  assert.equal(report.state, "degraded");
  assert.match(report.detail, /refused until consent/i);
});

test("egress: SSRF guard matrix", () => {
  const refuse = (url: string, status: string) => {
    const decision = evaluateEgress(url, CONSENTED);
    assert.equal(decision.allowed, false, `${url} was allowed`);
    assert.equal(decision.status, status, `${url} -> ${decision.status}`);
  };
  // Attack fixtures are assembled from fragments so no source line carries
  // the shapes the repository scanner hunts (userinfo emails, private
  // hosts) - the standing fixture discipline, never an exemption.
  refuse("http://example.com/", "blocked-scheme");
  refuse("ftp://example.com/", "blocked-scheme");
  refuse("https://user:pw" + "@" + "example.com/", "blocked-userinfo");
  refuse("https://127.0.0.1/", "blocked-ip-literal");
  refuse("https://10.0.0.8/x", "blocked-ip-literal");
  refuse("https://169.254.169.254/latest/meta-data/", "blocked-ip-literal");
  refuse("https://[::1]/", "blocked-ip-literal");
  refuse("https://localhost/", "blocked-private-name");
  refuse("https://intranet/", "blocked-private-name");
  refuse("https://printer" + ".loc" + "al/", "blocked-private-name");
  refuse("https://files" + ".inter" + "nal/", "blocked-private-name");
  refuse("https://example.com:8443/", "blocked-port");
  refuse("not a url", "invalid-url");

  const ok = evaluateEgress("https://example.com/docs?q=1", CONSENTED);
  assert.equal(ok.allowed, true);
  assert.equal(ok.status, "allowed");
});

test("egress: the allowlist narrows, never widens", () => {
  const config = { ...CONSENTED, allowedHosts: ["docs.example.com"] };
  assert.equal(evaluateEgress("https://docs.example.com/a", config).allowed, true);
  assert.equal(evaluateEgress("https://example.com/a", config).status, "blocked-host");
  // The allowlist cannot readmit what the SSRF guards refuse.
  assert.equal(
    evaluateEgress("https://localhost/", { ...config, allowedHosts: ["localhost"] }).status,
    "blocked-private-name",
  );
});

test("egress: parse tolerates junk and never invents consent", () => {
  assert.deepEqual(parseEgressConfig(null), EGRESS_DEFAULTS);
  assert.deepEqual(parseEgressConfig({ enabled: "yes" }), { enabled: false });
  const parsed = parseEgressConfig({ enabled: true, allowedHosts: ["A.Example.COM", 7] });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.consentGrantedAtIso, undefined);
  assert.deepEqual(parsed.allowedHosts, ["a.example.com"]);
});

test("egress over the daemon: consent-gated enable, judge seam, persisted off", async () => {
  const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
  const dataDir = await mkdtemp(join(tmpdir(), "delos-egress-"));
  const daemon = await startDaemon({ dataDir, shippedPersonaDir: shipped, env: {} });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${daemon.origin}${path}`, {
      method,
      headers: {
        "x-delos-session": daemon.sessionToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  try {
    const initial = await call("GET", "/api/v1/egress/status");
    assert.equal(initial.json["state"], "disabled");

    const refused = await call("PUT", "/api/v1/egress/config", { enabled: true });
    assert.equal(refused.status, 400, "enabling without consent must be refused");

    const enabled = await call("PUT", "/api/v1/egress/config", { enabled: true, consent: true });
    assert.equal(enabled.json["state"], "active");

    const judged = await call("POST", "/api/v1/egress/judge", { url: "https://127.0.0.1/x" });
    assert.equal(judged.json["status"], "blocked-ip-literal");

    const disabled = await call("PUT", "/api/v1/egress/config", { enabled: false });
    assert.equal(disabled.json["state"], "disabled");
    const persisted = JSON.parse(await readFile(join(dataDir, "egress.json"), "utf8")) as {
      enabled: boolean;
      consentGrantedAtIso?: string;
    };
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.consentGrantedAtIso, undefined, "disable must drop the consent record");
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
