/**
 * The thin turn workflow.
 *
 * One turn: choose how much history fits, add any bounded host context, put the
 * current message last, record a metadata-only context receipt when requested,
 * ask the provider, sanitise the reply, return a safe outcome. It still owns no
 * conversation or storage state.
 */

import type {
  ChatMessage,
  PromptBundle,
} from "../domain/types.js";
import type { TurnContextBlock } from "../domain/turn-context.js";
import type { ModelErrorKind, ModelProvider } from "../ports/model-provider.js";
import {
  buildTurnContextReceipt,
  type TurnContextReceipt,
} from "./context-receipt.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import {
  selectRecentWindow,
  type RecentWindowOptions,
} from "./recent-window.js";
import { sanitizeReplyText } from "./reply-sanitizer.js";
import {
  contextualizeCurrentMessage,
  estimateHostContextTokens,
  HOST_CONTEXT_SYSTEM_RULE,
} from "./turn-context.js";

export interface TurnServiceOptions {
  readonly provider: ModelProvider;
  readonly promptBundle: PromptBundle;
  readonly recentWindow: RecentWindowOptions;
}

export type ContextReceiptSink = (
  receipt: TurnContextReceipt,
) => Promise<void> | void;

export interface RunTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  /** History the caller wants considered. Never modified. */
  readonly history: readonly ChatMessage[];
  /** The current user message. Never dropped by the history budget. */
  readonly userText: string;
  /** Host-supplied data for this turn. Never promoted to system authority. */
  readonly context?: readonly TurnContextBlock[];
  readonly userMessageId?: string;
  readonly atIso?: string;
  readonly model?: string | null;
  /**
   * Optional metadata-only audit sink. It runs after the exact request context
   * is assembled and before the provider call. If it cannot record the receipt,
   * Delos fails closed and makes no model request rather than claiming an audit
   * trail that does not exist.
   */
  readonly contextReceiptSink?: ContextReceiptSink;
}

export interface TurnServiceSuccess {
  readonly ok: true;
  readonly replyText: string;
  readonly contextReceipt: TurnContextReceipt;
}

export interface TurnServiceFailure {
  readonly ok: false;
  /** Safe, user-facing description. Never raw provider/audit detail. */
  readonly failure: string;
}

export type TurnServiceOutcome = TurnServiceSuccess | TurnServiceFailure;

export interface TurnService {
  runTurn(input: RunTurnInput): Promise<TurnServiceOutcome>;
}

const FAILURE_TEXT: Readonly<Record<ModelErrorKind, string>> = {
  configuration:
    "The model provider is not configured correctly. Check the endpoint and model in your configuration file.",
  authentication:
    "The model provider rejected the credential. Check the environment variable named in your configuration file.",
  rate_limit:
    "The model provider applied a rate limit. Wait a moment and try again.",
  timeout: "The model provider did not answer before the deadline.",
  network:
    "The model provider could not be reached. Check the endpoint and your connection.",
  invalid_response:
    "The model provider returned a response this version does not support.",
  provider_error: "The model provider rejected the request.",
  cancelled: "The request was cancelled.",
};

const BLANK_INPUT_FAILURE = "Nothing was sent: the message was empty.";
const EMPTY_REPLY_FAILURE =
  "The model returned no usable text. Nothing was displayed.";
const UNEXPECTED_PROVIDER_FAILURE =
  "The model provider failed unexpectedly. Nothing was displayed.";
const MISSING_IDENTIFIER_FAILURE =
  "The turn could not be started: a required identifier was missing.";
const CONTEXT_RECEIPT_FAILURE =
  "The turn context could not be durably recorded. No model request was made.";

function failure(text: string): TurnServiceFailure {
  return { ok: false, failure: text };
}

/** Build a turn service bound to one provider, one identity and one budget. */
export function createTurnService(options: TurnServiceOptions): TurnService {
  const { provider, promptBundle, recentWindow } = options;
  const staticSystemPrompt = assembleSystemPrompt(promptBundle);

  return {
    async runTurn(input: RunTurnInput): Promise<TurnServiceOutcome> {
      if (
        input.conversationId.trim().length === 0 ||
        input.turnId.trim().length === 0
      ) {
        return failure(MISSING_IDENTIFIER_FAILURE);
      }

      if (input.userText.trim().length === 0) {
        return failure(BLANK_INPUT_FAILURE);
      }

      const context = input.context ?? [];
      const contextReserve = estimateHostContextTokens(context);
      const window = selectRecentWindow(input.history, {
        ...recentWindow,
        reserveTokens: (recentWindow.reserveTokens ?? 0) + contextReserve,
      });

      const plainCurrentMessage: ChatMessage = {
        role: "user",
        text: input.userText,
        ...(input.userMessageId === undefined
          ? {}
          : { messageId: input.userMessageId }),
        ...(input.atIso === undefined ? {} : { atIso: input.atIso }),
      };
      const currentMessage = contextualizeCurrentMessage(plainCurrentMessage, context);
      const systemPrompt =
        context.length === 0
          ? staticSystemPrompt
          : `${staticSystemPrompt}\n\n${HOST_CONTEXT_SYSTEM_RULE}`;
      const contextReceipt = buildTurnContextReceipt({
        conversationId: input.conversationId,
        turnId: input.turnId,
        promptBundle,
        historyInputCount: input.history.length,
        window,
        recentWindow,
        context,
        ...(input.userMessageId === undefined
          ? {}
          : { userMessageId: input.userMessageId }),
        ...(input.atIso === undefined ? {} : { atIso: input.atIso }),
      });

      if (input.contextReceiptSink !== undefined) {
        try {
          await input.contextReceiptSink(contextReceipt);
        } catch {
          return failure(CONTEXT_RECEIPT_FAILURE);
        }
      }

      let result;
      try {
        result = await provider.generate({
          conversationId: input.conversationId,
          turnId: input.turnId,
          systemPrompt,
          messages: [...window.messages, currentMessage],
          ...(input.model === undefined ? {} : { model: input.model }),
        });
      } catch {
        return failure(UNEXPECTED_PROVIDER_FAILURE);
      }

      if (!result.ok) {
        return failure(FAILURE_TEXT[result.errorKind]);
      }

      const sanitized = sanitizeReplyText(result.text);
      if (!sanitized.ok) {
        return failure(EMPTY_REPLY_FAILURE);
      }

      return { ok: true, replyText: sanitized.text, contextReceipt };
    },
  };
}
