/**
 * recent-window - synthetic tests.
 *
 * Most tests inject a stub estimator so costs are exact and the assertions
 * describe the SELECTION rule rather than the heuristic's arithmetic. Testing
 * a policy through an estimator you cannot predict tests neither.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectRecentWindow,
  RecentWindowConfigError,
  RecentWindowEstimateError,
} from "../core/services/recent-window.js";
import type { TokenEstimator } from "../core/services/token-estimate.js";
import type { ChatMessage } from "../core/domain/types.js";

/** One token per character: costs are then obvious by inspection. */
const perChar: TokenEstimator = (text) => text.length;

/** Every message costs exactly 10, whatever it says. */
const flat10: TokenEstimator = () => 10;

function msg(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "user", text, ...extra };
}

/** Four messages of 10 tokens each under `flat10`, oldest to newest. */
const FOUR: readonly ChatMessage[] = [
  msg("first"),
  msg("second"),
  msg("third"),
  msg("fourth"),
];

// --- basic selection -------------------------------------------------------

test("empty input gives an empty window and nothing omitted", () => {
  const r = selectRecentWindow([], { maxEstimatedTokens: 100 });
  assert.deepEqual(r.messages, []);
  assert.equal(r.estimatedTokens, 0);
  assert.equal(r.omittedCount, 0);
});

test("everything fits when the budget is large enough", () => {
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 1000,
    estimator: flat10,
  });
  assert.equal(r.messages.length, 4);
  assert.equal(r.estimatedTokens, 40);
  assert.equal(r.omittedCount, 0);
});

test("only the newest message fits when the budget allows one", () => {
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 10,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["fourth"]);
  assert.equal(r.estimatedTokens, 10);
  assert.equal(r.omittedCount, 3);
});

test("a budget exactly equal to the selection is enough, not one short", () => {
  // The boundary is >, not >=: spending the last token is allowed.
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 20,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["third", "fourth"]);
  assert.equal(r.estimatedTokens, 20);
  assert.equal(r.omittedCount, 2);
});

test("a newest message larger than the budget yields an empty window", () => {
  const r = selectRecentWindow([msg("tiny"), msg("x".repeat(500))], {
    maxEstimatedTokens: 100,
    estimator: perChar,
  });
  assert.deepEqual(r.messages, []);
  assert.equal(r.estimatedTokens, 0);
  assert.equal(r.omittedCount, 2);
});

test("an oversized newest message is not skipped to reach cheaper older ones", () => {
  // Skipping would turn a recent window into a content-blind sparse sample:
  // the caller would believe it had recent context and would not.
  const messages = [msg("a"), msg("b"), msg("x".repeat(500)), msg("y".repeat(500))];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 100,
    estimator: perChar,
  });
  assert.deepEqual(r.messages, []);
  assert.equal(r.omittedCount, 4);
});

test("a gap stops the search even when older messages would fit", () => {
  const messages = [msg("a"), msg("b"), msg("x".repeat(50)), msg("c")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 10,
    estimator: perChar,
  });
  // "c" costs 1 and fits; the 50-character message then does not, and the
  // search stops there rather than reaching back for "a" and "b".
  assert.deepEqual(r.messages.map((m) => m.text), ["c"]);
  assert.equal(r.omittedCount, 3);
});

// --- budget arithmetic -----------------------------------------------------

test("reserveTokens is deducted from the budget", () => {
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 40,
    reserveTokens: 20,
    estimator: flat10,
  });
  assert.equal(r.messages.length, 2);
  assert.equal(r.estimatedTokens, 20);
});

test("a zero available budget selects nothing and omits everything", () => {
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 0,
    estimator: flat10,
  });
  assert.deepEqual(r.messages, []);
  assert.equal(r.estimatedTokens, 0);
  assert.equal(r.omittedCount, 4);
});

test("reserving more than the budget clamps to zero rather than throwing", () => {
  // Each value is readable; only their difference is negative. The caller can
  // see what happened from omittedCount.
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 10,
    reserveTokens: 999,
    estimator: flat10,
  });
  assert.deepEqual(r.messages, []);
  assert.equal(r.omittedCount, 4);
});

test("unreadable option values are typed failures, not silent repairs", () => {
  const bad: Array<[string, number]> = [
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["fractional", 10.5],
  ];
  for (const [label, value] of bad) {
    assert.throws(
      () => selectRecentWindow(FOUR, { maxEstimatedTokens: value }),
      (error: unknown) => {
        assert.ok(error instanceof RecentWindowConfigError, `${label}: wrong type`);
        assert.equal(error.option, "maxEstimatedTokens");
        return true;
      },
      `maxEstimatedTokens ${label} should throw`,
    );
    assert.throws(
      () =>
        selectRecentWindow(FOUR, {
          maxEstimatedTokens: 100,
          reserveTokens: value,
        }),
      (error: unknown) => {
        assert.ok(error instanceof RecentWindowConfigError, `${label}: wrong type`);
        assert.equal(error.option, "reserveTokens");
        return true;
      },
      `reserveTokens ${label} should throw`,
    );
  }
});

test("a zero budget is valid, not an error", () => {
  assert.doesNotThrow(() => selectRecentWindow(FOUR, { maxEstimatedTokens: 0 }));
});

// --- estimator output validation -------------------------------------------

test("an unusable estimator cost is a typed failure", () => {
  const bad: Array<[string, number]> = [
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["fractional", 1.5],
  ];
  for (const [label, value] of bad) {
    assert.throws(
      () =>
        selectRecentWindow(FOUR, {
          maxEstimatedTokens: 1000,
          estimator: () => value,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof RecentWindowEstimateError,
          `${label}: wrong error type`,
        );
        assert.equal(error.received, value);
        assert.equal(typeof error.messageIndex, "number");
        return true;
      },
      `${label} cost should throw`,
    );
  }
});

test("a zero cost is legitimate", () => {
  const r = selectRecentWindow(FOUR, {
    maxEstimatedTokens: 0,
    estimator: () => 0,
  });
  assert.equal(r.messages.length, 4);
  assert.equal(r.estimatedTokens, 0);
  assert.equal(r.omittedCount, 0);
});

test("an estimate error carries the index but never the message text", () => {
  // An error is one of the places text leaks into logs.
  const conversationText = "PRIVATE-CONVERSATION-CONTENT";
  try {
    selectRecentWindow([msg("ok"), msg(conversationText)], {
      maxEstimatedTokens: 100,
      estimator: (text) => (text === conversationText ? -5 : 1),
    });
    assert.fail("expected a RecentWindowEstimateError");
  } catch (error) {
    assert.ok(error instanceof RecentWindowEstimateError);
    assert.equal(error.messageIndex, 1);
    assert.equal(error.received, -5);
    assert.ok(!error.message.includes(conversationText), "error message leaked the text");
    assert.ok(!JSON.stringify(error.received).includes(conversationText));
  }
});

test("an unusable cost returns no partial selection", () => {
  // The newest message estimates fine; the next one does not. Nothing may be
  // returned - a window built on a corrupt budget is worse than no window.
  let calls = 0;
  assert.throws(
    () =>
      selectRecentWindow(FOUR, {
        maxEstimatedTokens: 1000,
        estimator: () => {
          calls += 1;
          return calls === 1 ? 10 : Number.NaN;
        },
      }),
    RecentWindowEstimateError,
  );
});

test("an exception raised by the estimator propagates unchanged", () => {
  class EstimatorBlewUp extends Error {}
  assert.throws(
    () =>
      selectRecentWindow(FOUR, {
        maxEstimatedTokens: 1000,
        estimator: () => {
          throw new EstimatorBlewUp("tokenizer unavailable");
        },
      }),
    (error: unknown) => {
      // Not wrapped: the caller's own stack trace stays intact.
      assert.ok(error instanceof EstimatorBlewUp);
      assert.ok(!(error instanceof RecentWindowEstimateError));
      return true;
    },
  );
});

// --- immutability ----------------------------------------------------------

test("the input array is not modified", () => {
  const input = [...FOUR];
  const before = [...input];
  selectRecentWindow(input, { maxEstimatedTokens: 15, estimator: flat10 });
  assert.deepEqual(input, before);
  assert.equal(input.length, 4);
});

test("the result is a fresh array, never an alias of the input", () => {
  const input = [...FOUR];
  const r = selectRecentWindow(input, { maxEstimatedTokens: 1000, estimator: flat10 });
  assert.notEqual(r.messages, input as unknown as readonly ChatMessage[]);
  assert.deepEqual(r.messages, input);
});

test("message objects are passed through unchanged, character for character", () => {
  const text = "Line one\n\tindented\n\nEmoji " + String.fromCodePoint(0x1f600) +
    " and `code` and **bold**";
  const original = msg(text, { messageId: "m-1", atIso: "2020-01-01T00:00:00Z" });
  const r = selectRecentWindow([original], {
    maxEstimatedTokens: 10_000,
    estimator: flat10,
  });
  const selected = r.messages[0];
  assert.ok(selected);
  assert.equal(selected.text, text);
  assert.equal(selected.messageId, "m-1");
  assert.equal(selected.atIso, "2020-01-01T00:00:00Z");
});

// --- ordering and independence from metadata -------------------------------

test("the result is a contiguous suffix in oldest-to-newest order", () => {
  const messages = [msg("1"), msg("2"), msg("3"), msg("4"), msg("5")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 30,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["3", "4", "5"]);
});

test("messages are not reordered by atIso", () => {
  // Deliberately reversed timestamps: array order wins, because repairing the
  // caller's data would hide their bug behind a heuristic.
  const messages = [
    msg("first", { atIso: "2030-01-01T00:00:00Z" }),
    msg("second", { atIso: "2020-01-01T00:00:00Z" }),
    msg("third", { atIso: "2025-01-01T00:00:00Z" }),
  ];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 1000,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["first", "second", "third"]);
});

test("messageId is not required and not used for selection", () => {
  const messages = [msg("a"), msg("b", { messageId: "m-2" }), msg("c")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 20,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["b", "c"]);
});

test("roles do not influence selection", () => {
  // A window starting on an assistant message is left alone. Reaching back for
  // an older user message to "balance" it would break the budget and bake one
  // provider's format preference into a general strategy.
  const messages = [
    msg("u1", { role: "user" }),
    msg("a1", { role: "assistant" }),
    msg("u2", { role: "user" }),
    msg("a2", { role: "assistant" }),
  ];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 30,
    estimator: flat10,
  });
  assert.deepEqual(r.messages.map((m) => m.role), ["assistant", "user", "assistant"]);
});

test("an empty-text message is kept; its cost is the estimator's business", () => {
  const messages = [msg("keep"), msg("")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 100,
    estimator: perChar,
  });
  assert.equal(r.messages.length, 2);
  assert.equal(r.estimatedTokens, 4);
});

// --- metadata and purity ---------------------------------------------------

test("estimatedTokens equals the cost of exactly the selected messages", () => {
  const messages = [msg("aaaa"), msg("bb"), msg("c")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 3,
    estimator: perChar,
  });
  assert.deepEqual(r.messages.map((m) => m.text), ["bb", "c"]);
  assert.equal(r.estimatedTokens, 3);
});

test("omittedCount is input count minus selected count", () => {
  const messages = [msg("1"), msg("2"), msg("3"), msg("4"), msg("5")];
  const r = selectRecentWindow(messages, {
    maxEstimatedTokens: 20,
    estimator: flat10,
  });
  assert.equal(r.messages.length, 2);
  assert.equal(r.omittedCount, 3);
  assert.equal(r.messages.length + r.omittedCount, messages.length);
});

test("the estimator is called only with message text", () => {
  const seen: string[] = [];
  const spy: TokenEstimator = (text) => {
    seen.push(text);
    return 1;
  };
  selectRecentWindow([msg("alpha"), msg("beta")], {
    maxEstimatedTokens: 100,
    estimator: spy,
  });
  assert.deepEqual(seen, ["beta", "alpha"]);
});

test("no per-message overhead is added on top of the estimator", () => {
  // A surcharge for some renderer's prefix would be a surface's cost baked
  // into a core policy.
  const r = selectRecentWindow([msg("abc"), msg("de")], {
    maxEstimatedTokens: 100,
    estimator: perChar,
  });
  assert.equal(r.estimatedTokens, 5);
});

test("repeated calls with the same input give the same result: no carried state", () => {
  const input = [...FOUR];
  const first = selectRecentWindow(input, { maxEstimatedTokens: 25, estimator: flat10 });
  const second = selectRecentWindow(input, { maxEstimatedTokens: 25, estimator: flat10 });
  const third = selectRecentWindow(input, { maxEstimatedTokens: 25, estimator: flat10 });
  assert.deepEqual(first.messages, second.messages);
  assert.deepEqual(second.messages, third.messages);
  assert.equal(first.estimatedTokens, third.estimatedTokens);
  assert.equal(first.omittedCount, third.omittedCount);
});

test("the default estimator is used when none is injected", () => {
  const r = selectRecentWindow([msg("abcd")], { maxEstimatedTokens: 100 });
  assert.equal(r.messages.length, 1);
  assert.equal(r.estimatedTokens, 1); // four latin characters ~ one token
});
