/**
 * Deterministic history reads - synthetic transcript, exact expectations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createInMemoryHistoryReader,
  HistoryQueryError,
  type HistoryRecord,
} from "../core/services/history-read.js";

const TRANSCRIPT: readonly HistoryRecord[] = Array.from({ length: 10 }, (_, i) => ({
  id: `m-${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  text: i === 4 ? "We discussed the lighthouse plan here." : `Message number ${i}.`,
  atIso: `2026-07-0${Math.floor(i / 4) + 1}T0${i % 4}:00:00.000Z`,
}));

const reader = createInMemoryHistoryReader(() => TRANSCRIPT);

test("recent N returns exactly the newest N, chronological", async () => {
  const r = await reader.read({ kind: "recent", count: 3 });
  assert.deepEqual(r.records.map((x) => x.id), ["m-7", "m-8", "m-9"]);
  assert.equal(r.read, true);
});

test("a range is half-open and timezone-explicit", async () => {
  const r = await reader.read({
    kind: "range",
    fromIso: "2026-07-01T01:00:00.000Z",
    toIso: "2026-07-01T03:00:00.000Z",
  });
  assert.deepEqual(r.records.map((x) => x.id), ["m-1", "m-2"]);
});

test("a segment centres on the selected record", async () => {
  const r = await reader.read({ kind: "segment", id: "m-4", around: 1 });
  assert.deepEqual(r.records.map((x) => x.id), ["m-3", "m-4", "m-5"]);
});

test("a segment for an unknown id returns nothing rather than inventing", async () => {
  const r = await reader.read({ kind: "segment", id: "m-99", around: 2 });
  assert.deepEqual(r.records, []);
  assert.equal(r.read, true, "the read RAN; it found nothing, and says so");
});

test("keyword search is literal and case-insensitive with context", async () => {
  const r = await reader.read({ kind: "keyword", literal: "LIGHTHOUSE", around: 1 });
  assert.deepEqual(r.records.map((x) => x.id), ["m-3", "m-4", "m-5"]);
});

test("selected ids come from the store, never trusted from the caller", async () => {
  const r = await reader.read({ kind: "selected", ids: ["m-2", "m-9", "m-404"] });
  assert.deepEqual(r.records.map((x) => x.id), ["m-2", "m-9"]);
});

test("unbounded and malformed queries are refused", async () => {
  await assert.rejects(() => reader.read({ kind: "recent", count: 501 }), HistoryQueryError);
  await assert.rejects(() => reader.read({ kind: "recent", count: -1 }), HistoryQueryError);
  await assert.rejects(
    () => reader.read({ kind: "range", fromIso: "yesterday", toIso: "now" }),
    HistoryQueryError,
  );
  await assert.rejects(
    () => reader.read({ kind: "keyword", literal: "  ", around: 1 }),
    HistoryQueryError,
  );
});
