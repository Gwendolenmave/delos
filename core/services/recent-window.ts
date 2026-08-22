/**
 * Recent context window.
 *
 * A stateless, single-turn strategy for choosing how much recent conversation
 * to carry into a request. Nothing more.
 *
 * **This is not a memory system.** It is not a memory backend, a conversation
 * database, a transcript archive, a summariser, a semantic retriever, a
 * session manager, a provider context protocol, or a persistence schema. It
 * reads no disk, writes no disk, opens no socket, and keeps no state between
 * calls. It defines no shape a future memory system would have to inherit -
 * it consumes messages the caller already has and returns a slice of them.
 *
 * "Recent" here is **positional, not semantic**. This module never decides
 * that one message matters more than another. It does not read roles,
 * timestamps, keywords, sentiment, or persona; it does not reorder, truncate,
 * summarise, deduplicate, or rewrite. Any of those would be a different
 * strategy, and should be written as one rather than smuggled in here.
 */

import type { ChatMessage } from "../domain/types.js";
import { defaultTokenEstimator, type TokenEstimator } from "./token-estimate.js";

export interface RecentWindowOptions {
  /** Total estimated-token budget for the window. Finite integer, >= 0. */
  readonly maxEstimatedTokens: number;
  /**
   * Tokens withheld from the budget for whatever the caller will add around
   * this window - a system prompt, the current user message, an adapter's own
   * envelope. Finite integer, >= 0. Defaults to 0.
   */
  readonly reserveTokens?: number;
  /** Cost model. Injected so a real tokenizer can replace the heuristic. */
  readonly estimator?: TokenEstimator;
}

export interface RecentWindowResult {
  /** The selected messages, oldest to newest. A fresh array, never an alias. */
  readonly messages: readonly ChatMessage[];
  /** Sum of the estimated cost of exactly the selected messages. */
  readonly estimatedTokens: number;
  /** Input message count minus selected message count. */
  readonly omittedCount: number;
}

/**
 * An option value that cannot be interpreted.
 *
 * Silently repairing a caller's arithmetic would hide a bug in whatever
 * computed the budget, and the symptom - an assistant that quietly forgot the
 * conversation - would surface far from its cause.
 */
export class RecentWindowConfigError extends Error {
  constructor(
    readonly option: "maxEstimatedTokens" | "reserveTokens",
    readonly received: unknown,
    message: string,
  ) {
    super(message);
    this.name = "RecentWindowConfigError";
  }
}

/**
 * An injected estimator returned a cost that cannot be used.
 *
 * A cost that is negative, fractional, NaN or infinite silently corrupts the
 * budget: negative costs would let the window grow without bound, NaN makes
 * every comparison false so nothing is ever selected, and a fraction makes
 * the budget depend on an undocumented rounding direction. Failing loudly
 * points at the estimator; absorbing it would produce a window that is wrong
 * for reasons no one can see.
 *
 * Carries the message index and the offending value. **Never the message
 * text** - an error is a place text leaks into logs.
 */
export class RecentWindowEstimateError extends Error {
  constructor(
    readonly messageIndex: number,
    readonly received: unknown,
    message: string,
  ) {
    super(message);
    this.name = "RecentWindowEstimateError";
  }
}

function requireEstimatedCost(index: number, cost: number): void {
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    throw new RecentWindowEstimateError(
      index,
      cost,
      `estimator returned a non-finite cost ${String(cost)} for message index ${index}`,
    );
  }
  if (!Number.isInteger(cost)) {
    throw new RecentWindowEstimateError(
      index,
      cost,
      `estimator returned a fractional cost ${String(cost)} for message index ${index}`,
    );
  }
  if (cost < 0) {
    throw new RecentWindowEstimateError(
      index,
      cost,
      `estimator returned a negative cost ${String(cost)} for message index ${index}`,
    );
  }
}

function requireTokenCount(
  option: "maxEstimatedTokens" | "reserveTokens",
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new RecentWindowConfigError(
      option,
      value,
      `${option} must be a finite number, received ${String(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    // Rounding silently would make the budget depend on an undocumented
    // rounding direction.
    throw new RecentWindowConfigError(
      option,
      value,
      `${option} must be an integer, received ${String(value)}`,
    );
  }
  if (value < 0) {
    throw new RecentWindowConfigError(
      option,
      value,
      `${option} must be zero or greater, received ${String(value)}`,
    );
  }
}

/**
 * Select the newest contiguous run of messages that fits the budget.
 *
 * Input is taken in the order the caller supplied it, oldest to newest. This
 * module does not sort by `atIso`, does not require `messageId`, and does not
 * infer sessions, threads, episodes or conversation boundaries. If the caller
 * passes messages out of order, the result follows the array - quietly
 * "fixing" a caller's data would hide their bug and make this function's
 * output depend on a heuristic nobody asked for.
 *
 * The available budget is `maxEstimatedTokens - reserveTokens`, **clamped at
 * zero**. Over-reserving is an arithmetic outcome rather than an unreadable
 * value, so it yields an empty window rather than an error; the caller can
 * see it happened because `omittedCount` reports every message dropped.
 * Individually unreadable values - NaN, Infinity, negative, fractional - do
 * throw {@link RecentWindowConfigError}.
 *
 * Estimator costs are checked on every call and must be finite, integer and
 * zero or greater; anything else throws {@link RecentWindowEstimateError} and
 * **no partial selection is returned**, because a window built on a corrupt
 * budget is worse than no window. An exception thrown by the estimator itself
 * propagates unchanged.
 *
 * **A message larger than the remaining budget stops the search.** It is
 * neither truncated nor skipped, and no older, cheaper message is picked up
 * behind it. Skipping would turn the result from a recent window into a
 * content-blind sparse sample, which is a different thing wearing the same
 * name. An empty result is a legitimate outcome.
 */
export function selectRecentWindow(
  messages: readonly ChatMessage[],
  options: RecentWindowOptions,
): RecentWindowResult {
  const reserve = options.reserveTokens ?? 0;
  requireTokenCount("maxEstimatedTokens", options.maxEstimatedTokens);
  requireTokenCount("reserveTokens", reserve);

  const estimator: TokenEstimator = options.estimator ?? defaultTokenEstimator;
  const available = Math.max(0, options.maxEstimatedTokens - reserve);

  let selectedCount = 0;
  let estimatedTokens = 0;

  // Walk backwards from the newest message, taking a contiguous suffix.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) break;
    // An exception raised BY the estimator propagates unchanged: it is the
    // caller's own injected code failing, and wrapping it would bury their
    // stack trace under ours while adding nothing. An unusable RETURN VALUE
    // is different - that is this module's contract, so it is checked here.
    const cost = estimator(message.text);
    requireEstimatedCost(i, cost);
    if (estimatedTokens + cost > available) break;
    estimatedTokens += cost;
    selectedCount += 1;
  }

  return {
    // slice() gives a fresh array: the caller's input is never aliased, and
    // the message objects themselves are readonly by type.
    messages: messages.slice(messages.length - selectedCount),
    estimatedTokens,
    omittedCount: messages.length - selectedCount,
  };
}
