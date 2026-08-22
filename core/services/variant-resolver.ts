/**
 * Deterministic variant resolution.
 *
 * Given a loaded pack and the session's explicit state, decide exactly which
 * blocks speak this turn, in which order, and WHY - and expose that reasoning
 * as structured metadata a UI can show. Nothing here calls a model, scores
 * anything, or guesses: the same inputs produce the same resolution, every
 * time, and a user can predict it by reading their pack.
 *
 * Resolution order (documented contract):
 *
 *   1. ordered base blocks           - the persona's spine
 *   2. surface overlays              - the surface's standing adjustments
 *   3. contextually activated        - transparent literal rules, visible reason
 *   4. manually enabled              - the user said so this session
 *
 * Within (3) and (4), variants order by ascending priority, ties by manifest
 * declaration order. Later text speaks later and therefore reads as more
 * specific guidance to the model.
 *
 * MANUAL DISABLE ALWAYS WINS: a variant the user disabled is inert for every
 * policy, including "always". And a manual-policy variant - intimacy is the
 * canonical case - can NEVER be activated by a rule, a surface, or anything
 * other than the user's explicit enable for this session.
 */

import type {
  ContextualRule,
  PersonaManifest,
  PersonaVariant,
} from "../domain/persona-pack.js";

export interface LoadedPersonaPack {
  readonly manifest: PersonaManifest;
  /** Pack-relative path -> UTF-8 content. Every manifest path is present. */
  readonly blocks: ReadonlyMap<string, string>;
  readonly rules: readonly ContextualRule[];
}

export interface VariantSessionState {
  /** The requesting surface, e.g. "cli". */
  readonly surface: string;
  /** Variant ids the user explicitly enabled this session. */
  readonly manualEnabled: readonly string[];
  /** Variant ids the user explicitly disabled this session. Wins over all. */
  readonly manualDisabled: readonly string[];
  /** The current user message, for contextual literal rules only. */
  readonly currentUserText: string;
}

export type ActivationReason =
  | { readonly kind: "base" }
  | { readonly kind: "overlay"; readonly surface: string }
  | { readonly kind: "always" }
  | { readonly kind: "surface"; readonly surface: string }
  | { readonly kind: "contextual"; readonly matchedTerm: string }
  | { readonly kind: "manual" };

export interface ResolvedBlock {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly reason: ActivationReason;
  readonly priority: number;
}

export interface VariantResolution {
  readonly personaId: string;
  readonly blocks: readonly ResolvedBlock[];
  /** Structured per-turn metadata, safe to show and to log. */
  readonly metadata: {
    readonly activePersona: string;
    readonly surface: string;
    readonly baseBlocks: readonly string[];
    readonly overlays: readonly string[];
    readonly variants: readonly {
      readonly id: string;
      readonly reason: string;
      readonly priority: number;
    }[];
    /** Ids that were candidates but stayed inactive, with why. */
    readonly inactive: readonly { readonly id: string; readonly reason: string }[];
  };
}

function content(pack: LoadedPersonaPack, path: string): string {
  const text = pack.blocks.get(path);
  if (text === undefined) {
    // The loader guarantees presence; guard the seam with a plain error.
    throw new Error(`pack block missing: ${path}`);
  }
  return text;
}

function orderVariants(
  entries: readonly { variant: PersonaVariant; reason: ActivationReason }[],
  manifest: PersonaManifest,
): readonly { variant: PersonaVariant; reason: ActivationReason }[] {
  const declared = new Map(manifest.variants.map((v, i) => [v.id, i]));
  return [...entries].sort((a, b) => {
    if (a.variant.priority !== b.variant.priority) {
      return a.variant.priority - b.variant.priority;
    }
    return (declared.get(a.variant.id) ?? 0) - (declared.get(b.variant.id) ?? 0);
  });
}

export function resolveVariants(
  pack: LoadedPersonaPack,
  state: VariantSessionState,
): VariantResolution {
  const { manifest } = pack;
  const disabled = new Set(state.manualDisabled);
  const enabled = new Set(state.manualEnabled);
  const messageLower = state.currentUserText.toLowerCase();

  const blocks: ResolvedBlock[] = [];
  const inactive: { id: string; reason: string }[] = [];

  // 1. base
  for (const block of manifest.base) {
    blocks.push({
      name: block.name,
      path: block.path,
      content: content(pack, block.path),
      reason: { kind: "base" },
      priority: 0,
    });
  }

  // 2. surface overlay
  const overlayPaths: string[] = [];
  for (const overlay of manifest.overlays) {
    if (overlay.surface === state.surface) {
      overlayPaths.push(overlay.path);
      blocks.push({
        name: `overlay:${overlay.surface}`,
        path: overlay.path,
        content: content(pack, overlay.path),
        reason: { kind: "overlay", surface: overlay.surface },
        priority: 0,
      });
    }
  }

  // 3 + 4. variants
  const active: { variant: PersonaVariant; reason: ActivationReason }[] = [];
  for (const variant of manifest.variants) {
    if (disabled.has(variant.id)) {
      inactive.push({ id: variant.id, reason: "manually disabled" });
      continue;
    }

    if (enabled.has(variant.id)) {
      active.push({ variant, reason: { kind: "manual" } });
      continue;
    }

    switch (variant.policy) {
      case "always":
        active.push({ variant, reason: { kind: "always" } });
        break;
      case "surface":
        if (variant.surfaces?.includes(state.surface)) {
          active.push({ variant, reason: { kind: "surface", surface: state.surface } });
        } else {
          inactive.push({ id: variant.id, reason: `not active on surface ${state.surface}` });
        }
        break;
      case "contextual": {
        const rule = pack.rules.find((r) => r.variantId === variant.id);
        const matched = rule?.anyOf.find((term) => messageLower.includes(term));
        if (matched !== undefined) {
          active.push({ variant, reason: { kind: "contextual", matchedTerm: matched } });
        } else {
          inactive.push({
            id: variant.id,
            reason: rule === undefined ? "no contextual rule declared" : "no rule term matched",
          });
        }
        break;
      }
      case "manual":
        // The whole point: nothing but the user's own enable activates it.
        inactive.push({ id: variant.id, reason: "requires explicit per-session enable" });
        break;
    }
  }

  for (const { variant, reason } of orderVariants(active, manifest)) {
    blocks.push({
      name: `variant:${variant.id}`,
      path: variant.path,
      content: content(pack, variant.path),
      reason,
      priority: variant.priority,
    });
  }

  return {
    personaId: manifest.id,
    blocks,
    metadata: {
      activePersona: manifest.id,
      surface: state.surface,
      baseBlocks: manifest.base.map((b) => b.name),
      overlays: overlayPaths,
      variants: blocks
        .filter((b) => b.reason.kind !== "base" && b.reason.kind !== "overlay")
        .map((b) => ({
          id: b.name.replace(/^variant:/, ""),
          reason: describeReason(b.reason),
          priority: b.priority,
        })),
      inactive,
    },
  };
}

export function describeReason(reason: ActivationReason): string {
  switch (reason.kind) {
    case "base": return "base block";
    case "overlay": return `overlay for surface ${reason.surface}`;
    case "always": return "policy: always";
    case "surface": return `policy: surface (${reason.surface})`;
    case "contextual": return `policy: contextual (matched "${reason.matchedTerm}")`;
    case "manual": return "enabled by the user this session";
  }
}
