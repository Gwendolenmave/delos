/**
 * Deterministic context assembly under a token budget.
 *
 * Inputs are structured context items; the output is what actually goes to
 * the model, plus an honest report of everything that did not and why.
 * Nothing here logs content - the report carries sources, counts and reasons
 * only, so it is safe to persist and show.
 *
 * The rules, in force order:
 *
 *   1. The current user message is NEVER trimmed. If it alone exceeds the
 *      budget it still goes, whole, and the report says the budget was
 *      exceeded - a truncated question silently answered is worse than an
 *      over-budget request the provider may refuse.
 *   2. A later explicit user correction knocks out the assistant claims it
 *      supersedes BEFORE budgeting, so a superseded claim cannot shove a
 *      correction out of the window.
 *   3. Under pressure, retention follows the trust order: lower-trust
 *      categories drop first, newest-first within a category (older material
 *      in the same category is likelier to already be reflected elsewhere...
 *      no - OLDEST drops first within a category, keeping the recent).
 *   4. Assistant prior claims are never promoted: they enter the prompt
 *      marked as the assistant's own earlier statements, not as user facts.
 */

import {
  TRUST_RANK,
  type ContextItem,
  type SourceCategory,
} from "../domain/context-item.js";

export interface AssembledContext {
  /** Items that go to the model, in stable input order. */
  readonly included: readonly ContextItem[];
  readonly report: ContextReport;
}

export interface ContextReport {
  /** Per-category counts of what went in. */
  readonly includedCounts: Readonly<Partial<Record<SourceCategory, number>>>;
  /** What was left out: source, count, and the reason - never the content. */
  readonly omitted: readonly {
    readonly source: SourceCategory;
    readonly count: number;
    readonly reason: "superseded-by-correction" | "budget";
  }[];
  /** Whether history was requested for this turn, and whether it was read. */
  readonly historyRequested: boolean;
  readonly historyRead: boolean;
  /** The current user message is never trimmed; this reports the overrun. */
  readonly budgetExceededByCurrentMessage: boolean;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
}

export interface AssembleOptions {
  readonly items: readonly ContextItem[];
  readonly budgetTokens: number;
  /** Deterministic token estimator, injected. */
  readonly estimate: (text: string) => number;
  readonly historyRequested: boolean;
  readonly historyRead: boolean;
}

export function assembleContext(options: AssembleOptions): AssembledContext {
  const { estimate, budgetTokens } = options;

  // --- rule 2: corrections knock out superseded claims first ---------------
  const supersededIds = new Set<string>();
  for (const item of options.items) {
    if (item.source === "explicit-user-correction") {
      for (const id of item.supersedes ?? []) supersededIds.add(id);
    }
  }
  const omittedSuperseded: ContextItem[] = [];
  const alive = options.items.filter((item) => {
    if (
      item.source === "assistant-prior-claim" &&
      item.id !== undefined &&
      supersededIds.has(item.id)
    ) {
      omittedSuperseded.push(item);
      return false;
    }
    return true;
  });

  // --- rule 1: the current message goes, whole, first ----------------------
  const current = alive.filter((i) => i.source === "current-user-message");
  const rest = alive.filter((i) => i.source !== "current-user-message");

  let spent = current.reduce((sum, i) => sum + estimate(i.content), 0);
  const budgetExceededByCurrentMessage = spent > budgetTokens;

  // --- rule 3: retain by trust, oldest-first drop within a category --------
  // Candidates are considered in trust order (highest first). Within one
  // category, later items (newer) are considered first, so the oldest drop
  // first when the budget runs out.
  const byTrust = [...rest].sort((a, b) => {
    const rank = TRUST_RANK[a.source] - TRUST_RANK[b.source];
    if (rank !== 0) return rank;
    // newer first for consideration
    return (b.atIso ?? "").localeCompare(a.atIso ?? "");
  });

  const kept = new Set<ContextItem>(current);
  const droppedForBudget: ContextItem[] = [];
  for (const item of byTrust) {
    const cost = estimate(item.content);
    if (spent + cost <= budgetTokens) {
      kept.add(item);
      spent += cost;
    } else {
      droppedForBudget.push(item);
    }
  }

  // Stable output: original input order, filtered to what survived.
  const included = options.items.filter((i) => kept.has(i));

  const includedCounts: Partial<Record<SourceCategory, number>> = {};
  for (const item of included) {
    includedCounts[item.source] = (includedCounts[item.source] ?? 0) + 1;
  }

  const omitted: { source: SourceCategory; count: number; reason: "superseded-by-correction" | "budget" }[] = [];
  const tally = (
    items: readonly ContextItem[],
    reason: "superseded-by-correction" | "budget",
  ): void => {
    const counts = new Map<SourceCategory, number>();
    for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    for (const [source, count] of counts) omitted.push({ source, count, reason });
  };
  tally(omittedSuperseded, "superseded-by-correction");
  tally(droppedForBudget, "budget");

  return {
    included,
    report: {
      includedCounts,
      omitted,
      historyRequested: options.historyRequested,
      historyRead: options.historyRead,
      budgetExceededByCurrentMessage,
      estimatedTokens: spent,
      budgetTokens,
    },
  };
}
