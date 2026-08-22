/**
 * Reply segmentation - the 13.3 rules, each proven separately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  segmentReply,
  TRUNCATION_NOTICE,
  type SegmentationOptions,
} from "../core/services/reply-segmentation.js";

const OPTS: SegmentationOptions = { maxSegmentLength: 200 };

test("segmentation: short text is untouched", () => {
  assert.deepEqual(segmentReply("short reply", OPTS), ["short reply"]);
});

test("segmentation: splits at paragraph boundaries first", () => {
  const a = "First paragraph. ".repeat(8).trim();
  const b = "Second paragraph. ".repeat(8).trim();
  const segments = segmentReply(`${a}\n\n${b}`, OPTS);
  assert.equal(segments.length, 2);
  assert.match(segments[0] ?? "", /^First/);
  assert.match(segments[1] ?? "", /^Second/);
  for (const segment of segments) assert.ok(segment.length <= 200);
});

test("segmentation: sentence boundaries inside an overlong paragraph", () => {
  const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
  const segments = segmentReply(text, OPTS);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(segment.length <= 200);
    assert.match(segment, /\.$/, "each segment ends on a sentence boundary");
  }
  const compact = (s: string) => s.replace(/\s+/g, " ");
  assert.equal(compact(segments.join(" ")), compact(text));
});

test("segmentation: a code fence that fits travels whole", () => {
  const fence = "```ts\nconst x = 1;\nconst y = 2;\n```";
  const padding = "Padding sentence. ".repeat(10).trim();
  const segments = segmentReply(`${padding}\n\n${fence}\n\n${padding}`, OPTS);
  const withFence = segments.filter((s) => s.includes("```ts"));
  assert.equal(withFence.length, 1, "the fence must not be split");
  assert.match(withFence[0] ?? "", /```ts\nconst x = 1;\nconst y = 2;\n```/);
});

test("segmentation: an overlong fence splits between lines and re-opens", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line_${i} = ${i} + ${i};`);
  const text = "```py\n" + lines.join("\n") + "\n```";
  const segments = segmentReply(text, OPTS);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(segment.length <= 200, "a fence segment exceeded the limit");
    assert.match(segment, /^```py\n/, "every piece re-opens the fence with its info string");
    assert.match(segment, /\n```$/, "every piece closes its fence");
  }
  const recovered = segments
    .map((s) => s.replace(/^```py\n/, "").replace(/\n```$/, ""))
    .join("\n");
  assert.equal(recovered, lines.join("\n"), "no code line lost or reordered");
});

test("segmentation: tiny fragments merge instead of travelling alone", () => {
  const big = "A full paragraph of reasonable length. ".repeat(4).trim();
  const tiny = "Ok.";
  const segments = segmentReply(`${big}\n\n${tiny}`, OPTS);
  assert.equal(segments.length, 1, "the tiny fragment should merge into the previous segment");
  assert.match(segments[0] ?? "", /Ok\.$/);
});

test("segmentation: the segment cap truncates visibly, inside the limit", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. `.repeat(10).trim()).join("\n\n");
  const segments = segmentReply(text, { maxSegmentLength: 200, maxSegments: 3 });
  assert.equal(segments.length, 3);
  const last = segments[2] ?? "";
  assert.ok(last.endsWith(TRUNCATION_NOTICE), "truncation must be stated, never silent");
  assert.ok(last.length <= 200, "the notice must not push the segment over the limit");
});

/** True when the string contains no lone half of a surrogate pair. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

test("segmentation: never bisects a surrogate pair on hard cuts", () => {
  // CJK-shaped prose built from code points (the tracked tree stays
  // English-only): unbroken ideographs force the hard-cut path, with an
  // astral emoji straddling the boundary.
  const ideographA = String.fromCodePoint(0x7136);
  const ideographB = String.fromCodePoint(0x4e4b);
  const emoji = String.fromCodePoint(0x1f600);
  const text = ideographA.repeat(199) + emoji + ideographB.repeat(400);
  const segments = segmentReply(text, OPTS);
  for (const segment of segments) {
    assert.ok(segment.length <= 200);
    assert.ok(wellFormed(segment), "a segment carries a lone surrogate");
  }
  assert.equal(segments.map((s) => s.replace(/\s+/g, "")).join(""), text);
});

test("segmentation: an unclosed fence is closed rather than leaking", () => {
  const text = "Intro paragraph.\n\n```js\nconst a = 1;" + "\nconst b = 2;".repeat(30);
  const segments = segmentReply(text, OPTS);
  for (const segment of segments.filter((s) => s.includes("const"))) {
    assert.match(segment, /\n```$/, "code pieces must close their fence");
  }
});
