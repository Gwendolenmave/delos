/**
 * The Delos local web application.
 *
 * Framework-free on purpose: views are functions that build DOM with
 * document.createElement and textContent - never innerHTML with model or user
 * data, which is the whole XSS story. Every network call goes through the
 * typed client; this file contains no fetch of its own and no credential
 * anywhere: the session token lives in a meta tag on the page the daemon
 * itself served, and provider API keys never reach the browser at all.
 */

import { DelosClient, type ConversationDto, type MessageDto } from "../../api-client/client.js";

// --- bootstrap ---------------------------------------------------------------

const sessionToken =
  document.querySelector('meta[name="delos-session"]')?.getAttribute("content") ?? "";
const client = new DelosClient({ origin: window.location.origin, sessionToken });

const root = document.getElementById("root")!;

type View =
  | "chat"
  | "conversations"
  | "personas"
  | "situations"
  | "providers"
  | "backup"
  | "diagnostics"
  | "settings"
  | "onboarding";

let currentView: View = "onboarding";
let activeConversation: ConversationDto | null = null;
let unsubscribe: (() => void) | null = null;
let lastVariantMetadata: unknown = null;

// helpers ---------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{ className: string; text: string; title: string }> = {},
  children: (HTMLElement | Text)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const child of children) node.appendChild(child);
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function errorLine(message: string): HTMLElement {
  return el("p", { className: "error-line", text: message });
}

// --- shell -------------------------------------------------------------------

async function render(): Promise<void> {
  clear(root);
  const nav = el("nav");
  const title = el("h1");
  title.appendChild(el("span", { text: "Δ" }));
  title.appendChild(document.createTextNode("elos"));
  nav.appendChild(title);

  const views: [View, string][] = [
    ["chat", "Chat"],
    ["conversations", "Conversations"],
    ["personas", "Personas"],
    ["situations", "Current Situation"],
    ["providers", "Providers"],
    ["backup", "Backup"],
    ["diagnostics", "Diagnostics"],
    ["settings", "Settings"],
  ];
  for (const [view, label] of views) {
    const button = el("button", { text: label });
    if (view === currentView) button.className = "active";
    button.addEventListener("click", () => {
      currentView = view;
      void render();
    });
    nav.appendChild(button);
  }
  nav.appendChild(el("div", { className: "foot", text: "local · loopback only" }));

  const main = el("main");
  root.appendChild(nav);
  root.appendChild(main);

  try {
    switch (currentView) {
      case "onboarding": await renderOnboarding(main); break;
      case "chat": await renderChat(main); break;
      case "conversations": await renderConversations(main); break;
      case "personas": await renderPersonas(main); break;
      case "situations": await renderSituations(main); break;
      case "providers": await renderProviders(main); break;
      case "backup": await renderBackup(main); break;
      case "diagnostics": await renderDiagnostics(main); break;
      case "settings": await renderSettings(main); break;
    }
  } catch (error) {
    main.appendChild(errorLine(error instanceof Error ? error.message : "Something failed."));
  }
}

// --- onboarding --------------------------------------------------------------

async function renderOnboarding(main: HTMLElement): Promise<void> {
  const [providers, conversations] = await Promise.all([
    client.listProviders(),
    client.listConversations(),
  ]);
  if (providers.profiles.length > 0 && conversations.conversations.length > 0) {
    currentView = "chat";
    await renderChat(main);
    return;
  }

  main.appendChild(el("h2", { text: "Welcome to Delos" }));
  main.appendChild(
    el("p", {
      text:
        "A local, self-hosted assistant. Everything here runs on your machine; " +
        "you bring your own model provider. Three steps and you are talking.",
    }),
  );
  const steps = el("div", { className: "steps" });
  const labels = ["1 · Provider", "2 · Persona", "3 · Conversation"];
  const hasProvider = providers.profiles.length > 0;
  labels.forEach((label, index) => {
    const span = el("span", { text: label });
    if ((index === 0 && !hasProvider) || (index > 0 && hasProvider)) span.className = "here";
    steps.appendChild(span);
  });
  main.appendChild(steps);

  if (!hasProvider) {
    main.appendChild(
      el("p", {
        className: "muted",
        text:
          "No provider profile yet. Add one under Providers - a local " +
          "OpenAI-compatible server needs only a base URL and a model name.",
      }),
    );
    const go = el("button", { className: "primary", text: "Set up a provider" });
    go.addEventListener("click", () => {
      currentView = "providers";
      void render();
    });
    main.appendChild(go);
    return;
  }

  const go = el("button", { className: "primary", text: "Create your first conversation" });
  go.addEventListener("click", () => {
    currentView = "conversations";
    void render();
  });
  main.appendChild(go);
}

// --- chat --------------------------------------------------------------------

async function renderChat(main: HTMLElement): Promise<void> {
  if (activeConversation === null) {
    const { conversations } = await client.listConversations();
    activeConversation = conversations.find((c) => !c.archived) ?? null;
  }
  if (activeConversation === null) {
    main.appendChild(el("h2", { text: "Chat" }));
    main.appendChild(el("p", { className: "muted", text: "No conversation yet - create one first." }));
    const go = el("button", { className: "primary", text: "Go to Conversations" });
    go.addEventListener("click", () => {
      currentView = "conversations";
      void render();
    });
    main.appendChild(go);
    return;
  }

  const conversation = activeConversation;
  main.appendChild(el("h2", { text: conversation.title }));

  const indicator = el("div", { className: "indicator" });
  indicator.appendChild(el("span", { className: "badge", text: `persona ${conversation.personaId}` }));
  indicator.appendChild(el("span", { className: "badge", text: `provider ${conversation.providerProfileId}` }));
  for (const variant of conversation.manualEnabled) {
    indicator.appendChild(el("span", { className: "badge", text: `+${variant}` }));
  }
  for (const variant of conversation.manualDisabled) {
    indicator.appendChild(el("span", { className: "badge", text: `−${variant}` }));
  }
  main.appendChild(indicator);

  const log = el("div", { className: "chat-log" });
  main.appendChild(log);

  const renderMessages = (messages: readonly MessageDto[]): void => {
    clear(log);
    for (const message of messages) {
      const turn = el("div", { className: `turn ${message.role}` });
      turn.appendChild(el("div", { className: "who", text: message.role === "user" ? "you" : conversation.personaId }));
      turn.appendChild(el("div", { className: "text", text: message.text }));
      if (message.state !== "delivered") {
        turn.appendChild(el("div", { className: "state", text: `state: ${message.state}` }));
      }
      log.appendChild(turn);
    }
    log.scrollIntoView(false);
  };
  renderMessages((await client.listMessages(conversation.id)).messages);

  // live events
  if (unsubscribe !== null) unsubscribe();
  unsubscribe = await client.streamEvents(conversation.id, (event) => {
    if (event.event === "variants") lastVariantMetadata = (event.data as { detail?: unknown }).detail;
    if (event.event === "turn-completed" || event.event === "turn-failed") {
      void client.listMessages(conversation.id).then((m) => renderMessages(m.messages));
    }
  });

  const compose = el("div", { className: "compose" });
  const input = el("textarea");
  input.placeholder = "Say something…";
  const send = el("button", { className: "primary", text: "Send" });
  const status = el("p", { className: "muted" });

  // The idempotency key is minted when a send is ATTEMPTED and kept until it
  // succeeds, so a retry after failure or reload cannot duplicate the turn.
  let pendingKey: string | null = null;
  const doSend = async (): Promise<void> => {
    const text = input.value.trim();
    if (text.length === 0) return;
    send.disabled = true;
    status.textContent = "…";
    pendingKey = pendingKey ?? crypto.randomUUID();
    try {
      const { outcome } = await client.sendMessage(conversation.id, text, pendingKey);
      if (outcome.kind === "completed") {
        pendingKey = null;
        input.value = "";
        status.textContent = outcome.reused ? "recovered the stored reply" : "";
      } else {
        status.textContent = `failed: ${outcome.reason ?? "unknown"} - Send retries without duplicating.`;
      }
      renderMessages((await client.listMessages(conversation.id)).messages);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Send failed.";
    } finally {
      send.disabled = false;
    }
  };
  send.addEventListener("click", () => void doSend());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void doSend();
    }
  });

  compose.appendChild(input);
  compose.appendChild(send);
  main.appendChild(compose);
  main.appendChild(status);

  const inspect = el("details");
  inspect.appendChild(el("summary", { text: "Active variants (last turn)" }));
  const pre = el("pre", { className: "mono" });
  pre.textContent = lastVariantMetadata === null ? "No turn yet." : JSON.stringify(lastVariantMetadata, null, 2);
  inspect.appendChild(pre);
  main.appendChild(inspect);
}

// --- conversations -----------------------------------------------------------

async function renderConversations(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Conversations" }));
  const [{ conversations }, personas, providers] = await Promise.all([
    client.listConversations(),
    client.listPersonas(),
    client.listProviders(),
  ]);

  for (const conversation of conversations) {
    const card = el("div", { className: "card" });
    const row = el("div", { className: "row spread" });
    row.appendChild(el("span", { className: "title", text: conversation.title + (conversation.archived ? " (archived)" : "") }));
    const actions = el("div", { className: "row" });
    const open = el("button", { className: "quiet", text: "Open" });
    open.addEventListener("click", () => {
      activeConversation = conversation;
      currentView = "chat";
      void render();
    });
    const archive = el("button", { className: "quiet", text: conversation.archived ? "Unarchive" : "Archive" });
    archive.addEventListener("click", () => {
      void client.patchConversation(conversation.id, { archived: !conversation.archived }).then(() => render());
    });
    const remove = el("button", { className: "quiet", text: "Delete" });
    remove.addEventListener("click", () => {
      if (window.confirm("Delete this conversation and its messages?")) {
        void client.deleteConversation(conversation.id).then(() => render());
      }
    });
    const exportConversation = el("button", { className: "quiet", text: "Export" });
    exportConversation.addEventListener("click", () => {
      void client
        .exportConversation(conversation.id)
        .then((data) =>
          saveNamedFile(`conversation-${conversation.id}.json`, JSON.stringify(data, null, 2), "utf8"),
        );
    });
    actions.appendChild(open);
    actions.appendChild(archive);
    actions.appendChild(exportConversation);
    actions.appendChild(remove);
    row.appendChild(actions);
    card.appendChild(row);
    card.appendChild(
      el("div", {
        className: "muted",
        text: `${conversation.personaId} · ${conversation.providerProfileId}`,
      }),
    );
    main.appendChild(card);
  }

  main.appendChild(el("h3", { text: "New conversation" }));
  const form = el("div", { className: "card" });
  form.appendChild(el("label", { text: "Title" }));
  const title = el("input");
  title.type = "text";
  form.appendChild(title);

  form.appendChild(el("label", { text: "Persona" }));
  const personaSelect = el("select");
  for (const persona of personas.personas) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = `${persona.displayName}${persona.shipped ? " (shipped)" : ""}`;
    personaSelect.appendChild(option);
  }
  form.appendChild(personaSelect);

  form.appendChild(el("label", { text: "Provider" }));
  const providerSelect = el("select");
  for (const profile of providers.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.displayName} (${profile.kind})`;
    providerSelect.appendChild(option);
  }
  form.appendChild(providerSelect);

  const feedback = el("p", { className: "muted" });
  const create = el("button", { className: "primary", text: "Create" });
  create.addEventListener("click", () => {
    void (async () => {
      try {
        const created = await client.createConversation({
          title: title.value.trim() || "Untitled",
          personaId: personaSelect.value,
          providerProfileId: providerSelect.value,
        });
        activeConversation = created.conversation;
        currentView = "chat";
        await render();
      } catch (error) {
        feedback.textContent = error instanceof Error ? error.message : "Creation failed.";
      }
    })();
  });
  form.appendChild(el("div", {}, [create]));
  form.appendChild(feedback);
  main.appendChild(form);
}

// --- personas ----------------------------------------------------------------

async function renderPersonas(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Personas" }));
  const { personas } = await client.listPersonas();
  for (const persona of personas) {
    const card = el("div", { className: "card" });
    const row = el("div", { className: "row spread" });
    row.appendChild(el("span", { className: "title", text: `${persona.displayName}${persona.shipped ? " · shipped" : ""}` }));
    const actions = el("div", { className: "row" });
    const duplicate = el("button", { className: "quiet", text: "Duplicate" });
    duplicate.addEventListener("click", () => {
      const newId = window.prompt("Id for the copy (lowercase, hyphens):", `${persona.id}-copy`);
      if (newId) void client.duplicatePersona(persona.id, newId).then(() => render());
    });
    actions.appendChild(duplicate);
    const exportPack = el("button", { className: "quiet", text: "Export" });
    exportPack.addEventListener("click", () => {
      void client
        .exportPersonaZip(persona.id)
        .then((bytes) => saveNamedFile(`${persona.id}.zip`, bytesToBase64(bytes), "base64"));
    });
    actions.appendChild(exportPack);
    if (!persona.shipped) {
      const remove = el("button", { className: "quiet", text: "Delete" });
      remove.addEventListener("click", () => {
        if (window.confirm(`Delete persona ${persona.id}?`)) {
          void client.deletePersona(persona.id).then(() => render());
        }
      });
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    card.appendChild(row);
    if (persona.description) card.appendChild(el("p", { className: "muted", text: persona.description }));
    for (const variant of persona.variants) {
      card.appendChild(
        el("div", {
          className: "muted",
          text: `variant ${variant.id} · ${variant.policy}${variant.description ? ` — ${variant.description}` : ""}`,
        }),
      );
    }
    main.appendChild(card);
  }

  main.appendChild(el("h3", { text: "Create with the wizard" }));
  const form = el("div", { className: "card" });
  const fields: [string, HTMLInputElement | HTMLTextAreaElement][] = [];
  const add = (label: string, multiline = false): void => {
    form.appendChild(el("label", { text: label }));
    const input = multiline ? el("textarea") : el("input");
    if (input instanceof HTMLInputElement) input.type = "text";
    form.appendChild(input);
    fields.push([label, input]);
  };
  add("Id (lowercase, hyphens)");
  add("Who are you?", true);
  add("What are you to the person you talk with?", true);
  add("How do you speak?", true);
  const feedback = el("p", { className: "muted" });
  const create = el("button", { className: "primary", text: "Create persona" });
  create.addEventListener("click", () => {
    void (async () => {
      try {
        await client.createPersonaFromWizard({
          id: fields[0]![1].value.trim(),
          identity: fields[1]![1].value,
          relationship: fields[2]![1].value || undefined,
          style: fields[3]![1].value || undefined,
        } as never);
        await render();
      } catch (error) {
        feedback.textContent = error instanceof Error ? error.message : "Creation failed.";
      }
    })();
  });
  form.appendChild(el("div", {}, [create]));
  form.appendChild(feedback);
  main.appendChild(form);

  main.appendChild(el("h3", { text: "Import" }));
  const importCard = el("div", { className: "card" });
  importCard.appendChild(
    el("p", {
      className: "muted",
      text:
        "Paste a prompt to make a basic persona, or import a Delos pack ZIP. " +
        "ChatGPT exports, Claude exports and character cards are not auto-imported.",
    }),
  );
  importCard.appendChild(el("label", { text: "Paste a prompt" }));
  const pasteId = el("input");
  pasteId.type = "text";
  pasteId.placeholder = "id, e.g. pasted-one";
  const pasteText = el("textarea");
  const pasteButton = el("button", { className: "quiet", text: "Import pasted prompt" });
  const pasteFeedback = el("p", { className: "muted" });
  pasteButton.addEventListener("click", () => {
    void client
      .createPersonaFromPaste(pasteId.value.trim(), pasteText.value)
      .then(() => render())
      .catch((error: unknown) => {
        pasteFeedback.textContent = error instanceof Error ? error.message : "Import failed.";
      });
  });
  importCard.appendChild(pasteId);
  importCard.appendChild(pasteText);
  importCard.appendChild(el("div", {}, [pasteButton]));
  importCard.appendChild(pasteFeedback);

  // Desktop: a native file dialog imports a pack ZIP; the bridge carries the
  // bytes as base64, which is exactly what the daemon's import mode takes.
  const desktop = desktopBridge();
  if (desktop !== undefined) {
    const fileButton = el("button", { className: "quiet", text: "Import pack ZIP from file…" });
    fileButton.addEventListener("click", () => {
      void (async () => {
        const picked = await desktop.importFile();
        if (!picked.opened || picked.contentBase64 === undefined) return;
        try {
          await client.importPersonaZip(picked.contentBase64);
          await render();
        } catch (error) {
          pasteFeedback.textContent = error instanceof Error ? error.message : "Import failed.";
        }
      })();
    });
    importCard.appendChild(el("div", {}, [fileButton]));
  }
  main.appendChild(importCard);
}

// --- situations --------------------------------------------------------------

async function renderSituations(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Current Situation" }));
  main.appendChild(
    el("p", {
      className: "muted",
      text:
        "Things that are true for you right now, written by you, with an " +
        "expiry. Delos never adds to this by itself.",
    }),
  );
  const { active, all } = await client.listSituations();
  for (const situation of all) {
    const card = el("div", { className: "card" });
    const row = el("div", { className: "row spread" });
    row.appendChild(el("span", { className: "title", text: situation.text }));
    const actions = el("div", { className: "row" });
    if (active.some((a) => a.id === situation.id)) {
      const end = el("button", { className: "quiet", text: "End now" });
      end.addEventListener("click", () => void client.endSituation(situation.id).then(() => render()));
      actions.appendChild(end);
    }
    const remove = el("button", { className: "quiet", text: "Delete" });
    remove.addEventListener("click", () => void client.deleteSituation(situation.id).then(() => render()));
    actions.appendChild(remove);
    row.appendChild(actions);
    card.appendChild(row);
    card.appendChild(
      el("div", { className: "muted", text: `${situation.state} · expires ${situation.expiresAtIso}` }),
    );
    main.appendChild(card);
  }

  const form = el("div", { className: "card" });
  form.appendChild(el("label", { text: "What is going on?" }));
  const text = el("textarea");
  form.appendChild(text);
  form.appendChild(el("label", { text: "Expires (ISO instant, e.g. 2026-08-02T22:00:00Z)" }));
  const expires = el("input");
  expires.type = "text";
  form.appendChild(expires);
  const feedback = el("p", { className: "muted" });
  const create = el("button", { className: "primary", text: "Add" });
  create.addEventListener("click", () => {
    void client
      .createSituation(text.value, expires.value.trim())
      .then(() => render())
      .catch((error: unknown) => {
        feedback.textContent = error instanceof Error ? error.message : "Failed.";
      });
  });
  form.appendChild(el("div", {}, [create]));
  form.appendChild(feedback);
  main.appendChild(form);
}

// --- providers ---------------------------------------------------------------

async function renderProviders(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Providers" }));
  const { profiles } = await client.listProviders();
  for (const profile of profiles) {
    const card = el("div", { className: "card" });
    const row = el("div", { className: "row spread" });
    row.appendChild(el("span", { className: "title", text: `${profile.displayName} · ${profile.kind}` }));
    const actions = el("div", { className: "row" });
    const testButton = el("button", { className: "quiet", text: "Test" });
    const result = el("span", { className: "muted" });
    testButton.addEventListener("click", () => {
      result.textContent = "testing…";
      void client.testProvider(profile.id).then(
        (report) => {
          result.textContent = report.ok
            ? `ok · served ${report.servedModel ?? "(not evidenced)"} · ${report.latencyMs} ms`
            : `failed · ${report.error?.code ?? "unknown"}`;
          result.className = report.ok ? "ok-line" : "error-line";
        },
        (error: unknown) => {
          result.textContent = error instanceof Error ? error.message : "test failed";
          result.className = "error-line";
        },
      );
    });
    actions.appendChild(testButton);
    const remove = el("button", { className: "quiet", text: "Delete" });
    remove.addEventListener("click", () => {
      if (window.confirm(`Delete provider profile ${profile.id}?`)) {
        void client.deleteProvider(profile.id).then(() => render());
      }
    });
    actions.appendChild(remove);
    row.appendChild(actions);
    card.appendChild(row);
    card.appendChild(el("div", { className: "muted", text: `model ${profile.model}${profile.baseUrl ? ` · ${profile.baseUrl}` : ""}` }));
    card.appendChild(result);
    main.appendChild(card);
  }

  main.appendChild(el("h3", { text: "Add a provider" }));
  const form = el("div", { className: "card" });
  form.appendChild(
    el("p", {
      className: "muted",
      text:
        "Your API key never goes in this form or this browser. Credentialed " +
        "profiles reference an environment variable read by the daemon; see " +
        "docs/PROVIDER-PROFILES.md for the full format.",
    }),
  );
  form.appendChild(el("label", { text: "Id" }));
  const id = el("input"); id.type = "text";
  form.appendChild(id);
  form.appendChild(el("label", { text: "Kind" }));
  const kind = el("select");
  for (const value of ["openai-compatible", "anthropic-compatible", "openai", "anthropic"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    kind.appendChild(option);
  }
  form.appendChild(kind);
  form.appendChild(el("label", { text: "Model" }));
  const model = el("input"); model.type = "text";
  form.appendChild(model);
  form.appendChild(el("label", { text: "Base URL (compatible kinds; the API root, not an endpoint)" }));
  const baseUrl = el("input"); baseUrl.type = "text";
  baseUrl.placeholder = "http://127.0.0.1:11434/v1";
  form.appendChild(baseUrl);
  form.appendChild(el("label", { text: "Environment variable holding the key (empty = no auth)" }));
  const envVar = el("input"); envVar.type = "text";
  envVar.placeholder = "MY_PROVIDER_KEY";
  form.appendChild(envVar);

  const feedback = el("p", { className: "muted" });
  const create = el("button", { className: "primary", text: "Add profile" });
  create.addEventListener("click", () => {
    const officialKind = kind.value === "openai" || kind.value === "anthropic";
    const profile: Record<string, unknown> = {
      schemaVersion: 1,
      id: id.value.trim(),
      kind: kind.value,
      model: model.value.trim(),
      ...(officialKind || baseUrl.value.trim().length === 0 ? {} : { baseUrl: baseUrl.value.trim() }),
      ...(envVar.value.trim().length === 0
        ? officialKind
          ? {}
          : { auth: { transport: "none" } }
        : officialKind
          ? { auth: { transport: kind.value === "openai" ? "bearer" : "x-api-key", source: "environment", envVar: envVar.value.trim() } }
          : { auth: { transport: "bearer", source: "environment", envVar: envVar.value.trim() } }),
    };
    void client
      .createProvider(profile)
      .then(() => render())
      .catch((error: unknown) => {
        feedback.textContent = error instanceof Error ? error.message : "Failed.";
      });
  });
  form.appendChild(el("div", {}, [create]));
  form.appendChild(feedback);
  main.appendChild(form);
}

// --- backup / diagnostics / settings -----------------------------------------

async function renderBackup(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Backup" }));
  main.appendChild(
    el("p", {
      className: "muted",
      text: "A JSON snapshot of situations, provider profiles (non-secret) and conversations.",
    }),
  );
  const button = el("button", { className: "primary", text: "Export full backup (.zip)" });
  button.addEventListener("click", () => {
    void client
      .backupZip()
      .then((bytes) => saveNamedFile("delos-backup.zip", bytesToBase64(bytes), "base64"));
  });
  main.appendChild(el("div", { className: "row" }, [button]));

  // Restore: inspect first, show the preview, then apply on explicit
  // confirmation. The archive travels as base64; a native dialog opens it
  // inside the desktop app.
  const desktop = desktopBridge();
  const note = el("p", { className: "muted" });
  if (desktop !== undefined) {
    const restoreButton = el("button", { className: "quiet", text: "Restore from file…" });
    restoreButton.addEventListener("click", () => {
      void (async () => {
        const picked = await desktop.importFile();
        if (!picked.opened || picked.contentBase64 === undefined) return;
        try {
          const { preview } = await client.inspectRestore(picked.contentBase64);
          const counts = preview.counts;
          const summary =
            `conversations ${counts["conversations"] ?? 0}, messages ${counts["messages"] ?? 0}, ` +
            `situations ${counts["situations"] ?? 0}, provider profiles ${counts["providerProfiles"] ?? 0}, ` +
            `persona packs ${counts["personaPacks"] ?? 0}`;
          if (!window.confirm(`Restore this backup?\n\n${summary}\n\nThis REPLACES the current data.`)) {
            note.textContent = "Restore cancelled.";
            return;
          }
          const result = await client.applyRestore(picked.contentBase64, "replace");
          note.textContent =
            `Restored. ` +
            (result.providersNeedingCredentials.length === 0
              ? "Every provider credential reference resolves on this machine."
              : `Reconfigure credentials for: ${result.providersNeedingCredentials.join(", ")} - a backup never carries secret values.`);
        } catch (error) {
          note.textContent = error instanceof Error ? error.message : "Restore failed.";
        }
      })();
    });
    main.appendChild(el("div", { className: "row" }, [restoreButton]));
  } else {
    main.appendChild(
      el("p", { className: "muted", text: "Restoring from a file uses the desktop app's native dialog." }),
    );
  }
  main.appendChild(note);
}

async function renderDiagnostics(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Diagnostics" }));

  // Doctor: read-only operational truth, check by check.
  const doctor = await client.doctor();
  main.appendChild(el("h3", { text: `Doctor: ${doctor.overall}` }));
  for (const item of doctor.checks) {
    const row = el("div", { className: "card" });
    row.appendChild(
      el("p", {
        className: item.status === "PASS" ? "muted" : "error-line",
        text: `${item.status}  ${item.title} - ${item.detail}`,
      }),
    );
    main.appendChild(row);
  }
  const exportButton = el("button", { className: "quiet", text: "Export redacted report" });
  exportButton.addEventListener("click", () => {
    void client.doctorReport().then((text) => saveNamedFile("delos-doctor-report.json", text, "utf8"));
  });
  main.appendChild(el("div", { className: "row" }, [exportButton]));

  const pre = el("pre", { className: "mono" });
  pre.textContent = JSON.stringify(await client.diagnostics(), null, 2);
  main.appendChild(pre);
}

/** The desktop preload bridge, when this page runs inside the desktop app. */
interface DesktopBridge {
  version(): Promise<{ app: string; electron: string; platform: string }>;
  secretSet(secretId: string, value: string): Promise<{ ok: boolean; detail?: string }>;
  secretDelete(secretId: string): Promise<{ ok: boolean }>;
  secretStatus(): Promise<{ mode: string; configuredIds: readonly string[] }>;
  openDataDir(): Promise<{ ok: boolean }>;
  exportFile(
    suggestedName: string,
    content: string,
    encoding?: "utf8" | "base64",
  ): Promise<{ saved: boolean }>;
  importFile(): Promise<{ opened: boolean; name?: string; contentBase64?: string }>;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { delosDesktop?: DesktopBridge }).delosDesktop;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Save a named file: the native dialog inside the desktop app, a plain
 * browser download otherwise. Both paths carry bytes faithfully.
 */
async function saveNamedFile(name: string, content: string, encoding: "utf8" | "base64"): Promise<void> {
  const desktop = desktopBridge();
  if (desktop !== undefined) {
    await desktop.exportFile(name, content, encoding);
    return;
  }
  const bytes =
    encoding === "base64"
      ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(content);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function renderSettings(main: HTMLElement): Promise<void> {
  main.appendChild(el("h2", { text: "Settings" }));
  const health = await client.connect();
  const pre = el("pre", { className: "mono" });
  pre.textContent = JSON.stringify(health, null, 2);
  main.appendChild(pre);

  const desktop = desktopBridge();
  if (desktop !== undefined) {
    main.appendChild(el("h3", { text: "Desktop" }));
    const version = await desktop.version();
    const status = await desktop.secretStatus();
    main.appendChild(
      el("p", {
        className: "muted",
        text:
          `Delos ${version.app} on ${version.platform}. Secret storage: ` +
          (status.mode === "encrypted-persistent"
            ? "encrypted by the operating system, persists across restarts."
            : "SESSION ONLY - this system offers no OS encryption, so secrets vanish at quit."),
      }),
    );
    const list = el("p", {
      className: "muted",
      text: status.configuredIds.length === 0
        ? "No desktop secrets stored."
        : `Stored secret references: ${status.configuredIds.join(", ")}`,
    });
    main.appendChild(list);

    // Store a secret: the value goes renderer -> main -> OS encryption and
    // can never be read back through this page.
    const idInput = el("input");
    idInput.placeholder = "secret id, e.g. provider:openai";
    const valueInput = el("input");
    valueInput.placeholder = "secret value (write-only)";
    valueInput.type = "password";
    const save = el("button", { text: "Store secret" });
    const note = el("p", { className: "muted" });
    save.addEventListener("click", () => {
      void (async () => {
        const result = await desktop.secretSet(idInput.value.trim(), valueInput.value);
        note.textContent = result.ok ? (result.detail ?? "Stored.") : (result.detail ?? "Refused.");
        valueInput.value = ""; // the page never keeps the plaintext around
        const refreshed = await desktop.secretStatus();
        list.textContent = refreshed.configuredIds.length === 0
          ? "No desktop secrets stored."
          : `Stored secret references: ${refreshed.configuredIds.join(", ")}`;
      })();
    });
    const openDir = el("button", { text: "Open data directory" });
    openDir.addEventListener("click", () => {
      void desktop.openDataDir();
    });
    main.appendChild(el("div", { className: "row" }, [idInput, valueInput, save, openDir]));
    main.appendChild(note);
  }

  main.appendChild(
    el("p", {
      className: "muted",
      text:
        "Telegram can be configured through the API (disabled by default, " +
        "allowlist only). Delegated providers (Codex, Claude Code) report " +
        "their real detection state under Diagnostics.",
    }),
  );
}

// go --------------------------------------------------------------------------

void render();
