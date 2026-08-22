/**
 * Structured context: every piece of material a turn is assembled from stays
 * TYPED until final rendering, so the runtime always knows what it is holding
 * and can answer for what it did with it.
 *
 * The trust order is the contract at the heart of Phase 2: when material
 * conflicts, or the budget forces choices, position in this list - not
 * recency, not length, not who shouted last - decides. Lower rank number =
 * higher trust.
 */

export const SOURCE_CATEGORIES = [
  "current-user-message",
  "explicit-user-correction",
  "current-situation",
  "requested-history",
  "recent-transcript",
  "persona-base",
  "persona-variant",
  "surface-context",
  "assistant-prior-claim",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/**
 * Trust ranking, exactly the documented order. Derived as a map so a category
 * added to the list without a rank assignment is a type error, not a silent
 * default.
 */
export const TRUST_RANK: Readonly<Record<SourceCategory, number>> = {
  "current-user-message": 1,
  "explicit-user-correction": 2,
  "current-situation": 3,
  "requested-history": 4,
  "recent-transcript": 5,
  "persona-base": 6,
  "persona-variant": 6, // enabled variants share base trust; they ARE persona
  "surface-context": 7,
  "assistant-prior-claim": 8,
};

export interface ContextItem {
  readonly source: SourceCategory;
  readonly content: string;
  /** When the underlying material happened, for chronology. Optional. */
  readonly atIso?: string;
  /**
   * For corrections: which prior claim(s) this supersedes, by item id.
   * For assistant claims: a stable id corrections can reference.
   */
  readonly id?: string;
  readonly supersedes?: readonly string[];
}
