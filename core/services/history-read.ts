/**
 * Deterministic history reads.
 *
 * When a turn needs the past, it asks for REAL RECORDS through one of five
 * literal query shapes - and the runtime records both that history was
 * requested and whether it was actually read. There are no embeddings, no
 * invented history, and no model-generated summaries here: a history read
 * returns transcript records verbatim or it returns nothing, honestly.
 *
 * The store behind the port is whatever the phase provides - in Phase 2 an
 * in-memory session transcript; Phase 3's SQLite store will implement the
 * same port without changing a caller.
 */

export interface HistoryRecord {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly atIso: string;
}

export type HistoryQuery =
  /** The most recent N records. */
  | { readonly kind: "recent"; readonly count: number }
  /** Records within [fromIso, toIso). */
  | { readonly kind: "range"; readonly fromIso: string; readonly toIso: string }
  /** The record with `id` plus `around` records either side. */
  | { readonly kind: "segment"; readonly id: string; readonly around: number }
  /** Records whose text contains the literal, case-insensitive; with context. */
  | { readonly kind: "keyword"; readonly literal: string; readonly around: number }
  /** Exactly the records the user selected in a UI. */
  | { readonly kind: "selected"; readonly ids: readonly string[] };

export interface HistoryReadResult {
  /** Real records, chronological. Never synthesised. */
  readonly records: readonly HistoryRecord[];
  /** The query that produced them, echoed for the report. */
  readonly query: HistoryQuery;
  /** True: the read actually ran against the store. */
  readonly read: true;
}

export interface HistoryReader {
  read(query: HistoryQuery): Promise<HistoryReadResult>;
}

const MAX_COUNT = 500;

export class HistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryQueryError";
  }
}

function bounded(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) {
    throw new HistoryQueryError(`${field} must be an integer between 0 and ${MAX_COUNT}`);
  }
  return n;
}

/** An in-memory reader over an already-chronological session transcript. */
export function createInMemoryHistoryReader(
  records: () => readonly HistoryRecord[],
): HistoryReader {
  return {
    async read(query: HistoryQuery): Promise<HistoryReadResult> {
      const all = records();
      let out: readonly HistoryRecord[];

      switch (query.kind) {
        case "recent": {
          bounded(query.count, "count");
          out = all.slice(-query.count);
          break;
        }
        case "range": {
          if (Number.isNaN(Date.parse(query.fromIso)) || Number.isNaN(Date.parse(query.toIso))) {
            throw new HistoryQueryError("range bounds must be ISO-8601 instants");
          }
          out = all.filter((r) => r.atIso >= query.fromIso && r.atIso < query.toIso);
          break;
        }
        case "segment": {
          bounded(query.around, "around");
          const index = all.findIndex((r) => r.id === query.id);
          out = index === -1
            ? []
            : all.slice(Math.max(0, index - query.around), index + query.around + 1);
          break;
        }
        case "keyword": {
          bounded(query.around, "around");
          if (query.literal.trim().length === 0) {
            throw new HistoryQueryError("keyword literal must not be empty");
          }
          const needle = query.literal.toLowerCase();
          const hits = new Set<number>();
          all.forEach((r, i) => {
            if (r.text.toLowerCase().includes(needle)) {
              for (
                let j = Math.max(0, i - query.around);
                j <= Math.min(all.length - 1, i + query.around);
                j++
              ) {
                hits.add(j);
              }
            }
          });
          out = [...hits].sort((a, b) => a - b).map((i) => all[i]!);
          break;
        }
        case "selected": {
          if (query.ids.length > MAX_COUNT) {
            throw new HistoryQueryError(`at most ${MAX_COUNT} selected records`);
          }
          const wanted = new Set(query.ids);
          // Filtered from the store, never trusted from the caller: an id
          // that does not exist yields nothing rather than an invented record.
          out = all.filter((r) => wanted.has(r.id));
          break;
        }
      }

      return { records: out, query, read: true };
    },
  };
}
