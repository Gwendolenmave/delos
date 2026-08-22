/**
 * Model-output containment.
 *
 * Between the provider adapter and everything downstream - persistence,
 * delivery, the next turn's context - sits this filter. Its job is to keep
 * material that was never meant for display from becoming part of the
 * conversation: reasoning wrappers, internal event JSON, echoed context,
 * fake role continuations, invented next-user messages, repeated system
 * framing.
 *
 * Two hard rules shape the implementation:
 *
 *   1. **Discarded content is never stored.** What survives is the record
 *      THAT something was removed - reason code, byte count, content hash,
 *      provider kind, timestamp - never the content itself. A containment
 *      log that quotes what it contained would defeat the point.
 *   2. **Legitimate text is sacred.** Markdown, code blocks, quoted role
 *      labels, and conversations ABOUT injection must survive untouched.
 *      Every rule below is anchored to structural positions (line starts,
 *      document boundaries) rather than substring paranoia.
 */

export const CONTAINMENT_REASONS = [
  /** <thinking>/<reasoning>-style wrappers not intended for display. */
  "reasoning_wrapper",
  /** A JSON object that is an internal event envelope, not prose. */
  "internal_event_json",
  /** The reply repeats the system/context framing it was given. */
  "context_echo",
  /** The reply continues the dialogue as another role ("User:", "System:"). */
  "fake_role_continuation",
  /** Trailing material after an adapter-identified final marker. */
  "post_final_material",
] as const;
export type ContainmentReason = (typeof CONTAINMENT_REASONS)[number];

/** What is recorded about removed material. Never the material. */
export interface ContainmentRecord {
  readonly reason: ContainmentReason;
  readonly bytes: number;
  /** sha256 of the removed content, for later forensics without storage. */
  readonly sha256: string;
  readonly providerKind: string;
  readonly atIso: string;
}

export interface ContainmentResult {
  /** The text that may be persisted and shown. */
  readonly text: string;
  /** Whether anything displayable survived at all. */
  readonly ok: boolean;
  readonly records: readonly ContainmentRecord[];
}

export interface ContainmentOptions {
  readonly providerKind: string;
  /** Injected clock, ISO-8601. */
  readonly nowIso: () => string;
  /**
   * Injected hash (hex sha256). Core stays free of node builtins; the
   * runtime supplies node:crypto, tests may supply anything stable.
   */
  readonly sha256: (text: string) => string;
  /**
   * The system prompt sent for this turn, for echo detection. Optional: echo
   * detection is skipped without it.
   */
  readonly systemPrompt?: string;
}

/**
 * Reasoning wrappers at the START of the reply (optionally preceded by
 * whitespace), as XML-ish blocks. Anchored: a conversation ABOUT
 * `<thinking>` tags mid-text is untouched.
 */
// `think` is the tag DeepSeek-R1 / QwQ-class models emit inline in
// OpenAI-compatible message.content - the flagship provider path - so it
// belongs here alongside the longer forms.
const REASONING_OPEN = /^\s*<(think|thinking|thought|reasoning|scratchpad|internal|antml:thinking)>/i;

function stripReasoningWrapper(text: string): { text: string; removed?: string } {
  const match = REASONING_OPEN.exec(text);
  if (match === null) return { text };
  const tag = match[1];
  const close = new RegExp(`</${tag}>`, "i");
  const closeMatch = close.exec(text);
  if (closeMatch === null) {
    // The whole reply is an unterminated wrapper: everything is internal.
    return { text: "", removed: text };
  }
  const end = closeMatch.index + closeMatch[0].length;
  const removed = text.slice(0, end);
  return { text: text.slice(end).replace(/^\s+/, ""), removed };
}

/**
 * Strip EVERY leading reasoning wrapper, not just the first: models emit
 * `<think>..</think><reasoning>..</reasoning>Answer`, and a single pass
 * would leave the second block in the delivered text.
 */
function stripAllReasoningWrappers(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let current = text;
  for (;;) {
    const step = stripReasoningWrapper(current);
    if (step.removed === undefined) break;
    removed.push(step.removed);
    current = step.text;
    if (current.length === 0) break;
  }
  return { text: current, removed };
}

/**
 * A reply that IS an internal event envelope: a single JSON object with
 * event-plumbing keys and no prose around it. A reply that merely contains a
 * JSON code block is untouched - the check runs only when the WHOLE trimmed
 * reply parses as JSON.
 */
// Unambiguous plumbing keys: a bare object carrying one of THESE is an
// internal envelope. Deliberately NOT "type" or "event" alone - those are
// ubiquitous in legitimate JSON a user might ask for (webhook samples,
// CloudEvents, analytics payloads), and emptying such a reply would be
// total data loss. A generic key now counts only alongside a plumbing key.
const PLUMBING_KEYS = ["tool_call", "tool_use", "function_call", "delta", "finish_reason"];
const GENERIC_ENVELOPE_KEYS = ["type", "event"];

function detectEventJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    // An unambiguous plumbing key is sufficient on its own.
    if (keys.some((k) => PLUMBING_KEYS.includes(k))) return true;
    // A generic envelope key counts ONLY together with a plumbing key -
    // never on its own, so a legitimate {"type":...,"event":...} payload the
    // user requested survives.
    return (
      keys.some((k) => GENERIC_ENVELOPE_KEYS.includes(k)) &&
      keys.some((k) => PLUMBING_KEYS.includes(k))
    );
  } catch {
    return false;
  }
}

/**
 * Fake role continuations: the model writing the NEXT user or system turn.
 * Anchored to a line start near the end of the reply, so quoting "User:" in
 * prose or code survives. Only unquoted, uncode-fenced occurrences count.
 */
const ROLE_LINE = /^(user|human|system)\s*:\s?/i;

function stripRoleContinuation(text: string): { text: string; removed?: string } {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (i === 0) continue; // a reply may legitimately begin by addressing a label
    if (ROLE_LINE.test(line) && !/^\s*>/.test(lines[i - 1] ?? "")) {
      const removed = lines.slice(i).join("\n");
      return { text: lines.slice(0, i).join("\n").replace(/\s+$/, ""), removed };
    }
  }
  return { text };
}

/** The reply parroting the system framing it was handed. */
function stripContextEcho(
  text: string,
  systemPrompt: string | undefined,
): { text: string; removed?: string } {
  if (systemPrompt === undefined || systemPrompt.length < 80) return { text };
  const head = systemPrompt.slice(0, 160);
  const idx = text.indexOf(head);
  if (idx === -1) return { text };
  // Remove the echoed prompt run: from the match to the end of the echoed
  // prompt's presence (best effort: the full prompt if present, else the head).
  const full = text.includes(systemPrompt) ? systemPrompt : head;
  const removed = text.slice(idx, idx + full.length);
  const cleaned = (text.slice(0, idx) + text.slice(idx + full.length)).trim();
  return { text: cleaned, removed };
}

export function containModelOutput(
  raw: string,
  options: ContainmentOptions,
): ContainmentResult {
  const records: ContainmentRecord[] = [];
  const record = (reason: ContainmentReason, removed: string): void => {
    records.push({
      reason,
      bytes: new TextEncoder().encode(removed).length,
      sha256: options.sha256(removed),
      providerKind: options.providerKind,
      atIso: options.nowIso(),
    });
  };

  let text = raw;

  const reasoning = stripAllReasoningWrappers(text);
  for (const removed of reasoning.removed) {
    record("reasoning_wrapper", removed);
  }
  text = reasoning.text;

  if (text.trim().length > 0 && detectEventJson(text)) {
    record("internal_event_json", text);
    text = "";
  }

  if (text.length > 0) {
    const echo = stripContextEcho(text, options.systemPrompt);
    if (echo.removed !== undefined) {
      record("context_echo", echo.removed);
      text = echo.text;
    }
  }

  if (text.length > 0) {
    const role = stripRoleContinuation(text);
    if (role.removed !== undefined) {
      record("fake_role_continuation", role.removed);
      text = role.text;
    }
  }

  const ok = text.trim().length > 0;
  return { text: ok ? text : "", ok, records };
}
