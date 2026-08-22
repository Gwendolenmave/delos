/**
 * Persona integrity and evaluation tools (13.4) - the pure core behind
 * `delos persona validate | snapshot | test`.
 *
 * Everything here is deterministic and offline: hashing is canonical,
 * leakage checks are set arithmetic over resolved output, and synthetic
 * evaluation runs through whatever DelosProvider the caller injects - the
 * CLI defaults to a built-in offline stub, so no automated path ever dials
 * a real provider. Evidence records are APPEND-ONLY and public-safe: ids,
 * hashes, booleans and model identities - never persona content, never
 * private evaluation data.
 */

import type { LoadedPersonaPack } from "./variant-resolver.js";
import { resolveVariants } from "./variant-resolver.js";
import type { DelosProvider } from "../ports/provider.js";

export type Sha256 = (text: string) => string;

/**
 * The deterministic pack hash: manifest identity plus every block, in
 * sorted path order, length-prefixed so no concatenation of different
 * splits can collide.
 */
export function hashPack(pack: LoadedPersonaPack, sha256: Sha256): string {
  const parts: string[] = [`id:${pack.manifest.id}`, `schema:${pack.manifest.schemaVersion}`];
  for (const path of [...pack.blocks.keys()].sort()) {
    const content = pack.blocks.get(path) ?? "";
    parts.push(`${path}:${content.length}:${sha256(content)}`);
  }
  return sha256(parts.join("\n"));
}

export interface PackSnapshot {
  readonly packId: string;
  readonly displayName: string;
  readonly packHash: string;
  readonly blocks: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly base: readonly string[];
  readonly variants: readonly {
    readonly id: string;
    readonly policy: string;
    readonly priority: number;
    readonly path: string;
  }[];
}

/** The resolved base/variant manifest, content-free and stable-ordered. */
export function snapshotPack(pack: LoadedPersonaPack, sha256: Sha256): PackSnapshot {
  return {
    packId: pack.manifest.id,
    displayName: pack.manifest.displayName,
    packHash: hashPack(pack, sha256),
    blocks: [...pack.blocks.keys()].sort().map((path) => ({
      path,
      sha256: sha256(pack.blocks.get(path) ?? ""),
      // TextEncoder, not Buffer: core stays free of Node-specific globals.
      bytes: new TextEncoder().encode(pack.blocks.get(path) ?? "").length,
    })),
    base: pack.manifest.base.map((b) => b.path),
    variants: pack.manifest.variants.map((v) => ({
      id: v.id,
      policy: v.policy,
      priority: v.priority,
      path: v.path,
    })),
  };
}

export interface LeakageReport {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly variantId: string;
    readonly leaked: boolean;
    readonly detail: string;
  }[];
}

/**
 * Leakage between variants: while a variant is NOT active, none of the
 * lines unique to its block may appear in resolved output. Two states are
 * probed per variant: the default state (nothing manually enabled - only
 * "always" variants legitimately speak), and the adversarial state (every
 * OTHER variant force-enabled, this one force-disabled - disable must win
 * over everything, including contextual rules).
 */
export function runLeakageChecks(pack: LoadedPersonaPack): LeakageReport {
  const variants = pack.manifest.variants;
  const checks: { variantId: string; leaked: boolean; detail: string }[] = [];

  const distinctiveLines = (variantId: string): Set<string> => {
    const variant = variants.find((v) => v.id === variantId);
    const own = new Set<string>();
    for (const line of (pack.blocks.get(variant?.path ?? "") ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 8) own.add(trimmed);
    }
    // Remove anything that also occurs in another block - shared lines
    // cannot evidence a leak.
    for (const [path, content] of pack.blocks) {
      if (path === variant?.path) continue;
      for (const line of content.split("\n")) own.delete(line.trim());
    }
    return own;
  };

  const resolvedText = (manualEnabled: string[], manualDisabled: string[]): string =>
    resolveVariants(pack, {
      surface: "persona-test",
      manualEnabled,
      manualDisabled,
      currentUserText: "a neutral integrity probe with no activating vocabulary",
    })
      .blocks.map((b) => b.content)
      .join("\n");

  for (const variant of variants) {
    const unique = distinctiveLines(variant.id);
    if (unique.size === 0) {
      checks.push({
        variantId: variant.id,
        leaked: false,
        detail: "No distinctive lines - nothing measurable can leak.",
      });
      continue;
    }
    const others = variants.map((v) => v.id).filter((id) => id !== variant.id);

    // Default state: only "always" variants may legitimately speak.
    const defaultLeak =
      variant.policy !== "always" &&
      [...unique].some((line) => resolvedText([], []).includes(line));
    // Adversarial state: disable must win over enables and contextual rules.
    const disabledText = resolvedText(others, [variant.id]);
    const disabledLeak = [...unique].some((line) => disabledText.includes(line));

    checks.push({
      variantId: variant.id,
      leaked: defaultLeak || disabledLeak,
      detail: disabledLeak
        ? "Content appears even with the variant explicitly disabled."
        : defaultLeak
          ? "Content appears in the default state although the variant needs opting in."
          : "No distinctive line appears while the variant is inactive.",
    });
  }
  return { ok: checks.every((c) => !c.leaked), checks };
}

export interface SyntheticCase {
  readonly name: string;
  readonly userText: string;
}

/** Generic, public-safe cases: structure is judged, content never is. */
export const DEFAULT_SYNTHETIC_CASES: readonly SyntheticCase[] = [
  { name: "greets", userText: "Hello - a synthetic evaluation turn." },
  { name: "answers-a-question", userText: "What can you help with? (synthetic)" },
];

export interface SyntheticCaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly requestedModel?: string;
  readonly servedModel?: string;
}

/** Run the synthetic cases through an injected provider. Structural only. */
export async function runSyntheticCases(
  pack: LoadedPersonaPack,
  provider: DelosProvider,
  cases: readonly SyntheticCase[],
): Promise<readonly SyntheticCaseResult[]> {
  const results: SyntheticCaseResult[] = [];
  for (const testCase of cases) {
    const resolution = resolveVariants(pack, {
      surface: "persona-test",
      manualEnabled: [],
      manualDisabled: [],
      currentUserText: testCase.userText,
    });
    const turn = await provider.generate({
      conversationId: `persona-test-${pack.manifest.id}`,
      turnId: `case-${testCase.name}`,
      systemPrompt: resolution.blocks.map((b) => b.content).join("\n\n"),
      messages: [{ role: "user", text: testCase.userText }],
    });
    if (!turn.ok) {
      results.push({ name: testCase.name, ok: false, detail: `Provider failure: ${turn.error.code}` });
      continue;
    }
    results.push({
      name: testCase.name,
      ok: turn.result.text.trim().length > 0,
      detail: turn.result.text.trim().length > 0 ? "Non-empty reply." : "The reply was empty.",
      requestedModel: turn.result.requestedModel,
      ...(turn.result.servedModel === undefined ? {} : { servedModel: turn.result.servedModel }),
    });
  }
  return results;
}

/** The built-in offline provider: deterministic, no network, honest identity. */
export function createSyntheticOfflineProvider(): DelosProvider {
  return {
    profileId: "synthetic-offline",
    kind: "synthetic-offline",
    protocol: "synthetic-offline",
    async generate(request) {
      return {
        ok: true,
        result: {
          text: `Synthetic offline reply to "${request.messages[request.messages.length - 1]?.text ?? ""}".`,
          requestedModel: "synthetic-offline",
          servedModel: "synthetic-offline",
          protocol: "synthetic-offline",
          capabilitiesObserved: {},
        },
      };
    },
  };
}
