/**
 * Proactive messaging (13.2) - the decision core. Pure functions, injected
 * clock and randomness, no timers of its own.
 *
 * Posture, all enforced here or at the daemon seam:
 *
 * - OFF by default; enabling is manual, disabling is immediate.
 * - All timing is visible and editable: every decision returns the REASON
 *   and, when deferred, the earliest next-eligible time. There is no hidden
 *   scheduler - the runtime exposes an explicit tick seam and the decision
 *   explains itself each tick.
 * - No psychological inference from silence: eligibility is arithmetic on
 *   timestamps. Reasons state elapsed-time facts, never readings of mood.
 * - A proactive turn never pre-empts a current user message.
 * - Repeated non-response backs off, and after the configured count the
 *   runtime PAUSES itself until the user manually resumes.
 * - The echo guard refuses a candidate that repeats recent proactive text.
 * - Proactive text is not user speech: the runtime stores it as an
 *   assistant message; nothing is ever attributed to the user.
 * - No private presets: every default below is generic and public.
 */

export interface ProactiveQuietHours {
  /** Local hours [start, end) in the configured time zone; may wrap midnight. */
  readonly startHour: number;
  readonly endHour: number;
  readonly timeZone: string;
}

export interface ProactivePolicies {
  /** Nudge after a short gap in an active conversation. */
  readonly followUpMinutes?: number;
  /** Reconnect after a day-scale gap. */
  readonly reconnectHours?: number;
  /** Reach out after a long silence. */
  readonly longGapDays?: number;
}

export interface ProactiveDelivery {
  readonly desktop: boolean;
  readonly telegram: boolean;
}

export interface ProactiveConfig {
  readonly enabled: boolean;
  /** The one conversation proactive messages land in. */
  readonly conversationId?: string;
  readonly quietHours?: ProactiveQuietHours;
  readonly policies: ProactivePolicies;
  /** Uniform jitter applied to each threshold, so timing is not robotic. */
  readonly jitterMinutes: number;
  /** Unanswered-backoff: wait grows by this factor per unanswered send. */
  readonly backoffFactor: number;
  /** After this many consecutive unanswered sends, pause until resumed. */
  readonly pauseAfterUnanswered: number;
  readonly delivery: ProactiveDelivery;
}

export const PROACTIVE_DEFAULTS: ProactiveConfig = {
  enabled: false,
  policies: { reconnectHours: 26 },
  jitterMinutes: 15,
  backoffFactor: 2,
  pauseAfterUnanswered: 3,
  delivery: { desktop: true, telegram: false },
};

export interface ProactiveState {
  readonly lastUserMessageAtIso?: string;
  readonly lastProactiveAtIso?: string;
  /** Consecutive proactive sends with no user reply in between. */
  readonly unansweredCount: number;
  readonly paused: boolean;
  /** Recent proactive texts, newest last - the echo guard's window. */
  readonly recentProactiveTexts: readonly string[];
}

export const PROACTIVE_STATE_EMPTY: ProactiveState = {
  unansweredCount: 0,
  paused: false,
  recentProactiveTexts: [],
};

export type ProactivePolicyName = "follow-up" | "reconnect" | "long-gap";

export interface ProactiveDecision {
  readonly send: boolean;
  /** An elapsed-time fact or a config fact. Never an inference. */
  readonly reason: string;
  readonly policy?: ProactivePolicyName;
  /** When deferred by time, the earliest eligible instant. */
  readonly notBeforeIso?: string;
}

function inQuietHours(quiet: ProactiveQuietHours, nowIso: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: quiet.timeZone,
    }).format(new Date(nowIso)),
  );
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps midnight
}

export interface ProactiveTickInput {
  readonly config: ProactiveConfig;
  readonly state: ProactiveState;
  readonly nowIso: string;
  /** True while a user message is being processed. Never pre-empt it. */
  readonly userTurnInFlight: boolean;
  /** Injected uniform [0,1) randomness for the jitter. */
  readonly random: () => number;
}

/** The whole eligibility judgement for one tick. */
export function decideProactive(input: ProactiveTickInput): ProactiveDecision {
  const { config, state, nowIso } = input;
  if (!config.enabled) {
    return { send: false, reason: "Proactive messaging is disabled (the default)." };
  }
  if (config.conversationId === undefined) {
    return { send: false, reason: "No target conversation is configured." };
  }
  if (state.paused) {
    return {
      send: false,
      reason: `Paused after ${state.unansweredCount} unanswered proactive messages. Resume manually to continue.`,
    };
  }
  if (input.userTurnInFlight) {
    return { send: false, reason: "A user turn is in flight; a proactive message never pre-empts it." };
  }
  if (config.quietHours !== undefined && inQuietHours(config.quietHours, nowIso)) {
    return {
      send: false,
      reason: `Inside quiet hours (${config.quietHours.startHour}:00-${config.quietHours.endHour}:00 ${config.quietHours.timeZone}).`,
    };
  }
  if (!config.delivery.desktop && !config.delivery.telegram) {
    return { send: false, reason: "Every delivery surface is switched off." };
  }

  const now = Date.parse(nowIso);
  const lastUser = state.lastUserMessageAtIso === undefined ? undefined : Date.parse(state.lastUserMessageAtIso);
  if (lastUser === undefined) {
    return { send: false, reason: "No user message has ever been seen; there is nothing to follow up on." };
  }
  const sinceUserMinutes = (now - lastUser) / 60_000;

  // Backoff: each unanswered proactive send multiplies the wait since the
  // LAST proactive message.
  if (state.lastProactiveAtIso !== undefined && state.unansweredCount > 0) {
    const base = smallestThresholdMinutes(config.policies);
    const wait = base * Math.pow(config.backoffFactor, state.unansweredCount);
    const since = (now - Date.parse(state.lastProactiveAtIso)) / 60_000;
    if (since < wait) {
      const notBefore = new Date(Date.parse(state.lastProactiveAtIso) + wait * 60_000).toISOString();
      return {
        send: false,
        reason:
          `Backing off: ${state.unansweredCount} unanswered proactive message(s); ` +
          `next attempt no sooner than ${Math.round(wait)} minutes after the last one.`,
        notBeforeIso: notBefore,
      };
    }
  }

  // Highest-gap policy first, each threshold jittered.
  const jitter = (input.random() * 2 - 1) * config.jitterMinutes;
  const candidates: { policy: ProactivePolicyName; thresholdMinutes: number }[] = [];
  if (config.policies.longGapDays !== undefined) {
    candidates.push({ policy: "long-gap", thresholdMinutes: config.policies.longGapDays * 1440 });
  }
  if (config.policies.reconnectHours !== undefined) {
    candidates.push({ policy: "reconnect", thresholdMinutes: config.policies.reconnectHours * 60 });
  }
  if (config.policies.followUpMinutes !== undefined) {
    candidates.push({ policy: "follow-up", thresholdMinutes: config.policies.followUpMinutes });
  }
  for (const candidate of candidates) {
    const effective = Math.max(1, candidate.thresholdMinutes + jitter);
    if (sinceUserMinutes >= effective) {
      // Retries after an unanswered send are governed ENTIRELY by the
      // backoff branch above: reaching this point means either no proactive
      // message is outstanding, or the backoff window has fully elapsed.
      return {
        send: true,
        policy: candidate.policy,
        reason:
          `${Math.round(sinceUserMinutes)} minutes have elapsed since the last user message, ` +
          `past the jittered ${candidate.policy} threshold of ${Math.round(effective)} minutes.`,
      };
    }
  }

  const nearest = candidates
    .map((c) => Math.max(1, c.thresholdMinutes + jitter) - sinceUserMinutes)
    .filter((m) => m > 0)
    .sort((a, b) => a - b)[0];
  return {
    send: false,
    reason: "No policy threshold has elapsed yet.",
    ...(nearest === undefined
      ? {}
      : { notBeforeIso: new Date(now + nearest * 60_000).toISOString() }),
  };
}

function smallestThresholdMinutes(policies: ProactivePolicies): number {
  const values = [
    policies.followUpMinutes,
    policies.reconnectHours === undefined ? undefined : policies.reconnectHours * 60,
    policies.longGapDays === undefined ? undefined : policies.longGapDays * 1440,
  ].filter((v): v is number => v !== undefined);
  return values.length === 0 ? 60 : Math.min(...values);
}

/** Echo guard: refuse a candidate that repeats recent proactive content. */
export function guardProactiveEcho(
  candidate: string,
  state: ProactiveState,
): { ok: boolean; reason: string } {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const words = (s: string) =>
    new Set(
      normalize(s)
        .replace(/[^a-z0-9 ]/g, "")
        .split(" ")
        .filter((w) => w.length > 2),
    );
  const candidateNorm = normalize(candidate);
  const candidateWords = words(candidate);
  for (const recent of state.recentProactiveTexts) {
    if (normalize(recent) === candidateNorm) {
      return { ok: false, reason: "The candidate repeats a recent proactive message verbatim." };
    }
    const recentWords = words(recent);
    if (candidateWords.size > 0 && recentWords.size > 0) {
      let shared = 0;
      for (const w of candidateWords) if (recentWords.has(w)) shared++;
      const overlap = shared / Math.min(candidateWords.size, recentWords.size);
      if (overlap >= 0.8) {
        return { ok: false, reason: "The candidate is a near-duplicate of a recent proactive message." };
      }
    }
  }
  return { ok: true, reason: "The candidate does not repeat recent proactive content." };
}

const ECHO_WINDOW = 5;

/** State after a proactive message was actually sent. */
export function recordProactiveSent(state: ProactiveState, text: string, nowIso: string, pauseAfter: number): ProactiveState {
  const unanswered = state.unansweredCount + 1;
  return {
    ...state,
    lastProactiveAtIso: nowIso,
    unansweredCount: unanswered,
    paused: unanswered >= pauseAfter,
    recentProactiveTexts: [...state.recentProactiveTexts, text].slice(-ECHO_WINDOW),
  };
}

/** State after the user spoke: the silence ended, backoff and pause reset. */
export function recordUserMessage(state: ProactiveState, nowIso: string): ProactiveState {
  return { ...state, lastUserMessageAtIso: nowIso, unansweredCount: 0, paused: false };
}

/** Manual resume clears the pause WITHOUT inventing a user message. */
export function resumeProactive(state: ProactiveState): ProactiveState {
  return { ...state, paused: false, unansweredCount: 0 };
}

/** Parse a persisted config document, refusing junk field by field. */
export function parseProactiveConfig(input: unknown): ProactiveConfig {
  if (typeof input !== "object" || input === null) return { ...PROACTIVE_DEFAULTS };
  const raw = input as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const policiesRaw = (raw["policies"] ?? {}) as Record<string, unknown>;
  const quietRaw = raw["quietHours"] as Record<string, unknown> | undefined;
  const deliveryRaw = (raw["delivery"] ?? {}) as Record<string, unknown>;
  const quietStart = num(quietRaw?.["startHour"]) ?? (quietRaw?.["startHour"] === 0 ? 0 : undefined);
  const quietEnd = num(quietRaw?.["endHour"]) ?? (quietRaw?.["endHour"] === 0 ? 0 : undefined);
  const quiet: ProactiveQuietHours | undefined =
    quietRaw !== undefined &&
    typeof quietRaw["timeZone"] === "string" &&
    quietStart !== undefined &&
    quietEnd !== undefined &&
    quietStart >= 0 && quietStart <= 23 && quietEnd >= 0 && quietEnd <= 23
      ? { startHour: quietStart, endHour: quietEnd, timeZone: quietRaw["timeZone"] }
      : undefined;
  return {
    enabled: raw["enabled"] === true,
    ...(typeof raw["conversationId"] === "string" ? { conversationId: raw["conversationId"] } : {}),
    ...(quiet === undefined ? {} : { quietHours: quiet }),
    policies: {
      ...(num(policiesRaw["followUpMinutes"]) === undefined
        ? {}
        : { followUpMinutes: num(policiesRaw["followUpMinutes"]) as number }),
      ...(num(policiesRaw["reconnectHours"]) === undefined
        ? {}
        : { reconnectHours: num(policiesRaw["reconnectHours"]) as number }),
      ...(num(policiesRaw["longGapDays"]) === undefined
        ? {}
        : { longGapDays: num(policiesRaw["longGapDays"]) as number }),
    },
    jitterMinutes: num(raw["jitterMinutes"]) ?? PROACTIVE_DEFAULTS.jitterMinutes,
    backoffFactor: num(raw["backoffFactor"]) ?? PROACTIVE_DEFAULTS.backoffFactor,
    pauseAfterUnanswered: num(raw["pauseAfterUnanswered"]) ?? PROACTIVE_DEFAULTS.pauseAfterUnanswered,
    delivery: {
      desktop: deliveryRaw["desktop"] !== false,
      telegram: deliveryRaw["telegram"] === true,
    },
  };
}
