/**
 * A fake `codex` CLI for contract tests. Implements the app-server stdio
 * subset the delegated adapter speaks: line-delimited JSON-RPC with
 * `initialize`, `newConversation`, `sendUserMessage`, and the notification
 * events that carry the reply.
 *
 * Behaviour variants via DELOS_FAKE_CODEX_MODE: ok (default), old-protocol,
 * bad-conversation, turn-error, hang, not-authed, no-auth-method.
 * No network, no file access.
 */

const argv = process.argv.slice(2);
const mode = process.env.DELOS_FAKE_CODEX_MODE ?? "ok";

if (argv.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9-fake\n");
  process.exit(0);
}

if (argv[0] !== "app-server") {
  process.stderr.write("fake-codex: only app-server mode is implemented\n");
  process.exit(2);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\n");
    if (line.length === 0) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      if (mode === "old-protocol") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
        return;
      }
      if (!params || !params.clientInfo || typeof params.clientInfo.name !== "string") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "clientInfo required" } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { userAgent: "codex-fake/9.9.9" } });
      return;
    case "getAuthStatus":
      if (mode === "no-auth-method") {
        // An older app-server without this method: the adapter must degrade,
        // not fail the turn.
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method getAuthStatus" } });
        return;
      }
      if (mode === "not-authed") {
        send({ jsonrpc: "2.0", id, result: { authenticated: false } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { authenticated: true, method: "chatgpt" } });
      return;
    case "newConversation":
      if (mode === "bad-conversation") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      // The adapter promised the tightest documented confinement: sandboxed,
      // auto-approval, and the optional tools explicitly excluded.
      if (
        params.approvalPolicy !== "never" ||
        params.sandbox !== "read-only" ||
        params.includePlanTool !== false ||
        params.includeApplyPatchTool !== false
      ) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unexpected sandbox request" } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: { conversationId: "conv-fake-1" } });
      return;
    case "sendUserMessage": {
      send({ jsonrpc: "2.0", id, result: {} });
      if (mode === "hang") return;
      if (mode === "turn-error") {
        notify("codex/event/error", { msg: { message: "boom" } });
        return;
      }
      const item = Array.isArray(params.items) ? params.items[0] : undefined;
      const text = item && item.data && typeof item.data.text === "string" ? item.data.text : "";
      notify("codex/event/agent_message", { msg: { message: `FAKE-CODEX:${text.length}` } });
      notify("codex/event/task_complete", { msg: {} });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}
