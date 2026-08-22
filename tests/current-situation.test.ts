/**
 * Current Situation - deterministic tests with explicit clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createInMemorySituationStore,
  effectiveState,
  SituationError,
} from "../core/services/current-situation.js";

function store() {
  let n = 0;
  return createInMemorySituationStore(() => `sit-${++n}`);
}

const T0 = "2026-07-01T10:00:00.000Z";
const T1 = "2026-07-01T12:00:00.000Z";
const T2 = "2026-07-02T10:00:00.000Z";
const EXP = "2026-07-01T18:00:00.000Z";

test("create, appear while alive, vanish at expiry without cleanup", async () => {
  const s = store();
  const created = await s.create("On a train until this evening.", T0, EXP);
  assert.equal(created.state, "active");

  const before = await s.active(T1);
  assert.equal(before.length, 1);

  const after = await s.active(T2);
  assert.equal(after.length, 0, "expired situations stop influencing turns by themselves");

  // ...but remain inspectable, reported with their effective state.
  const all = await s.inspect();
  assert.equal(all.length, 1);
  assert.equal(effectiveState(all[0]!, T2), "expired");
});

test("editing supersedes: the old revision remains, marked and linked", async () => {
  const s = store();
  const first = await s.create("Working from the library.", T0, EXP);
  const second = await s.supersede(first.id, "Moved to the cafe.", T1, EXP);

  const active = await s.active(T1);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.text, "Moved to the cafe.");
  assert.equal(active[0]?.supersedesId, first.id);

  const all = await s.inspect();
  assert.equal(all.find((x) => x.id === first.id)?.state, "superseded");
});

test("ending is immediate and preserves the record", async () => {
  const s = store();
  const created = await s.create("At an appointment.", T0, EXP);
  await s.end(created.id, T1);
  assert.equal((await s.active(T1)).length, 0);
  assert.equal((await s.inspect())[0]?.state, "ended");
});

test("deleting removes the record entirely", async () => {
  const s = store();
  const created = await s.create("Temporary note.", T0, EXP);
  await s.delete(created.id);
  assert.equal((await s.inspect()).length, 0);
  await assert.rejects(() => s.delete(created.id), SituationError);
});

test("expiry must be in the future; text is bounded and required", async () => {
  const s = store();
  await assert.rejects(() => s.create("x", T1, T0), SituationError);
  await assert.rejects(() => s.create("", T0, EXP), SituationError);
  await assert.rejects(() => s.create("y".repeat(4001), T0, EXP), SituationError);
});

test("backup round-trips user-authored text and nothing else is invented", async () => {
  const a = store();
  await a.create("First situation.", T0, EXP);
  await a.create("Second situation.", T1, EXP);
  const snapshot = await a.exportAll();

  const b = store();
  const imported = await b.importAll(snapshot);
  assert.equal(imported, 2);
  assert.deepEqual(
    (await b.inspect()).map((x) => x.text).sort(),
    ["First situation.", "Second situation."],
  );

  await assert.rejects(() => b.importAll("not json"), SituationError);
  await assert.rejects(() => b.importAll('{"schemaVersion":9,"situations":[]}'), SituationError);
});

test("there is no path from model output into the store", () => {
  // Structural assertion: the store's surface has exactly the user-facing
  // verbs. Nothing accepts a model turn, a transcript, or a provider result.
  const s = store();
  assert.deepEqual(
    Object.keys(s).sort(),
    ["active", "create", "delete", "end", "exportAll", "importAll", "inspect", "supersede"],
  );
});
