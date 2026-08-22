/**
 * token-estimate — synthetic tests. No fixture derives from a real
 * conversation.
 *
 * CJK probes are built from code points rather than written as literals, so
 * this file stays ASCII-only and the release scanner needs no exception for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultTokenEstimator,
  estimateTokens,
  type TokenEstimator,
} from "../core/services/token-estimate.js";

/** Three CJK ideographs, assembled from code points. */
const CJK3 = String.fromCodePoint(0x4e2d, 0x6587, 0x5b57);
/** One hiragana character. */
const KANA1 = String.fromCodePoint(0x3042);
/** One hangul syllable. */
const HANGUL1 = String.fromCodePoint(0xac00);

test("empty text costs nothing", () => {
  assert.equal(estimateTokens(""), 0);
});

test("latin text is charged at roughly one token per four characters", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("a partial group rounds up rather than down", () => {
  // Rounding down would let the window overrun the model's limit.
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("CJK is charged at one token per character", () => {
  assert.equal(estimateTokens(CJK3), 3);
});

test("kana and hangul are counted as CJK, not as latin", () => {
  assert.equal(estimateTokens(KANA1), 1);
  assert.equal(estimateTokens(HANGUL1), 1);
});

test("mixed text charges each script by its own rule", () => {
  // Four latin characters (1 token) plus three CJK characters (3 tokens).
  assert.equal(estimateTokens(`abcd${CJK3}`), 4);
});

test("the estimate never decreases as text grows", () => {
  let previous = 0;
  let sample = "";
  for (let i = 0; i < 40; i++) {
    sample += i % 5 === 0 ? CJK3 : "word ";
    const current = estimateTokens(sample);
    assert.ok(
      current >= previous,
      `estimate went down at step ${i}: ${previous} -> ${current}`,
    );
    previous = current;
  }
});

test("the estimator is swappable in one place", () => {
  const constant: TokenEstimator = () => 42;
  assert.equal(estimateTokens("anything at all", constant), 42);
  // The default is untouched by passing an alternative.
  assert.equal(estimateTokens("abcd"), 1);
});

test("the exported default is the function used when none is supplied", () => {
  assert.equal(estimateTokens("abcdefgh"), defaultTokenEstimator("abcdefgh"));
});
