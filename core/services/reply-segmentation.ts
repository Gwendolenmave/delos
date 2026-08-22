/**
 * Reply segmentation - provider- and surface-independent.
 *
 * A surface with a hard message limit (Telegram: 4096) needs long replies
 * cut into deliverable segments. The rules, in priority order:
 *
 * 1. The canonical transcript is NEVER touched: one assistant message is
 *    stored; segmentation happens at the delivery boundary only.
 * 2. Code fences are preserved: a fenced block travels whole when it fits;
 *    a block larger than one segment is split BETWEEN ITS LINES, and every
 *    continuation segment re-opens the fence with the same info string so
 *    each delivered piece still renders as code.
 * 3. Prose splits at paragraph boundaries first, sentence boundaries next,
 *    and only then hard-cuts - never through a surrogate pair.
 * 4. Tiny fragments are merged forward: no surface should deliver a
 *    two-word message because a paragraph boundary happened to fall there.
 * 5. A maximum segment count caps runaway replies. Overflow is truncated
 *    VISIBLY - the final segment says so - because silently dropping tail
 *    content would misrepresent the stored reply, and silently exceeding
 *    the surface limit would fail delivery.
 */

export interface SegmentationOptions {
  /** Hard per-segment character (UTF-16 unit) limit of the surface. */
  readonly maxSegmentLength: number;
  /** Cap on delivered segments. Default 12. */
  readonly maxSegments?: number;
  /** Fragments shorter than this merge into the previous segment. */
  readonly mergeThreshold?: number;
}

export const TRUNCATION_NOTICE =
  "\n[reply truncated for this surface - the full text is stored in the conversation]";

const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/;

interface Block {
  readonly kind: "prose" | "fence";
  readonly text: string;
  /** For fences: the opening line (backticks + info string). */
  readonly open?: string;
  readonly close?: string;
}

/** Split source text into prose paragraphs and whole fenced blocks. */
function toBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];
  let fence: string[] | undefined;
  let fenceOpen = "";
  let fenceMarker = "";

  const flushProse = () => {
    const joined = prose.join("\n");
    for (const paragraph of joined.split(/\n{2,}/)) {
      if (paragraph.trim().length > 0) blocks.push({ kind: "prose", text: paragraph });
    }
    prose = [];
  };

  for (const line of lines) {
    const match = FENCE_LINE.exec(line);
    if (fence === undefined) {
      if (match !== null) {
        flushProse();
        fence = [];
        fenceOpen = line;
        fenceMarker = match[1] ?? "```";
      } else {
        prose.push(line);
      }
    } else {
      if (match !== null && (match[1] ?? "").startsWith(fenceMarker[0] ?? "`") && (match[2] ?? "").trim() === "") {
        blocks.push({ kind: "fence", text: fence.join("\n"), open: fenceOpen, close: match[1] as string });
        fence = undefined;
      } else {
        fence.push(line);
      }
    }
  }
  if (fence !== undefined) {
    // An unclosed fence: treat what we have as a fence block and close it.
    blocks.push({ kind: "fence", text: fence.join("\n"), open: fenceOpen, close: fenceMarker });
  }
  flushProse();
  return blocks;
}

/** Never cut between a high and low surrogate. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** Split one overlong prose paragraph: sentences first, hard cut last. */
function splitProse(paragraph: string, limit: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Latin and CJK sentence enders, followed by whitespace or end.
    let cut = -1;
    const enders = /[.!?。!?…][)"'」』]?(?=\s|$)/g;
    for (let m = enders.exec(window); m !== null; m = enders.exec(window)) {
      cut = m.index + m[0].length;
    }
    if (cut <= limit / 4) {
      const space = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      cut = space > limit / 4 ? space + 1 : safeCut(rest, limit);
    }
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Split one overlong fence body between lines; each piece re-fenced. */
function splitFence(block: Block, limit: number): string[] {
  const open = block.open ?? "```";
  const close = block.close ?? "```";
  const overhead = open.length + close.length + 2; // two joining newlines
  const room = Math.max(16, limit - overhead);
  const pieces: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of block.text.split("\n")) {
    // A single line longer than the room is hard-cut; code has no better
    // boundary, and the fence still renders.
    const chunks: string[] = [];
    let restLine = line;
    while (restLine.length > room) {
      const at = safeCut(restLine, room);
      chunks.push(restLine.slice(0, at));
      restLine = restLine.slice(at);
    }
    chunks.push(restLine);
    for (const chunk of chunks) {
      if (size + chunk.length + 1 > room && current.length > 0) {
        pieces.push(`${open}\n${current.join("\n")}\n${close}`);
        current = [];
        size = 0;
      }
      current.push(chunk);
      size += chunk.length + 1;
    }
  }
  if (current.length > 0) pieces.push(`${open}\n${current.join("\n")}\n${close}`);
  return pieces;
}

export function segmentReply(text: string, options: SegmentationOptions): readonly string[] {
  const limit = options.maxSegmentLength;
  const maxSegments = options.maxSegments ?? 12;
  const mergeThreshold = options.mergeThreshold ?? Math.floor(limit / 8);
  if (text.length <= limit) return [text];

  // Expand blocks into deliverable pieces, each within the limit.
  const pieces: string[] = [];
  for (const block of toBlocks(text)) {
    if (block.kind === "fence") {
      const whole = `${block.open}\n${block.text}\n${block.close}`;
      if (whole.length <= limit) pieces.push(whole);
      else pieces.push(...splitFence(block, limit));
    } else if (block.text.length <= limit) {
      pieces.push(block.text);
    } else {
      pieces.push(...splitProse(block.text, limit));
    }
  }

  // Greedy packing with tiny-fragment merging.
  const segments: string[] = [];
  for (const piece of pieces) {
    const previous = segments[segments.length - 1];
    if (
      previous !== undefined &&
      (piece.length <= mergeThreshold || previous.length <= mergeThreshold) &&
      previous.length + 2 + piece.length <= limit
    ) {
      segments[segments.length - 1] = `${previous}\n\n${piece}`;
      continue;
    }
    segments.push(piece);
  }

  // Cap the count, truncating VISIBLY inside the limit.
  if (segments.length > maxSegments) {
    const kept = segments.slice(0, maxSegments);
    const last = kept[maxSegments - 1] ?? "";
    const room = limit - TRUNCATION_NOTICE.length;
    const cutAt = last.length > room ? safeCut(last, room) : last.length;
    kept[maxSegments - 1] = last.slice(0, cutAt) + TRUNCATION_NOTICE;
    return kept;
  }
  return segments;
}
