/**
 * Bridge from the Wave 7 provider contract down to the legacy ModelProvider
 * port the turn service consumes.
 *
 * The turn service and everything behind it - window selection, sanitisation,
 * failure wording, and the tests that bind them - keep working unchanged. The
 * bridge maps the richer failure taxonomy onto the legacy kinds, losing
 * precision the legacy contract cannot express and nothing else.
 */

import type {
  ModelErrorKind,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../ports/model-provider.js";
import type { DelosProvider, ProviderErrorCode } from "../ports/provider.js";

const CODE_TO_KIND: Record<ProviderErrorCode, ModelErrorKind> = {
  "profile-invalid": "configuration",
  "credential-missing": "configuration",
  "credential-unavailable": "configuration",
  "authentication-failed": "authentication",
  "permission-denied": "authentication",
  "model-not-found": "configuration",
  "rate-limited": "rate_limit",
  timeout: "timeout",
  cancelled: "cancelled",
  "connection-failed": "network",
  "protocol-error": "invalid_response",
  // A pinned profile refusing an unevidenced or different served model is a
  // deliberate policy outcome of the reply itself, not a config typo.
  "model-mismatch": "invalid_response",
  "malformed-response": "invalid_response",
  "provider-error": "provider_error",
};

export function asModelProvider(provider: DelosProvider): ModelProvider {
  return {
    name: `${provider.kind}:${provider.profileId}`,

    async generate(request: ModelRequest): Promise<ModelResult> {
      const turn = await provider.generate(request);
      if (turn.ok) {
        return {
          ok: true,
          text: turn.result.text,
          servedModel: turn.result.servedModel ?? null,
        };
      }
      return {
        ok: false,
        errorKind: CODE_TO_KIND[turn.error.code],
        // Already redacted by contract; the turn service replaces it with its
        // own stable wording before anything reaches a user.
        detail: turn.error.message,
      };
    },
  };
}
