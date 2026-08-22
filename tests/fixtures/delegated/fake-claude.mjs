/**
 * A fake `claude` CLI for contract tests. Speaks exactly the structured
 * non-interactive surface the delegated adapter invokes: `--version`, and
 * `--print --output-format json` with the prompt on stdin.
 *
 * Behaviour variants are selected through DELOS_FAKE_CLAUDE_MODE in the
 * inherited environment: ok (default), is-error, garbage, exit1, hang.
 * Nothing here talks to any network or reads any file.
 */

const argv = process.argv.slice(2);
const mode = process.env.DELOS_FAKE_CLAUDE_MODE ?? "ok";

if (argv.includes("--version")) {
  process.stdout.write("9.9.9-fake (Claude Code)\n");
  process.exit(0);
}

if (!argv.includes("--print")) {
  process.stderr.write("fake-claude: only --print mode is implemented\n");
  process.exit(2);
}

// Contract assertions: the adapter promised these arguments.
const requireArg = (flag, value) => {
  const at = argv.indexOf(flag);
  if (at < 0 || (value !== undefined && argv[at + 1] !== value)) {
    process.stderr.write(`fake-claude: expected ${flag} ${value ?? ""} in ${argv.join(" ")}\n`);
    process.exit(3);
  }
};
requireArg("--output-format", "json");
requireArg("--max-turns", "1");
requireArg("--system-prompt");
requireArg("--model");

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const system = argv[argv.indexOf("--system-prompt") + 1] ?? "";

  if (mode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("this is not the documented JSON result\n");
    process.exit(0);
  }
  if (mode === "exit1") {
    process.stderr.write("Invalid API key. Please run /login\n");
    process.exit(1);
  }
  if (mode === "is-error") {
    process.stdout.write(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }) + "\n",
    );
    process.exit(0);
  }

  const reply = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: `FAKE-CLAUDE:${prompt.split("\n")[0] ?? ""}:system=${system.length}`,
    modelUsage: { "fake-served-model": { inputTokens: 3 } },
    usage: { input_tokens: 3, output_tokens: 5 },
  };
  process.stdout.write(JSON.stringify(reply) + "\n");
  process.exit(0);
});
