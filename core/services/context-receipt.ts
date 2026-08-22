import type { PromptBundle } from "../domain/types.js";
import type { TurnContextBlock } from "../domain/turn-context.js";
import type { RecentWindowOptions, RecentWindowResult } from "./recent-window.js";
import { estimateHostContextTokens } from "./turn-context.js";

/**
 * Metadata-only description of the exact context policy used for one model
 * request. It deliberately records identifiers, counts, prompt hashes and
 * budget decisions, never dialogue, prompt bodies or retrieved memory text.
 */
export interface TurnContextReceipt {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly turnId: string;
  readonly promptSections: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly history: {
    readonly inputCount: number;
    readonly selectedCount: number;
    readonly omittedCount: number;
    readonly estimatedTokens: number;
    readonly selectedMessageIds: readonly (string | null)[];
  };
  readonly hostContext: {
    readonly blockCount: number;
    readonly kinds: readonly TurnContextBlock["kind"][];
    readonly characterCounts: readonly number[];
    readonly estimatedTokens: number;
    readonly systemRuleApplied: boolean;
  };
  readonly budget: {
    readonly maxEstimatedTokens: number;
    readonly baseReserveTokens: number;
    readonly hostContextReserveTokens: number;
    readonly totalReserveTokens: number;
    readonly availableForHistoryTokens: number;
  };
  readonly currentUserMessage: {
    readonly messageId: string | null;
    readonly timestampPresent: boolean;
  };
}

export interface BuildTurnContextReceiptInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly promptBundle: PromptBundle;
  readonly historyInputCount: number;
  readonly window: RecentWindowResult;
  readonly recentWindow: RecentWindowOptions;
  readonly context: readonly TurnContextBlock[];
  readonly userMessageId?: string;
  readonly atIso?: string;
}

/**
 * Build the receipt from the same already-selected values that form the wire
 * request. No second selection or rendering pass is allowed to disagree with
 * what the provider actually receives.
 */
export function buildTurnContextReceipt(
  input: BuildTurnContextReceiptInput,
): TurnContextReceipt {
  const baseReserveTokens = input.recentWindow.reserveTokens ?? 0;
  const hostContextReserveTokens = estimateHostContextTokens(input.context);
  const totalReserveTokens = baseReserveTokens + hostContextReserveTokens;

  return {
    schemaVersion: 1,
    conversationId: input.conversationId,
    turnId: input.turnId,
    promptSections: input.promptBundle.sections.map((section) => ({
      name: section.name,
      sha256: section.sha256,
    })),
    history: {
      inputCount: input.historyInputCount,
      selectedCount: input.window.messages.length,
      omittedCount: input.window.omittedCount,
      estimatedTokens: input.window.estimatedTokens,
      selectedMessageIds: input.window.messages.map((message) => message.messageId ?? null),
    },
    hostContext: {
      blockCount: input.context.length,
      kinds: input.context.map((block) => block.kind),
      characterCounts: input.context.map((block) => [...block.text].length),
      estimatedTokens: hostContextReserveTokens,
      systemRuleApplied: input.context.length > 0,
    },
    budget: {
      maxEstimatedTokens: input.recentWindow.maxEstimatedTokens,
      baseReserveTokens,
      hostContextReserveTokens,
      totalReserveTokens,
      availableForHistoryTokens: Math.max(
        0,
        input.recentWindow.maxEstimatedTokens - totalReserveTokens,
      ),
    },
    currentUserMessage: {
      messageId: input.userMessageId ?? null,
      timestampPresent: input.atIso !== undefined,
    },
  };
}
