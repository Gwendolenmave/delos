/**
 * Model-output containment - synthetic tests.
 *
 * The two properties under test: internal material never survives into the
 * displayable text, and the record of removal never contains the removed
 * content. Equally important: legitimate text is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { containModelOutput } from "../core/services/output-containment.js";

const sha256 = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
const OPTS = { providerKind: "openai-compatible", nowIso: () => "2020-01-01T00:00:00.000Z", sha256 };

test("a leading reasoning wrapper is removed and recorded, prose survives", () => {
  const hidden = "INTERNAL-CHAIN-" + "MUST-NOT-SURFACE";
  const raw = `<thinking>${hidden}</thinking>\nHere is the actual answer.`;
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.ok, true);
  assert.equal(out.text, "Here is the actual answer.");
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0]?.reason, "reasoning_wrapper");
  assert.ok(out.records[0]!.bytes > hidden.length);
  assert.match(out.records[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(out).includes(hidden), "the removed content leaked into the result");
});

test("an unterminated wrapper means the whole turn is contained and failed", () => {
  const out = containModelOutput("<reasoning>never closed, nothing displayable", OPTS);
  assert.equal(out.ok, false);
  assert.equal(out.text, "");
  assert.equal(out.records[0]?.reason, "reasoning_wrapper");
});

test("a reply that IS an internal event envelope is contained entirely", () => {
  const out = containModelOutput('{"type":"tool_call","delta":{"name":"run"}}', OPTS);
  assert.equal(out.ok, false);
  assert.equal(out.records[0]?.reason, "internal_event_json");
});

test("a reply that merely CONTAINS a JSON code block is untouched", () => {
  const raw = 'Use this config:\n\n```json\n{"type":"tool_call"}\n```\n\nThat is all.';
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.ok, true);
  assert.equal(out.text, raw);
  assert.equal(out.records.length, 0);
});

test("a fake next-user continuation is cut at the role line", () => {
  const raw = "Here is my answer.\n\nUser: and now I will invent your reply\nAssistant: sure";
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.ok, true);
  assert.equal(out.text, "Here is my answer.");
  assert.equal(out.records[0]?.reason, "fake_role_continuation");
});

test("discussing role labels inside a code fence survives", () => {
  const raw = "Transcript format:\n```\nUser: hello\nSystem: hi\n```\nThat is the shape.";
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.text, raw);
  assert.equal(out.records.length, 0);
});

test("a quoted role label after a quote marker survives", () => {
  const raw = "You asked what they wrote:\n> quoted below\nUser: is what the log said";
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.text, raw);
});

test("a system-prompt echo is removed and the rest kept", () => {
  const system = "S".repeat(50) + " assembled persona framing " + "P".repeat(50);
  const raw = `${system}\nNow the real reply.`;
  const out = containModelOutput(raw, { ...OPTS, systemPrompt: system });
  assert.equal(out.ok, true);
  assert.equal(out.text, "Now the real reply.");
  assert.equal(out.records[0]?.reason, "context_echo");
  assert.ok(!JSON.stringify(out.records).includes("assembled persona framing"));
});

test("ordinary markdown with headers, code and lists passes byte-identical", () => {
  const raw = "# Title\n\n- a list\n- with items\n\n```ts\nconst x = 1;\n```\n\n*emphasis* and `code`.";
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.text, raw);
  assert.equal(out.records.length, 0);
});

test("a conversation about prompt injection is not itself contained", () => {
  const raw =
    "Prompt injection is when text like <thinking> tags or a line starting " +
    "with a role name tries to smuggle instructions. Defend by anchoring rules.";
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.text, raw);
  assert.equal(out.records.length, 0);
});

test("multiple removals accumulate distinct records, content stored nowhere", () => {
  const wrapped1 = "WRAPPED-" + "INTERNAL-1";
  const raw = `<thinking>${wrapped1}</thinking>Answer text.\nUser: fake follow-up`;
  const out = containModelOutput(raw, OPTS);
  assert.equal(out.text, "Answer text.");
  assert.deepEqual(out.records.map((r) => r.reason), ["reasoning_wrapper", "fake_role_continuation"]);
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(wrapped1) && !dumped.includes("fake follow-up"));
});

test("records carry provider kind and injected timestamp", () => {
  const out = containModelOutput("<thinking>x</thinking>ok", {
    providerKind: "anthropic",
    nowIso: () => "2021-06-01T12:00:00.000Z",
    sha256,
  });
  assert.equal(out.records[0]?.providerKind, "anthropic");
  assert.equal(out.records[0]?.atIso, "2021-06-01T12:00:00.000Z");
});

test("the DeepSeek-style <think> tag is contained", () => {
  const hidden = "REASONING-" + "R1-MUST-NOT-SURFACE";
  const out = containModelOutput(`<think>${hidden}</think>The answer is 42.`, OPTS);
  assert.equal(out.text, "The answer is 42.");
  assert.ok(!JSON.stringify(out).includes(hidden));
});

test("consecutive leading reasoning wrappers are ALL removed", () => {
  const a = "FIRST-" + "SECRET";
  const b = "SECOND-" + "SECRET";
  const out = containModelOutput(`<think>${a}</think><reasoning>${b}</reasoning>Final answer.`, OPTS);
  assert.equal(out.text, "Final answer.");
  assert.equal(out.records.length, 2);
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(a) && !dumped.includes(b));
});

test("a legitimately-requested bare JSON payload with type/event is NOT emptied", () => {
  const payload = '{"type":"push","event":"created","ref":"refs/heads/main"}';
  const out = containModelOutput(payload, OPTS);
  assert.equal(out.text, payload, "generic type/event keys must not trigger envelope containment");
  assert.equal(out.records.length, 0);
});

test("a real tool-call envelope IS contained", () => {
  const out = containModelOutput('{"tool_call":{"name":"x"},"type":"function"}', OPTS);
  assert.equal(out.text, "");
  assert.equal(out.records[0]?.reason, "internal_event_json");
});
