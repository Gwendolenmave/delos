/**
 * Centralised, swappable token estimator.
 *
 * Delos ships no tokenizer dependency, so this is a deterministic heuristic —
 * NOT an exact BPE count. It is deliberately isolated behind the
 * {@link TokenEstimator} type and the {@link defaultTokenEstimator} export so
 * a real tokenizer can replace it in ONE place without touching call sites.
 *
 * Heuristic, for mixed CJK/Latin text:
 *   - CJK ideographs, kana, and hangul  ~ 1 token per character;
 *   - everything else                   ~ 1 token per 4 characters.
 *
 * It rounds up and errs slightly HIGH on CJK, which is the safe direction for
 * a budget cap: over-estimating trims the context window early rather than
 * overrunning the model's limit.
 *
 * Accuracy note for anyone relying on this: real tokenizers differ per model
 * family, and this heuristic can be wrong by a wide margin on code, on heavy
 * punctuation, and on languages it does not model. It exists to keep a budget
 * honest, not to predict billing.
 */

export type TokenEstimator = (text: string) => number;

/**
 * Ranges are written as escapes rather than literal characters so this file
 * stays ASCII-only:
 *   U+3400-U+9FFF  CJK ideographs (extension A and unified)
 *   U+3040-U+30FF  kana
 *   U+AC00-U+D7AF  hangul syllables
 *   U+F900-U+FAFF  compatibility ideographs
 *   U+FF00-U+FFEF  halfwidth and fullwidth forms
 */
const CJK_PATTERN =
  /[\u{3400}-\u{9FFF}\u{3040}-\u{30FF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}]/gu;

/** Default heuristic estimator; see module docs for the model and rationale. */
export const defaultTokenEstimator: TokenEstimator = (text) => {
  if (text.length === 0) {
    return 0;
  }
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const rest = [...text].length - cjk;
  return cjk + Math.ceil(rest / 4);
};

/** Convenience wrapper so call sites read as estimateTokens(text). */
export function estimateTokens(
  text: string,
  estimator: TokenEstimator = defaultTokenEstimator,
): number {
  return estimator(text);
}
