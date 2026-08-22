/**
 * Current Situation: what is true for the user RIGHT NOW, held apart from
 * both transcript and any future long-term memory.
 *
 * The defining properties:
 *
 *   - **User-authored, user-visible, user-ended.** A situation exists because
 *     the user created it, says what the user wrote, and dies when the user
 *     ends it or its expiry passes. Nothing is auto-extracted from chat, and
 *     a model's guess about the user's situation is never persisted as one -
 *     there is deliberately NO code path from model output into this store.
 *   - **Expiring by design.** Every situation carries an expiry. Context
 *     assembly receives only situations that are alive at the trusted clock's
 *     now; an expired situation stops influencing turns the moment it
 *     expires, without anyone having to remember to clean it up.
 *   - **Supersession keeps history honest.** Editing creates a new revision
 *     that names what it replaced; ended and superseded situations remain
 *     inspectable until deleted, so "what did Delos think was going on" is
 *     always answerable.
 */

export interface CurrentSituation {
  readonly id: string;
  readonly text: string;
  readonly createdAtIso: string;
  /** Situations always expire. */
  readonly expiresAtIso: string;
  readonly state: "active" | "ended" | "superseded" | "expired";
  /** Set when this revision replaced an earlier one. */
  readonly supersedesId?: string;
  readonly endedAtIso?: string;
}

export interface SituationStore {
  /** Situations alive at `nowIso`, newest first. What assembly consumes. */
  active(nowIso: string): Promise<readonly CurrentSituation[]>;
  /** Everything, including ended/superseded/expired, for inspection. */
  inspect(): Promise<readonly CurrentSituation[]>;
  create(text: string, nowIso: string, expiresAtIso: string): Promise<CurrentSituation>;
  /** Edit = supersede: the old revision remains, marked. */
  supersede(id: string, text: string, nowIso: string, expiresAtIso: string): Promise<CurrentSituation>;
  end(id: string, nowIso: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** A JSON-serialisable snapshot for backup. Contains only user-authored text. */
  exportAll(): Promise<string>;
  importAll(snapshot: string): Promise<number>;
}

export class SituationError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "expired_expiry",
    message: string,
  ) {
    super(message);
    this.name = "SituationError";
  }
}

const MAX_TEXT = 4000;

function validateText(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new SituationError("invalid", "A situation needs text.");
  }
  if (text.length > MAX_TEXT) {
    throw new SituationError("invalid", `A situation is at most ${MAX_TEXT} characters.`);
  }
  return text;
}

function validateExpiry(nowIso: string, expiresAtIso: string): void {
  if (Number.isNaN(Date.parse(expiresAtIso))) {
    throw new SituationError("invalid", "expiresAt must be an ISO-8601 instant.");
  }
  if (Date.parse(expiresAtIso) <= Date.parse(nowIso)) {
    throw new SituationError("expired_expiry", "expiresAt must be in the future.");
  }
}

/** Effective state at a moment: stored state plus the clock. */
export function effectiveState(
  situation: CurrentSituation,
  nowIso: string,
): CurrentSituation["state"] {
  if (situation.state !== "active") return situation.state;
  return Date.parse(situation.expiresAtIso) <= Date.parse(nowIso) ? "expired" : "active";
}

export function createInMemorySituationStore(
  newId: () => string,
): SituationStore {
  const items = new Map<string, CurrentSituation>();

  function mustGet(id: string): CurrentSituation {
    const found = items.get(id);
    if (found === undefined) throw new SituationError("not_found", `No situation ${id}.`);
    return found;
  }

  return {
    async active(nowIso: string): Promise<readonly CurrentSituation[]> {
      return [...items.values()]
        .filter((s) => effectiveState(s, nowIso) === "active")
        .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
    },

    async inspect(): Promise<readonly CurrentSituation[]> {
      return [...items.values()].sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
    },

    async create(text: string, nowIso: string, expiresAtIso: string): Promise<CurrentSituation> {
      validateText(text);
      validateExpiry(nowIso, expiresAtIso);
      const situation: CurrentSituation = {
        id: newId(),
        text,
        createdAtIso: nowIso,
        expiresAtIso,
        state: "active",
      };
      items.set(situation.id, situation);
      return situation;
    },

    async supersede(
      id: string,
      text: string,
      nowIso: string,
      expiresAtIso: string,
    ): Promise<CurrentSituation> {
      validateText(text);
      validateExpiry(nowIso, expiresAtIso);
      const old = mustGet(id);
      items.set(id, { ...old, state: "superseded" });
      const next: CurrentSituation = {
        id: newId(),
        text,
        createdAtIso: nowIso,
        expiresAtIso,
        state: "active",
        supersedesId: id,
      };
      items.set(next.id, next);
      return next;
    },

    async end(id: string, nowIso: string): Promise<void> {
      const old = mustGet(id);
      items.set(id, { ...old, state: "ended", endedAtIso: nowIso });
    },

    async delete(id: string): Promise<void> {
      mustGet(id);
      items.delete(id);
    },

    async exportAll(): Promise<string> {
      return JSON.stringify(
        { schemaVersion: 1, situations: [...items.values()] },
        null,
        2,
      );
    },

    async importAll(snapshot: string): Promise<number> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshot);
      } catch {
        throw new SituationError("invalid", "The backup is not valid JSON.");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
        !Array.isArray((parsed as { situations?: unknown }).situations)
      ) {
        throw new SituationError("invalid", "Not a situation backup this build understands.");
      }
      let count = 0;
      for (const raw of (parsed as { situations: unknown[] }).situations) {
        const s = raw as CurrentSituation;
        if (typeof s.id !== "string" || typeof s.text !== "string") continue;
        validateText(s.text);
        items.set(s.id, s);
        count++;
      }
      return count;
    },
  };
}
