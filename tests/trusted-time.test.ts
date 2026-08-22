/**
 * Trusted time - deterministic tests with an injected clock.
 *
 * The DST cases pin real transitions: Europe/London springs forward
 * 2026-03-29 01:00 UTC and falls back 2026-10-25 01:00 UTC. Asia/Shanghai has
 * no DST and a constant +08:00 offset, which is the anti-regression control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTrustedClock,
  utcOffsetAt,
  wallClockAt,
} from "../core/services/trusted-time.js";

const T = (iso: string): number => Date.parse(iso);

test("an injected clock is authoritative and renders deterministically", () => {
  const clock = createTrustedClock({
    now: () => T("2026-07-01T06:30:00.000Z"),
    timeZone: "Asia/Shanghai",
    locale: "en-GB",
  });
  const now = clock.now();
  assert.equal(now.utcIso, "2026-07-01T06:30:00.000Z");
  assert.equal(now.timeZone, "Asia/Shanghai");
  assert.equal(now.fallback, "2026-07-01 14:30 (+08:00)");
  assert.equal(now.degraded, false);
  assert.ok(now.display.includes("14:30"), `display was ${now.display}`);
});

test("DST spring-forward shifts the offset, DST-free zones hold steady", () => {
  const before = T("2026-03-29T00:30:00.000Z");
  const after = T("2026-03-29T01:30:00.000Z");
  assert.equal(utcOffsetAt(before, "Europe/London"), "+00:00");
  assert.equal(utcOffsetAt(after, "Europe/London"), "+01:00");
  assert.equal(utcOffsetAt(before, "Asia/Shanghai"), "+08:00");
  assert.equal(utcOffsetAt(after, "Asia/Shanghai"), "+08:00");
});

test("DST fall-back is handled at the repeated hour", () => {
  const beforeFallback = T("2026-10-25T00:30:00.000Z"); // 01:30 BST
  const afterFallback = T("2026-10-25T01:30:00.000Z"); // 01:30 GMT again
  assert.equal(utcOffsetAt(beforeFallback, "Europe/London"), "+01:00");
  assert.equal(utcOffsetAt(afterFallback, "Europe/London"), "+00:00");
  // Both instants render as wall-clock 01:30 - which is why the fallback
  // string carries the offset: it disambiguates the repeated hour.
  assert.equal(wallClockAt(beforeFallback, "Europe/London").hour, 1);
  assert.equal(wallClockAt(afterFallback, "Europe/London").hour, 1);
});

test("midnight boundaries respect the timezone, not UTC", () => {
  const instant = T("2026-07-01T17:30:00.000Z"); // 01:30 next day in Shanghai
  const wall = wallClockAt(instant, "Asia/Shanghai");
  assert.deepEqual([wall.month, wall.day, wall.hour], [7, 2, 1]);
  const utcWall = wallClockAt(instant, "UTC");
  assert.deepEqual([utcWall.day, utcWall.hour], [1, 17]);
});

test("an unsupported timezone degrades explicitly to UTC, never silently", () => {
  const clock = createTrustedClock({
    now: () => T("2026-07-01T06:30:00.000Z"),
    timeZone: "Not/AZone",
  });
  const now = clock.now();
  assert.equal(now.degraded, true);
  assert.equal(now.timeZone, "UTC");
  assert.equal(now.display, now.fallback, "degraded rendering uses the unambiguous form");
  assert.equal(now.fallback, "2026-07-01 06:30 (+00:00)");
});

test("the host default is used when no override is given", () => {
  const clock = createTrustedClock({ now: () => T("2026-07-01T06:30:00.000Z") });
  const now = clock.now();
  assert.equal(now.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  assert.equal(now.degraded, false);
});
