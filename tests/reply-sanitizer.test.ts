/**
 * reply-sanitizer - synthetic tests.
 *
 * Control characters are written as escapes rather than literals so this file
 * stays readable and cannot be silently corrupted by an editor.
 *
 * Several tests assert what the sanitizer must NOT do. Those matter more than
 * the removal tests: a sanitizer that quietly rewrites model output makes it
 * impossible to tell what the model actually said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeReplyText,
  type ReplySanitizationResult,
} from "../core/services/reply-sanitizer.js";

const ESC = "\x1B";
const BEL = "\x07";

function expectOk(result: ReplySanitizationResult): string {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result.ok ? result.text : "";
}

function expectFailure(result: ReplySanitizationResult, reason: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, reason);
}

// --- transparency ----------------------------------------------------------

test("ordinary prose passes through unchanged", () => {
  const text = "The quick brown fox jumps over the lazy dog.";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

test("non-Latin scripts pass through unchanged", () => {
  // Assembled from code points so this file holds no non-ASCII literal.
  const han = String.fromCodePoint(0x4f60, 0x597d, 0xff0c, 0x4e16, 0x754c);
  const mixed = `Greeting: ${han} / Privet / Shalom`;
  assert.equal(expectOk(sanitizeReplyText(mixed)), mixed);
});

test("markdown structure, links and lists survive", () => {
  const text = [
    "# Heading",
    "",
    "Some **bold** and _italic_ text with a [link](https://example.org/path?a=1).",
    "",
    "- first",
    "- second",
    "  - nested",
    "",
    "> a quotation",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n");
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

test("fenced code keeps its indentation and blank lines", () => {
  const text = [
    "Here is code:",
    "",
    "```python",
    "def f(x):",
    "\tif x:",
    "        return 1",
    "",
    "    return 0",
    "```",
    "",
    "Done.",
  ].join("\n");
  const out = expectOk(sanitizeReplyText(text));
  assert.equal(out, text);
  assert.ok(out.includes("\tif x:"), "tab indentation preserved");
  assert.ok(out.includes("        return 1"), "space indentation preserved");
});

test("emoji, combining marks and non-BMP characters are undamaged", () => {
  const emoji = String.fromCodePoint(0x1f600);
  const familyZwj = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const combining = "e" + String.fromCodePoint(0x0301);
  const nonBmp = String.fromCodePoint(0x2070e);
  const text = `${emoji} ${familyZwj} ${combining} ${nonBmp}`;
  const out = expectOk(sanitizeReplyText(text));
  assert.equal(out, text);
  assert.equal([...out].length, [...text].length, "code point count unchanged");
});

test("leading and trailing whitespace is preserved, not trimmed", () => {
  // Trimming would alter deliberate spacing and code layout, and there is no
  // general reason to do it.
  const text = "\n\n   indented start\nend   \n\n";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

// --- what it must NOT do ---------------------------------------------------

test("HTML and XML are not stripped", () => {
  const text = '<div class="x">kept</div> and <note id="1">also kept</note>';
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

test("a reasoning container is not removed by the core sanitizer", () => {
  // One vendor's output format is that adapter's problem to declare. Teaching
  // the core about it would make every future provider inherit a rule written
  // for a model they are not.
  const text = "<think>internal</think>\n\nThe answer is 42.";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

test("a role prefix is not removed by the core sanitizer", () => {
  const text = "Assistant: here is the answer.";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

test("prose is not rewritten: apologies, hedges and punctuation are left alone", () => {
  const text = "Sorry, I might be wrong, but perhaps it is 42";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

// --- control characters ----------------------------------------------------

test("NUL is removed", () => {
  const out = expectOk(sanitizeReplyText("before\x00after"));
  assert.equal(out, "beforeafter");
  assert.ok(!out.includes("\x00"));
});

test("ANSI colour sequences are removed, leaving the text", () => {
  const out = expectOk(sanitizeReplyText(`${ESC}[31mred${ESC}[0m and plain`));
  assert.equal(out, "red and plain");
});

test("cursor and screen-control sequences are removed", () => {
  const out = expectOk(sanitizeReplyText(`a${ESC}[2Jb${ESC}[1;5Hc`));
  assert.equal(out, "abc");
});

test("an OSC terminal-title sequence is removed whole", () => {
  const out = expectOk(sanitizeReplyText(`x${ESC}]0;pwned title${BEL}y`));
  assert.equal(out, "xy");
  assert.ok(!out.includes("pwned"), "the payload must go with the sequence");
});

test("an OSC hyperlink sequence terminated by ST is removed whole", () => {
  const st = `${ESC}\\`;
  const out = expectOk(
    sanitizeReplyText(`before${ESC}]8;;https://example.org${st}label${ESC}]8;;${st}after`),
  );
  assert.equal(out, "beforelabelafter");
});

test("an unterminated OSC sequence does not leak its payload", () => {
  const out = expectOk(sanitizeReplyText(`keep${ESC}]0;dangling payload`));
  assert.equal(out, "keep");
});

test("other dangerous C0 controls are removed", () => {
  const out = expectOk(
    sanitizeReplyText("a\x01b\x02c\x07d\x08e\x0Bf\x0Cg\x1Fh\x7Fi"),
  );
  assert.equal(out, "abcdefghi");
});

test("tab and newline remain valid text", () => {
  const text = "col1\tcol2\nline2\n\nline4";
  assert.equal(expectOk(sanitizeReplyText(text)), text);
});

// --- 8-bit C1 forms and the other control strings --------------------------

const CSI_8 = "\u009B";
const OSC_8 = "\u009D";
const DCS_8 = "\u0090";
const SOS_8 = "\u0098";
const PM_8 = "\u009E";
const APC_8 = "\u009F";
const ST_8 = "\u009C";

test("an 8-bit C1 colour sequence leaves no parameter text behind", () => {
  // The failure this guards against is a sanitizer that knows only ESC [ and
  // lets the C1 form through with "31m" and "0m" visible in the reply.
  const out = expectOk(sanitizeReplyText(`${CSI_8}31mred${CSI_8}0m and plain`));
  assert.equal(out, "red and plain");
  assert.ok(!out.includes("31m"));
  assert.ok(!out.includes("0m"));
});

test("an 8-bit OSC payload does not leak into the reply", () => {
  const out = expectOk(sanitizeReplyText(`x${OSC_8}0;pwned title${ST_8}y`));
  assert.equal(out, "xy");
  assert.ok(!out.includes("pwned"));
});

test("a DCS payload is removed whole", () => {
  const out = expectOk(
    sanitizeReplyText(`before${ESC}Pq#0;2;0;0;0payload${ESC}\\after`),
  );
  assert.equal(out, "beforeafter");
  assert.ok(!out.includes("payload"));
});

test("an 8-bit DCS payload is removed whole", () => {
  const out = expectOk(sanitizeReplyText(`a${DCS_8}device data${ST_8}b`));
  assert.equal(out, "ab");
  assert.ok(!out.includes("device data"));
});

test("SOS, PM and APC payloads are removed whole", () => {
  for (const [name, intro] of [
    ["SOS", `${ESC}X`],
    ["PM", `${ESC}^`],
    ["APC", `${ESC}_`],
    ["SOS 8-bit", SOS_8],
    ["PM 8-bit", PM_8],
    ["APC 8-bit", APC_8],
  ] as const) {
    const out = expectOk(sanitizeReplyText(`keep${intro}hidden ${name}${ST_8}tail`));
    assert.equal(out, "keeptail", `${name} payload survived`);
    assert.ok(!out.includes("hidden"), `${name} payload survived`);
  }
});

test("an unterminated control string does not deliver its payload", () => {
  for (const intro of [`${ESC}P`, `${ESC}_`, OSC_8, APC_8]) {
    const out = expectOk(sanitizeReplyText(`keep${intro}dangling payload`));
    assert.equal(out, "keep");
  }
});

test("a control string terminated by ST is removed with either ST encoding", () => {
  const sevenBit = expectOk(sanitizeReplyText(`a${ESC}]0;t${ESC}\\b`));
  const eightBit = expectOk(sanitizeReplyText(`a${ESC}]0;t${ST_8}b`));
  assert.equal(sevenBit, "ab");
  assert.equal(eightBit, "ab");
});

// --- line endings ----------------------------------------------------------

test("CRLF is normalised to LF", () => {
  assert.equal(expectOk(sanitizeReplyText("a\r\nb\r\nc")), "a\nb\nc");
});

test("a lone CR is normalised to LF", () => {
  assert.equal(expectOk(sanitizeReplyText("a\rb\rc")), "a\nb\nc");
});

test("LF is left as it is", () => {
  assert.equal(expectOk(sanitizeReplyText("a\nb\nc")), "a\nb\nc");
});

test("mixed line endings all become LF", () => {
  const out = expectOk(sanitizeReplyText("a\r\nb\rc\nd"));
  assert.equal(out, "a\nb\nc\nd");
  assert.ok(!out.includes("\r"), "no carriage return survives");
});

test("CRLF inside a fenced code block is normalised too", () => {
  // Documented consequence of the line-ending contract: identical text must
  // produce identical bytes on every platform, including inside code.
  const out = expectOk(sanitizeReplyText("```\r\nline\r\n```"));
  assert.equal(out, "```\nline\n```");
});

// --- emptiness -------------------------------------------------------------

test("an empty string is a typed failure", () => {
  expectFailure(sanitizeReplyText(""), "empty_input");
});

test("whitespace-only input is a typed failure", () => {
  expectFailure(sanitizeReplyText("   \n\t\n  "), "empty_after_sanitization");
});

test("input that is entirely control characters is a typed failure", () => {
  expectFailure(sanitizeReplyText("\x00\x01\x02\x1F\x7F"), "empty_after_sanitization");
});

test("input that is entirely escape sequences is a typed failure", () => {
  expectFailure(
    sanitizeReplyText(`${ESC}[31m${ESC}[0m${ESC}]0;title${BEL}`),
    "empty_after_sanitization",
  );
});

test("a failure result carries no model text", () => {
  // The original text must never travel in an error, where it could reach a log.
  const result = sanitizeReplyText("\x00\x01");
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result), ["ok", "reason"]);
});

// --- independence ----------------------------------------------------------

test("the sanitizer is pure: the same input always gives the same result", () => {
  const text = `mixed ${ESC}[31mcontent\r\nwith\x00noise`;
  assert.deepEqual(sanitizeReplyText(text), sanitizeReplyText(text));
});

test("the input string is not mutated in place", () => {
  const text = "a\r\nb";
  const copy = text;
  sanitizeReplyText(text);
  assert.equal(text, copy);
});
