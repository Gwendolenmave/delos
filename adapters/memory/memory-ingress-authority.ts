export const MEMORY_INGRESS_LEGACY_GENERATION = "legacy-d0-v1" as const;
export const MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION = "retention-evidence-v1" as const;

export type MemoryIngressGeneration =
  | typeof MEMORY_INGRESS_LEGACY_GENERATION
  | typeof MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION;

export type MemoryIngressAuthorityMode = "legacy" | "portable-retention";

export interface GenericMemoryIngressAuthority {
  readonly mode: MemoryIngressAuthorityMode;
  readonly receiptGeneration: MemoryIngressGeneration;
  readonly autonomousActivationAllowed: boolean;
}

/**
 * Resolve only the generic completed-turn ingress boundary.
 *
 * The host's portable-retention lane is classified separately through the
 * public @delos/mnemosyne Retention API. Any non-legacy value therefore fails
 * closed here: generic D0 becomes evidence-only rather than an alternate
 * long-term admission authority.
 */
export function resolveGenericMemoryIngressAuthority(
  rawMode: string | undefined,
): GenericMemoryIngressAuthority {
  const mode = (rawMode ?? "legacy").trim().toLowerCase();
  if (mode === "" || mode === "legacy" || mode === "off") {
    return Object.freeze({
      mode: "legacy" as const,
      receiptGeneration: MEMORY_INGRESS_LEGACY_GENERATION,
      autonomousActivationAllowed: true,
    });
  }
  return Object.freeze({
    mode: "portable-retention" as const,
    receiptGeneration: MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
    autonomousActivationAllowed: false,
  });
}

/** Generic D0 may execute only historical legacy receipts in legacy mode. */
export function genericMemoryReceiptMayActivate(
  generation: MemoryIngressGeneration,
  authority: GenericMemoryIngressAuthority,
): boolean {
  return (
    authority.autonomousActivationAllowed &&
    generation === MEMORY_INGRESS_LEGACY_GENERATION
  );
}
