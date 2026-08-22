/**
 * Host-side long-term-memory read seam.
 *
 * Delos owns when a turn asks for remembered context and which explicit host
 * scene is active. A concrete memory package owns storage, eligibility,
 * ranking and rendering. A failed memory read degrades the turn to memoryless
 * chat; it never becomes permission to invent remembered facts.
 */
export type MemorySceneIntent =
  | { readonly mode: "ordinary"; readonly intimacyActive: boolean }
  | { readonly mode: "au"; readonly auId: string; readonly intimacyActive: boolean }
  | {
      /**
       * Host state was ambiguous (for example two mutually-exclusive AU
       * variants were enabled). Reads MUST degrade conservatively to ordinary
       * scope so an AU card can never leak across scenes. Decision/write paths
       * retain `unknown` and quarantine rather than silently reclassifying it.
       */
      readonly mode: "unknown";
      readonly intimacyActive: boolean;
    };

export type MemoryContextRetrieval =
  | {
      readonly status: "ok";
      readonly text: string;
      /** Exact Memory Card ids selected for this turn; metadata only. */
      readonly selectedIds: readonly string[];
      /** Exact House Prior versions used for this turn; metadata only. */
      readonly priorVersions: Readonly<Record<string, number>>;
    }
  | { readonly status: "degraded"; readonly detail: string };

export interface MemoryContextProvider {
  retrieve(
    query: string,
    nowIso: string,
    scene?: MemorySceneIntent,
  ): Promise<MemoryContextRetrieval>;
  close?(): Promise<void> | void;
}
