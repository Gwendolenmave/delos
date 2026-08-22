/**
 * The turn coordinator: exactly-once model calls over at-least-once surfaces.
 *
 * Surfaces retry. Browsers resubmit, Telegram redelivers, users double-click.
 * The coordinator's contract is that none of that ever calls the model twice
 * for the same turn, and that a completed result is never regenerated because
 * delivery hiccupped:
 *
 *   - a duplicate (surface, conversationKey, turnKey) joins the in-flight
 *     turn or is answered from the stored result - the model is not called;
 *   - retry after model completion reuses the stored assistant message;
 *   - delivery failure moves the turn to failed-after-model, from which the
 *     ONLY legal edge is back to delivery-pending: regeneration is not
 *     reachable in the state machine, not merely avoided;
 *   - every state transition is persisted BEFORE the action it describes, so
 *     a crash leaves a turn whose state says exactly how far it got, and
 *     restart recovery can finish delivery without touching the model;
 *   - turns serialise per conversation; different conversations proceed
 *     concurrently.
 */

import type { ModelProvider, ModelRequest } from "../ports/model-provider.js";
import type { TranscriptStore } from "../ports/transcript-store.js";

export interface TurnSubmission {
  readonly surface: string;
  readonly externalConversationKey: string;
  readonly externalTurnKey: string;
  readonly conversationId: string;
  readonly userText: string;
  /**
   * Builds the provider request from stored history. The second argument is the
   * durable Delos external-turn id, available so composition can write
   * metadata-only pre-provider receipts without inventing a parallel turn id.
   */
  readonly buildRequest: (userText: string, durableTurnId: string) => Promise<ModelRequest>;
}

export type TurnOutcome =
  | { readonly kind: "completed"; readonly assistantText: string; readonly reused: boolean }
  | { readonly kind: "failed"; readonly stage: "before-model" | "after-model"; readonly reason: string }
  | { readonly kind: "duplicate-in-flight" };

export interface TurnCoordinator {
  submit(submission: TurnSubmission): Promise<TurnOutcome>;
  /**
   * Finish delivery-side work left over from a crash. Never calls the model.
   * A coordinator whose deliver callback only understands one surface MUST
   * pass that surface as the filter: turns from other surfaces are someone
   * else's to recover, and touching them here would misdeliver them.
   */
  recover(surfaceFilter?: string): Promise<readonly { turnId: string; action: "redelivered" | "abandoned" }[]>;
}

export interface DeliveredTurnNotice {
  readonly turnId: string;
  readonly conversationId: string;
  readonly surface: string;
  readonly externalConversationKey: string;
  readonly externalTurnKey: string;
  readonly assistantMessageId: string;
  readonly atIso: string;
}

export interface TurnCoordinatorOptions {
  readonly store: TranscriptStore;
  readonly provider: ModelProvider;
  /** Deliver the completed text to the surface. May fail; may be retried. */
  readonly deliver: (surface: string, conversationKey: string, text: string) => Promise<void>;
  readonly nowIso: () => string;
  /**
   * Best-effort post-delivery lifecycle notice for orthogonal durable lanes
   * such as memory decisions. Failure NEVER changes a delivered chat turn;
   * those lanes must keep their own pre-provider receipt/recovery mechanism.
   */
  readonly onDelivered?: (notice: DeliveredTurnNotice) => Promise<void> | void;
}

export function createTurnCoordinator(options: TurnCoordinatorOptions): TurnCoordinator {
  const { store, provider, deliver, nowIso } = options;

  /** Per-conversation promise chains: serialisation without global blocking. */
  const lanes = new Map<string, Promise<unknown>>();
  /** In-process joiners for concurrent duplicates of the same external key. */
  const inFlight = new Map<string, Promise<TurnOutcome>>();

  function laneFor(conversationId: string): Promise<unknown> {
    return lanes.get(conversationId) ?? Promise.resolve();
  }

  async function notifyDelivered(
    submission: Pick<
      TurnSubmission,
      "surface" | "externalConversationKey" | "externalTurnKey" | "conversationId"
    >,
    turnId: string,
    assistantMessageId: string,
  ): Promise<void> {
    if (options.onDelivered === undefined) return;
    try {
      await options.onDelivered({
        turnId,
        conversationId: submission.conversationId,
        surface: submission.surface,
        externalConversationKey: submission.externalConversationKey,
        externalTurnKey: submission.externalTurnKey,
        assistantMessageId,
        atIso: nowIso(),
      });
    } catch {
      // Delos already durably delivered this user-visible turn. Orthogonal
      // post-turn lanes recover from their own pointer-only receipts instead of
      // lying that the chat delivery failed.
    }
  }

  async function runTurn(submission: TurnSubmission, turnId: string): Promise<TurnOutcome> {
    await store.setExternalTurnState(turnId, "accepted", nowIso());

    // The user message is durable before the model is asked anything.
    await store.appendMessage(
      {
        conversationId: submission.conversationId,
        role: "user",
        text: submission.userText,
        state: "delivered",
        externalTurnId: turnId,
      },
      nowIso(),
    );

    await store.setExternalTurnState(turnId, "model-pending", nowIso());
    let request;
    let result;
    try {
      request = await submission.buildRequest(submission.userText, turnId);
      result = await provider.generate(request);
    } catch {
      await store.setExternalTurnState(turnId, "failed-before-model", nowIso());
      return { kind: "failed", stage: "before-model", reason: "The provider call failed unexpectedly." };
    }

    if (!result.ok) {
      // A failed provider request creates NO assistant message: the transcript
      // must never show a completed answer that did not happen.
      await store.setExternalTurnState(turnId, "failed-before-model", nowIso());
      return { kind: "failed", stage: "before-model", reason: result.detail };
    }

    const assistant = await store.appendMessage(
      {
        conversationId: submission.conversationId,
        role: "assistant",
        text: result.text,
        state: "model-completed",
        externalTurnId: turnId,
      },
      nowIso(),
    );
    await store.setExternalTurnState(turnId, "model-completed", nowIso(), assistant.id);
    await store.setExternalTurnState(turnId, "delivery-pending", nowIso());
    await store.setMessageState(assistant.id, "delivery-pending", nowIso());

    try {
      await deliver(submission.surface, submission.externalConversationKey, result.text);
    } catch {
      await store.setExternalTurnState(turnId, "failed-after-model", nowIso());
      await store.setMessageState(assistant.id, "failed-after-model", nowIso());
      return {
        kind: "failed",
        stage: "after-model",
        reason: "The reply was generated but could not be delivered. It is stored and delivery can be retried.",
      };
    }

    await store.setExternalTurnState(turnId, "delivered", nowIso());
    await store.setMessageState(assistant.id, "delivered", nowIso());
    await notifyDelivered(submission, turnId, assistant.id);
    return { kind: "completed", assistantText: result.text, reused: false };
  }

  return {
    async submit(submission: TurnSubmission): Promise<TurnOutcome> {
      const dedupKey = `${submission.surface}\u0000${submission.externalConversationKey}\u0000${submission.externalTurnKey}`;

      // In-process duplicate while the first is running: join it.
      const running = inFlight.get(dedupKey);
      if (running !== undefined) return running;

      const work = (async (): Promise<TurnOutcome> => {
        const { record, existed } = await store.beginExternalTurn(
          submission.surface,
          submission.externalConversationKey,
          submission.externalTurnKey,
          submission.conversationId,
          nowIso(),
        );

        if (existed) {
          // A durable duplicate: answer from what the turn already became.
          const turn = await store.getExternalTurn(record.id);
          if (turn.state === "delivered" || turn.state === "model-completed" || turn.state === "delivery-pending") {
            if (turn.assistantMessageId !== undefined) {
              const messages = await store.listMessages(turn.conversationId);
              const assistant = messages.find((m) => m.id === turn.assistantMessageId);
              if (assistant !== undefined) {
                return { kind: "completed", assistantText: assistant.text, reused: true };
              }
            }
          }
          if (turn.state === "failed-before-model") {
            return { kind: "failed", stage: "before-model", reason: "This turn previously failed before the model ran." };
          }
          if (turn.state === "failed-after-model") {
            return { kind: "failed", stage: "after-model", reason: "The reply exists; delivery previously failed and can be retried." };
          }
          return { kind: "duplicate-in-flight" };
        }

        // Serialise per conversation: chain onto the lane, but do not block
        // other conversations' lanes.
        const lane = laneFor(submission.conversationId).then(
          () => runTurn(submission, record.id),
          () => runTurn(submission, record.id),
        );
        lanes.set(submission.conversationId, lane.catch(() => undefined));
        return lane;
      })();

      inFlight.set(dedupKey, work);
      try {
        return await work;
      } finally {
        inFlight.delete(dedupKey);
      }
    },

    async recover(surfaceFilter?: string) {
      const actions: { turnId: string; action: "redelivered" | "abandoned" }[] = [];
      for (const turn of await store.listRecoverableTurns()) {
        if (surfaceFilter !== undefined && turn.surface !== surfaceFilter) continue;
        if (turn.state === "model-completed" || turn.state === "delivery-pending" || turn.state === "failed-after-model") {
          // The model already answered. Recovery ONLY retries delivery.
          if (turn.assistantMessageId === undefined) continue;
          const messages = await store.listMessages(turn.conversationId);
          const assistant = messages.find((m) => m.id === turn.assistantMessageId);
          if (assistant === undefined) continue;
          // Both the turn and its message re-enter delivery-pending first:
          // failed-after-model's only legal edge, and the only state from
          // which "delivered" is reachable.
          if (turn.state !== "delivery-pending") {
            await store.setExternalTurnState(turn.id, "delivery-pending", nowIso());
          }
          if (assistant.state === "model-completed" || assistant.state === "failed-after-model") {
            await store.setMessageState(assistant.id, "delivery-pending", nowIso());
          }
          try {
            await deliver(turn.surface, turn.externalConversationKey, assistant.text);
            await store.setExternalTurnState(turn.id, "delivered", nowIso());
            await store.setMessageState(assistant.id, "delivered", nowIso());
            await notifyDelivered(
              {
                surface: turn.surface,
                externalConversationKey: turn.externalConversationKey,
                externalTurnKey: turn.externalTurnKey,
                conversationId: turn.conversationId,
              },
              turn.id,
              assistant.id,
            );
            actions.push({ turnId: turn.id, action: "redelivered" });
          } catch {
            await store.setExternalTurnState(turn.id, "failed-after-model", nowIso());
            await store.setMessageState(assistant.id, "failed-after-model", nowIso());
            actions.push({ turnId: turn.id, action: "abandoned" });
          }
        } else {
          // received / accepted / model-pending at crash: the model may or may
          // not have run, and there is no stored result. The honest recovery
          // is failure, never a silent regeneration the user did not ask for.
          await store.setExternalTurnState(turn.id, "failed-before-model", nowIso());
          actions.push({ turnId: turn.id, action: "abandoned" });
        }
      }
      return actions;
    },
  };
}
