/**
 * The typed Delos API client.
 *
 * One client for every surface that speaks to the daemon: the local web
 * application uses exactly this module, and a future PWA connects through
 * this same contract - typed DTOs, version negotiation, the session-auth
 * handshake, and event-stream support. Nothing else in the web UI constructs
 * an HTTP request.
 *
 * Isomorphic on purpose: browser and Node share global fetch, and the event
 * stream is parsed from the response body rather than relying on the
 * browser-only EventSource (which cannot send the session header).
 */

// --- DTOs -------------------------------------------------------------------

export interface HealthDto {
  readonly ok: boolean;
  readonly version: string;
  readonly apiVersion: number;
  readonly uptimeMs: number;
}

export interface ProviderProfileDto {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly enabled: boolean;
}

export interface ConnectionTestDto {
  readonly ok: boolean;
  readonly profileId: string;
  readonly requestedModel?: string;
  readonly servedModel?: string;
  readonly latencyMs: number;
  readonly protocol?: string;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: string };
}

export interface PersonaSummaryDto {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly shipped: boolean;
  readonly variants: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly policy: string;
    readonly description?: string;
  }[];
}

export interface PersonaDetailDto {
  readonly manifest: unknown;
  readonly shipped: boolean;
  readonly blocks: readonly { readonly path: string; readonly content: string }[];
}

export interface SituationDto {
  readonly id: string;
  readonly text: string;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  readonly state: string;
}

export interface ConversationDto {
  readonly id: string;
  readonly title: string;
  readonly personaId: string;
  readonly providerProfileId: string;
  readonly manualEnabled: readonly string[];
  readonly manualDisabled: readonly string[];
  readonly archived: boolean;
  readonly updatedAtIso: string;
}

export interface MessageDto {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ordinal: number;
  readonly state: string;
  readonly createdAtIso: string;
}

export interface TurnOutcomeDto {
  readonly kind: "completed" | "failed" | "duplicate-in-flight";
  readonly assistantText?: string;
  readonly reused?: boolean;
  readonly stage?: string;
  readonly reason?: string;
}

export interface HistoryQueryDto {
  readonly kind: "recent" | "range" | "segment" | "keyword" | "selected";
  readonly count?: number;
  readonly fromIso?: string;
  readonly toIso?: string;
  readonly id?: string;
  readonly around?: number;
  readonly literal?: string;
  readonly ids?: readonly string[];
}

export interface ApiErrorDto {
  readonly error: { readonly code: string; readonly message: string };
}

export class DelosApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DelosApiError";
  }
}

/** The client refuses to talk across an API major version it does not know. */
export const SUPPORTED_API_VERSION = 1;

export interface DelosClientOptions {
  readonly origin: string;
  readonly sessionToken: string;
  readonly fetchImpl?: typeof fetch;
}

export interface StreamEvent {
  readonly event: string;
  readonly data: unknown;
}

export class DelosClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DelosClientOptions) {
    this.origin = options.origin;
    this.token = options.sessionToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.origin}/api/v1${path}`, {
      method,
      headers: {
        "x-delos-session": this.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = (parsed as ApiErrorDto | undefined)?.error;
      throw new DelosApiError(
        response.status,
        error?.code ?? "unknown",
        error?.message ?? "The daemon refused the request.",
      );
    }
    return parsed as T;
  }

  /**
   * The handshake: fetch health, verify the API major version, and return the
   * negotiated identity. Callers run this once before anything else.
   */
  async connect(): Promise<HealthDto> {
    const health = await this.request<HealthDto>("GET", "/health");
    if (health.apiVersion !== SUPPORTED_API_VERSION) {
      throw new DelosApiError(
        0,
        "version_mismatch",
        `This client speaks API v${SUPPORTED_API_VERSION}; the daemon speaks v${health.apiVersion}.`,
      );
    }
    return health;
  }

  // providers
  listProviders(): Promise<{ profiles: readonly ProviderProfileDto[] }> {
    return this.request("GET", "/providers");
  }
  createProvider(profile: unknown): Promise<{ profile: ProviderProfileDto }> {
    return this.request("POST", "/providers", profile);
  }
  updateProvider(id: string, profile: unknown): Promise<{ profile: ProviderProfileDto }> {
    return this.request("PUT", `/providers/${encodeURIComponent(id)}`, profile);
  }
  deleteProvider(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/providers/${encodeURIComponent(id)}`);
  }
  testProvider(id: string): Promise<ConnectionTestDto> {
    return this.request("POST", `/providers/${encodeURIComponent(id)}/test`);
  }

  // personas
  listPersonas(): Promise<{ personas: readonly PersonaSummaryDto[] }> {
    return this.request("GET", "/personas");
  }
  getPersona(id: string): Promise<PersonaDetailDto> {
    return this.request("GET", `/personas/${encodeURIComponent(id)}`);
  }
  createPersonaFromWizard(wizard: {
    id: string;
    displayName?: string;
    identity: string;
    relationship?: string;
    style?: string;
    language?: string;
  }): Promise<{ id: string }> {
    return this.request("POST", "/personas", { mode: "wizard", wizard });
  }
  createPersonaFromPaste(pastedId: string, pasted: string): Promise<{ id: string }> {
    return this.request("POST", "/personas", { mode: "paste", pastedId, pasted });
  }
  importPersonaZip(zipBase64: string): Promise<{ id: string }> {
    return this.request("POST", "/personas", { mode: "zip", zipBase64 });
  }
  duplicatePersona(id: string, newId: string): Promise<{ id: string }> {
    return this.request("POST", `/personas/${encodeURIComponent(id)}/duplicate`, { newId });
  }
  /** The pack ZIP as raw bytes - the daemon serves application/zip. */
  async exportPersonaZip(id: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(
      `${this.origin}/api/v1/personas/${encodeURIComponent(id)}/export`,
      { headers: { "x-delos-session": this.token } },
    );
    if (!response.ok) {
      throw new DelosApiError(response.status, "export_failed", "The persona export failed.");
    }
    return response.arrayBuffer();
  }
  deletePersona(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/personas/${encodeURIComponent(id)}`);
  }

  // situations
  listSituations(): Promise<{ active: readonly SituationDto[]; all: readonly SituationDto[] }> {
    return this.request("GET", "/situations");
  }
  createSituation(text: string, expiresAtIso: string): Promise<{ situation: SituationDto }> {
    return this.request("POST", "/situations", { text, expiresAtIso });
  }
  supersedeSituation(id: string, text: string, expiresAtIso: string): Promise<{ situation: SituationDto }> {
    return this.request("PUT", `/situations/${encodeURIComponent(id)}`, { text, expiresAtIso });
  }
  endSituation(id: string): Promise<{ ended: boolean }> {
    return this.request("POST", `/situations/${encodeURIComponent(id)}/end`);
  }
  deleteSituation(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/situations/${encodeURIComponent(id)}`);
  }

  // conversations and messages
  listConversations(): Promise<{ conversations: readonly ConversationDto[] }> {
    return this.request("GET", "/conversations");
  }
  createConversation(input: {
    title: string;
    personaId: string;
    providerProfileId: string;
  }): Promise<{ conversation: ConversationDto }> {
    return this.request("POST", "/conversations", input);
  }
  patchConversation(
    id: string,
    patch: { title?: string; archived?: boolean; manualEnabled?: string[]; manualDisabled?: string[] },
  ): Promise<{ conversation: ConversationDto }> {
    return this.request("PATCH", `/conversations/${encodeURIComponent(id)}`, patch);
  }
  deleteConversation(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/conversations/${encodeURIComponent(id)}`);
  }
  listMessages(id: string): Promise<{ messages: readonly MessageDto[] }> {
    return this.request("GET", `/conversations/${encodeURIComponent(id)}/messages`);
  }
  sendMessage(
    id: string,
    text: string,
    idempotencyKey: string,
  ): Promise<{ outcome: TurnOutcomeDto; containment?: readonly unknown[] }> {
    return this.request("POST", `/conversations/${encodeURIComponent(id)}/messages`, {
      text,
      idempotencyKey,
    });
  }
  queryHistory(
    id: string,
    query: HistoryQueryDto,
  ): Promise<{ records: readonly { id: string; role: string; text: string; atIso: string }[]; read: boolean }> {
    return this.request("POST", `/conversations/${encodeURIComponent(id)}/history-query`, { query });
  }

  // diagnostics etc.
  diagnostics(): Promise<Record<string, unknown>> {
    return this.request("GET", "/diagnostics");
  }
  /** The FULL versioned backup archive, as bytes. */
  async backupZip(): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(`${this.origin}/api/v1/backup`, {
      headers: { "x-delos-session": this.token },
    });
    if (!response.ok) {
      throw new DelosApiError(response.status, "backup_failed", "The backup could not be created.");
    }
    return response.arrayBuffer();
  }
  inspectRestore(zipBase64: string): Promise<{
    preview: {
      schemaVersion: number;
      appVersion: string;
      counts: Record<string, number>;
    };
  }> {
    return this.request("POST", "/restore", { zipBase64, mode: "inspect" });
  }
  applyRestore(
    zipBase64: string,
    policy: "replace" | "merge-skip",
  ): Promise<{
    applied: Record<string, number>;
    providersNeedingCredentials: readonly string[];
    verified: boolean;
  }> {
    return this.request("POST", "/restore", { zipBase64, mode: "apply", policy });
  }
  doctor(online = false): Promise<{
    generatedAtIso: string;
    overall: "PASS" | "DEGRADED" | "BLOCKED";
    checks: readonly { id: string; title: string; status: string; detail: string }[];
  }> {
    return this.request("GET", online ? "/doctor?online=1" : "/doctor");
  }
  /** The redacted, exportable doctor report as text. */
  async doctorReport(): Promise<string> {
    const response = await this.fetchImpl(`${this.origin}/api/v1/doctor/report`, {
      headers: { "x-delos-session": this.token },
    });
    if (!response.ok) {
      throw new DelosApiError(response.status, "doctor_failed", "The doctor report could not be produced.");
    }
    return response.text();
  }
  exportConversation(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/conversations/${encodeURIComponent(id)}/export`);
  }

  /**
   * Subscribe to a conversation's event stream. Parses SSE frames from the
   * body so the session header can travel (EventSource cannot send headers).
   * Returns an unsubscribe function.
   */
  async streamEvents(
    conversationId: string,
    onEvent: (event: StreamEvent) => void,
  ): Promise<() => void> {
    const response = await this.fetchImpl(
      `${this.origin}/api/v1/conversations/${encodeURIComponent(conversationId)}/events`,
      { headers: { "x-delos-session": this.token } },
    );
    if (!response.ok || response.body === null) {
      throw new DelosApiError(response.status, "stream_failed", "The event stream could not be opened.");
    }
    const reader = response.body.getReader();
    let cancelled = false;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (done || cancelled) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          let event = "message";
          let data: unknown;
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                data = line.slice(6);
              }
            }
          }
          if (data !== undefined) onEvent({ event, data });
        }
      }
    })();
    return () => {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    };
  }
}
