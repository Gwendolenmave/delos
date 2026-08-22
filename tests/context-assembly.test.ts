/**
 * Context assembly - deterministic tests. The estimator counts characters so
 * every budget number in here is exact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleContext } from "../core/services/context-assembly.js";
import { TRUST_RANK, SOURCE_CATEGORIES, type ContextItem } from "../core/domain/context-item.js";

const estimate = (text: string): number => text.length;

function item(source: ContextItem["source"], content: string, extra: Partial<ContextItem> = {}): ContextItem {
  return { source, content, ...extra };
}

function assemble(items: ContextItem[], budgetTokens: number, history = { requested: false, read: false }) {
  return assembleContext({
    items,
    budgetTokens,
    estimate,
    historyRequested: history.requested,
    historyRead: history.read,
  });
}

test("the trust order is exactly the documented ranking", () => {
  const ranks = SOURCE_CATEGORIES.map((c) => TRUST_RANK[c]);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 6, 7, 8]);
});

test("the current user message is never trimmed, even over budget", () => {
  const long = "Q".repeat(500);
  const out = assemble([item("current-user-message", long)], 100);
  assert.equal(out.included.length, 1);
  assert.equal(out.included[0]?.content, long, "not one byte trimmed");
  assert.equal(out.report.budgetExceededByCurrentMessage, true);
  assert.equal(out.report.estimatedTokens, 500);
});

test("under pressure, low-trust categories drop before high-trust ones", () => {
  const out = assemble(
    [
      item("current-user-message", "Q".repeat(10)),
      item("assistant-prior-claim", "A".repeat(40), { id: "c1" }),
      item("recent-transcript", "T".repeat(40)),
      item("current-situation", "S".repeat(40)),
    ],
    100, // fits current(10) + situation(40) + transcript(40) = 90; claim(40) does not
  );
  const sources = out.included.map((i) => i.source);
  assert.ok(sources.includes("current-situation"));
  assert.ok(sources.includes("recent-transcript"));
  assert.ok(!sources.includes("assistant-prior-claim"), "lowest trust drops first");
  assert.deepEqual(out.report.omitted, [
    { source: "assistant-prior-claim", count: 1, reason: "budget" },
  ]);
});

test("within a category the oldest drops first", () => {
  const out = assemble(
    [
      item("current-user-message", "Q".repeat(10)),
      item("recent-transcript", "OLD".padEnd(40, "x"), { atIso: "2026-01-01T00:00:00Z" }),
      item("recent-transcript", "MID".padEnd(40, "x"), { atIso: "2026-01-02T00:00:00Z" }),
      item("recent-transcript", "NEW".padEnd(40, "x"), { atIso: "2026-01-03T00:00:00Z" }),
    ],
    95, // current(10) + two transcripts(80) = 90; the third does not fit
  );
  const kept = out.included.filter((i) => i.source === "recent-transcript");
  assert.equal(kept.length, 2);
  assert.ok(kept.some((i) => i.content.startsWith("NEW")));
  assert.ok(kept.some((i) => i.content.startsWith("MID")));
  assert.ok(!kept.some((i) => i.content.startsWith("OLD")), "the oldest went first");
});

test("a correction removes the claims it supersedes before budgeting", () => {
  const out = assemble(
    [
      item("current-user-message", "Q".repeat(10)),
      item("assistant-prior-claim", "I previously said the meeting is Monday.", { id: "claim-1" }),
      item("explicit-user-correction", "No - the meeting is Tuesday.", { supersedes: ["claim-1"] }),
    ],
    10_000,
  );
  assert.ok(!out.included.some((i) => i.id === "claim-1"), "the superseded claim survived");
  assert.ok(out.included.some((i) => i.source === "explicit-user-correction"));
  assert.deepEqual(out.report.omitted, [
    { source: "assistant-prior-claim", count: 1, reason: "superseded-by-correction" },
  ]);
});

test("a superseded claim cannot crowd out its own correction under budget", () => {
  const bigClaim = item("assistant-prior-claim", "C".repeat(90), { id: "c1" });
  const correction = item("explicit-user-correction", "No: " + "x".repeat(20), {
    supersedes: ["c1"],
  });
  const out = assemble(
    [item("current-user-message", "Q".repeat(10)), bigClaim, correction],
    60, // without rule 2, the claim considered before... trust puts correction first anyway; the point: claim is GONE, not merely deprioritised
  );
  assert.ok(out.included.some((i) => i.source === "explicit-user-correction"));
  assert.ok(!out.included.some((i) => i.source === "assistant-prior-claim"));
  assert.equal(
    out.report.omitted.find((o) => o.source === "assistant-prior-claim")?.reason,
    "superseded-by-correction",
    "removed as superseded, not squeezed by budget",
  );
});

test("output preserves stable input order for the survivors", () => {
  const a = item("persona-base", "base block");
  const b = item("recent-transcript", "earlier turn");
  const c = item("current-user-message", "the question");
  const out = assemble([a, b, c], 10_000);
  assert.deepEqual(out.included, [a, b, c], "input order, not trust order");
});

test("the report carries counts and honesty flags, never content", () => {
  const out = assemble(
    [
      item("current-user-message", "Q"),
      item("persona-base", "SECRET-SHAPED-CONTENT".repeat(10)),
    ],
    5,
    { requested: true, read: false },
  );
  assert.equal(out.report.historyRequested, true);
  assert.equal(out.report.historyRead, false, "requested but not read is reported as exactly that");
  assert.ok(!JSON.stringify(out.report).includes("SECRET-SHAPED"), "report leaked content");
  assert.equal(out.report.includedCounts["current-user-message"], 1);
});
