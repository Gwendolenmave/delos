/**
 * Provider-neutral host context supplied to one Delos turn.
 *
 * Context blocks are data, not dialogue and not system authority. The public
 * v0.2 host currently admits only retrieved long-term memory here; more kinds
 * need their own reviewed provenance and rendering rules rather than widening
 * this stringly.
 */
export type TurnContextKind = "retrieved-memory";

export interface TurnContextBlock {
  readonly kind: TurnContextKind;
  readonly text: string;
}
