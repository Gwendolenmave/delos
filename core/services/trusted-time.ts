/**
 * Trusted time.
 *
 * One place answers "what time is it, where, and how should that be said" -
 * with an injectable clock so tests are deterministic, an IANA timezone that
 * defaults to the host's and may be overridden by the user, and locale-aware
 * rendering that fails towards a clear, unambiguous fallback rather than a
 * wrong-but-fluent guess.
 *
 * The daemon's clock is canonical. A model's claim about the current time is
 * prose, not evidence, and nothing here consumes one.
 */

export interface TrustedTimeOptions {
  /** Injected clock returning epoch milliseconds. */
  readonly now?: () => number;
  /** IANA timezone override, e.g. "Asia/Shanghai". Absent = host timezone. */
  readonly timeZone?: string;
  /** BCP-47 locale for rendering, e.g. "en-GB". Absent = host locale. */
  readonly locale?: string;
}

export interface TrustedNow {
  readonly epochMs: number;
  /** ISO-8601 instant in UTC, the canonical machine form. */
  readonly utcIso: string;
  /** The effective IANA timezone actually used. */
  readonly timeZone: string;
  /** Locale-aware absolute rendering, e.g. "Wednesday 1 July 2026, 14:30". */
  readonly display: string;
  /**
   * Deterministic fallback rendering, always produced, always unambiguous:
   * "2026-07-01 14:30 (+08:00)". `display` equals this when the requested
   * locale or timezone was unsupported.
   */
  readonly fallback: string;
  /** True when the requested locale/timezone could not be honoured. */
  readonly degraded: boolean;
}

export class TrustedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedTimeError";
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at `epochMs`, DST-correct, as "+08:00". */
export function utcOffsetAt(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // "GMT+08:00" -> "+08:00"; plain "GMT" -> "+00:00".
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m?.[1] ?? "+00:00";
}

/** Wall-clock fields of `epochMs` in `timeZone`, DST-correct. */
export function wallClockAt(
  epochMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

export interface TrustedClock {
  now(): TrustedNow;
  readonly timeZone: string;
}

export function createTrustedClock(options: TrustedTimeOptions = {}): TrustedClock {
  const nowFn = options.now ?? Date.now;

  // Resolve the timezone once, at construction. An invalid override is a
  // configuration mistake and degrades explicitly rather than silently using
  // the host zone as if nothing happened.
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let timeZone: string;
  let zoneDegraded = false;
  if (options.timeZone === undefined) {
    timeZone = hostZone;
  } else if (isValidTimeZone(options.timeZone)) {
    timeZone = options.timeZone;
  } else {
    timeZone = "UTC";
    zoneDegraded = true;
  }

  function render(epochMs: number): TrustedNow {
    const wall = wallClockAt(epochMs, timeZone);
    const offset = utcOffsetAt(epochMs, timeZone);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const fallback =
      `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ` +
      `${pad(wall.hour)}:${pad(wall.minute)} (${offset})`;

    let display = fallback;
    let localeDegraded = false;
    if (!zoneDegraded) {
      try {
        display = new Intl.DateTimeFormat(options.locale, {
          timeZone,
          dateStyle: "full",
          timeStyle: "short",
        }).format(new Date(epochMs));
      } catch {
        localeDegraded = true;
      }
    }

    return {
      epochMs,
      utcIso: new Date(epochMs).toISOString(),
      timeZone,
      display,
      fallback,
      degraded: zoneDegraded || localeDegraded,
    };
  }

  return {
    timeZone,
    now: () => render(nowFn()),
  };
}
