/**
 * The containment seam, shared by EVERY composition (daemon and CLI/create-
 * runtime alike). Wrapping a ModelProvider here means containment runs
 * BEFORE the turn coordinator persists anything, so reasoning/thinking text
 * and internal envelopes never reach storage, the messages API, SSE,
 * export, backup, or a terminal - on any surface.
 *
 * A reply that is ENTIRELY internal (a bare reasoning wrapper, an event
 * envelope) contains down to empty. Storing that as a successful empty
 * assistant message would be dishonest - and on a delivery surface an empty
 * send fails and poisons the turn. So a non-empty reply that contains to
 * nothing becomes a typed FAILURE, and the coordinator's normal
 * failed-before-model path runs: no empty message is stored, and delivery
 * surfaces report an honest failure the user can retry.
 */

import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../ports/model-provider.js";
import { containModelOutput, type ContainmentRecord } from "./output-containment.js";
import { sanitizeReplyText } from "./reply-sanitizer.js";

export interface ContainmentSeamOptions {
  readonly providerKind: string;
  readonly nowIso: () => string;
  readonly sha256: (text: string) => string;
  /** Notified of the records from each turn, for surfacing/persistence. */
  readonly onRecords?: (records: readonly ContainmentRecord[]) => void;
}

export function wrapWithContainment(
  inner: ModelProvider,
  options: ContainmentSeamOptions,
): ModelProvider {
  return {
    name: inner.name,
    ...(inner.close === undefined ? {} : { close: inner.close.bind(inner) }),
    async generate(request: ModelRequest): Promise<ModelResult> {
      const result = await inner.generate(request);
      if (!result.ok) return result;

      // Sanitize first, then contain: a control-sequence prefix must not be
      // able to slip past the start-anchored containment rules.
      const preSanitized = sanitizeReplyText(result.text);
      const contained = containModelOutput(preSanitized.ok ? preSanitized.text : result.text, {
        providerKind: options.providerKind,
        nowIso: options.nowIso,
        sha256: options.sha256,
        systemPrompt: request.systemPrompt,
      });
      const postSanitized = sanitizeReplyText(contained.text);
      const finalText = postSanitized.ok ? postSanitized.text : "";
      options.onRecords?.(contained.records);

      const hadContent = result.text.trim().length > 0;
      if (hadContent && finalText.trim().length === 0) {
        // The reply was entirely internal. Fail honestly rather than store
        // or deliver an empty message.
        return {
          ok: false,
          errorKind: "invalid_response",
          detail: "The reply contained no deliverable content after containment.",
        };
      }
      return { ...result, text: finalText };
    },
  };
}
