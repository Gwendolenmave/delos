/**
 * Redaction - synthetic tests.
 *
 * All secrets here are assembled from fragments. The property under test: a
 * credential that enters an error, a diagnostic or a structure does not come
 * out the other side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRedactor, REDACTED, SHAPE_ONLY_REDACTOR } from "../core/services/redaction.js";

const TOKEN = "sk-" + "synthetic-redaction-token-0001";
const RELAY = "relay-" + "synthetic-opaque-value-0002";

test("a known value is removed wherever it appears", () => {
  const r = createRedactor({ values: [TOKEN] });
  const input = `request failed; sent ${TOKEN} and got 401 (token was ${TOKEN})`;
  const out = r.text(input);
  assert.ok(!out.includes(TOKEN));
  assert.equal(out.split(REDACTED).length - 1, 2);
});

test("a known value with no recognisable prefix is still removed", () => {
  // Redaction must not depend on sk- or any other shape.
  const r = createRedactor({ values: [RELAY] });
  assert.ok(!r.text(`auth: ${RELAY}`).includes(RELAY));
});

test("short values are not redacted, so errors stay readable", () => {
  const r = createRedactor({ values: ["abc"] });
  assert.equal(r.text("the abc marker survives"), "the abc marker survives");
});

test("bearer headers are redacted by shape, even for unknown values", () => {
  const never_seen = "unknown-" + "token-value-9";
  const out = SHAPE_ONLY_REDACTOR.text(`Authorization: Bearer ${never_seen}`);
  assert.ok(!out.includes(never_seen));
});

test("api-key headers are redacted by shape, case-insensitively", () => {
  for (const line of [
    `x-api-key: ${RELAY}`,
    `X-Api-Key: ${RELAY}`,
    `X-API-KEY=${RELAY}`,
    `api-key: ${RELAY}`,
  ]) {
    const out = SHAPE_ONLY_REDACTOR.text(line);
    assert.ok(!out.includes(RELAY), `leaked through: ${line}`);
  }
});

test("mixed-case Bearer does not bypass redaction", () => {
  for (const prefix of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
    const out = SHAPE_ONLY_REDACTOR.text(`${prefix} ${TOKEN}`);
    assert.ok(!out.includes(TOKEN), `leaked through prefix ${prefix}`);
  }
});

test("URL userinfo is redacted", () => {
  const out = SHAPE_ONLY_REDACTOR.text("connect to https://user:" + "hunter" + "@relay.example/v1");
  assert.ok(!out.includes("hunter"));
  assert.ok(out.includes("relay.example/v1"), "the host must survive for diagnostics");
});

test("credential query parameters are redacted", () => {
  for (const p of ["api_key", "apikey", "access_token", "token", "key"]) {
    const out = SHAPE_ONLY_REDACTOR.text(`GET /v1/models?${p}=${RELAY}&safe=1`);
    assert.ok(!out.includes(RELAY), `leaked through ?${p}=`);
    assert.ok(out.includes("safe=1"), "unrelated params survive");
  }
});

test("a configured custom header name joins the shape rules", () => {
  const r = createRedactor({ headerNames: ["X-Gateway-Auth"] });
  const out = r.text(`x-gateway-auth: ${RELAY}`);
  assert.ok(!out.includes(RELAY));
});

test("structures are redacted without stringifying secrets", () => {
  const r = createRedactor({ values: [TOKEN] });
  const out = r.value({
    request: { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } },
    note: `used ${TOKEN}`,
    list: [TOKEN, "fine"],
  }) as Record<string, unknown>;
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(TOKEN));
  assert.ok(dumped.includes("application/json"), "non-secret content survives");
});

test("header-named keys are dropped wholesale in structures", () => {
  const out = SHAPE_ONLY_REDACTOR.value({
    authorization: "anything at all",
    "X-Api-Key": RELAY,
    fine: "kept",
  }) as Record<string, unknown>;
  assert.equal(out["authorization"], REDACTED);
  assert.equal(out["X-Api-Key"], REDACTED);
  assert.equal(out["fine"], "kept");
});

test("redaction follows nested error causes", () => {
  const r = createRedactor({ values: [TOKEN] });
  const inner = new Error(`upstream said: bad token ${TOKEN}`);
  const outer = new Error("request failed", { cause: inner });
  const out = r.value(outer);
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(TOKEN), "the cause chain leaked the credential");
  assert.ok(dumped.includes("request failed"));
});

test("deep cycles terminate rather than recurse forever", () => {
  const a: Record<string, unknown> = {};
  let cursor = a;
  for (let i = 0; i < 20; i++) {
    cursor["next"] = {};
    cursor = cursor["next"] as Record<string, unknown>;
  }
  const out = SHAPE_ONLY_REDACTOR.value(a);
  assert.ok(JSON.stringify(out).includes("[truncated]"));
});

test("the longest known value wins when one contains another", () => {
  const longer = TOKEN + "-suffix";
  const r = createRedactor({ values: [TOKEN, longer] });
  const out = r.text(`sent ${longer}`);
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes("-suffix"), "partial redaction left a fragment behind");
});
