/**
 * Retrieval/web-search egress policy (Addendum B, item B2) - mechanisms
 * only. No retrieval feature ships in v0.1; this module is the gate any
 * future one MUST pass, so the security posture exists before the feature
 * does rather than being retrofitted.
 *
 * Posture:
 *
 * - OFF by default. Off means off: every URL is refused with the reason.
 * - Explicit consent: enabling records WHEN the user consented; enabled
 *   without a consent record is a DEGRADED misconfiguration that still
 *   refuses, honestly, rather than quietly working.
 * - SSRF guards: https only, DNS names only (no IP literals), no userinfo,
 *   default port only, and no name that designates local/private space.
 *   Provider traffic to loopback model servers is NOT this module's
 *   territory - provider profiles have their own rules; this gate exists
 *   for retrieval of arbitrary web content, where "fetch my metadata
 *   service" is the classic attack.
 * - The decision object is safe to log and to show: reason strings carry
 *   the shape of the refusal, never a credential.
 *
 * This is a public reauthoring from the requirement, not a copy of any
 * private implementation.
 */

export interface EgressPolicyConfig {
  /** Master switch. Absent or false = disabled. */
  readonly enabled: boolean;
  /** When the user explicitly consented to outbound retrieval. */
  readonly consentGrantedAtIso?: string;
  /** Optional host allowlist (exact, lowercase). Empty = any public host. */
  readonly allowedHosts?: readonly string[];
}

export const EGRESS_DEFAULTS: EgressPolicyConfig = { enabled: false };

export type EgressStatus =
  | "disabled"
  | "enabled-without-consent"
  | "blocked-scheme"
  | "blocked-userinfo"
  | "blocked-ip-literal"
  | "blocked-private-name"
  | "blocked-port"
  | "blocked-host"
  | "invalid-url"
  | "allowed";

export interface EgressDecision {
  readonly allowed: boolean;
  readonly status: EgressStatus;
  /** Safe to show and to persist. Never carries credentials. */
  readonly reason: string;
}

const PRIVATE_NAME =
  /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i;

function isIpLiteral(host: string): boolean {
  if (/^\[/.test(host)) return true; // bracketed IPv6
  if (/^[0-9.]+$/.test(host)) return true; // dotted (or partial) IPv4
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(":")) return true;
  return false;
}

function refusal(status: EgressStatus, reason: string): EgressDecision {
  return { allowed: false, status, reason };
}

/** Judge one candidate retrieval URL under the configured policy. */
export function evaluateEgress(rawUrl: string, config: EgressPolicyConfig): EgressDecision {
  if (config.enabled !== true) {
    return refusal("disabled", "Outbound retrieval is disabled. It stays off until explicitly enabled.");
  }
  if (config.consentGrantedAtIso === undefined || config.consentGrantedAtIso.length === 0) {
    return refusal(
      "enabled-without-consent",
      "Retrieval is switched on but no consent is recorded. Refusing until consent is explicit.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refusal("invalid-url", "The candidate URL could not be parsed.");
  }

  if (url.protocol !== "https:") {
    return refusal("blocked-scheme", `Retrieval speaks https only; "${url.protocol}//" is refused.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return refusal("blocked-userinfo", "URLs carrying credentials in the authority are refused.");
  }
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) {
    return refusal(
      "blocked-ip-literal",
      "IP-literal hosts are refused: retrieval goes to public DNS names only.",
    );
  }
  if (PRIVATE_NAME.test(host) || !host.includes(".")) {
    return refusal(
      "blocked-private-name",
      "Names designating local or private space are refused.",
    );
  }
  if (url.port.length > 0 && url.port !== "443") {
    return refusal("blocked-port", "Retrieval uses the default https port only.");
  }
  const allowlist = config.allowedHosts ?? [];
  if (allowlist.length > 0 && !allowlist.includes(host)) {
    return refusal("blocked-host", "The host is not on the configured allowlist.");
  }
  return { allowed: true, status: "allowed", reason: "Permitted by the egress policy." };
}

export interface EgressReport {
  readonly enabled: boolean;
  readonly consentRecorded: boolean;
  readonly state: "disabled" | "active" | "degraded";
  readonly detail: string;
  readonly allowedHosts: readonly string[];
}

/** The honest status line surfaces show. */
export function describeEgress(config: EgressPolicyConfig): EgressReport {
  const consentRecorded =
    config.consentGrantedAtIso !== undefined && config.consentGrantedAtIso.length > 0;
  if (config.enabled !== true) {
    return {
      enabled: false,
      consentRecorded,
      state: "disabled",
      detail: "Outbound retrieval is off (the default). No web request leaves this machine for retrieval.",
      allowedHosts: config.allowedHosts ?? [],
    };
  }
  if (!consentRecorded) {
    return {
      enabled: true,
      consentRecorded: false,
      state: "degraded",
      detail:
        "Retrieval is enabled but no consent is recorded - every request is refused until consent is explicit. Disable it or re-enable it with consent.",
      allowedHosts: config.allowedHosts ?? [],
    };
  }
  return {
    enabled: true,
    consentRecorded: true,
    state: "active",
    detail: "Retrieval is enabled with recorded consent, under SSRF guards.",
    allowedHosts: config.allowedHosts ?? [],
  };
}

/** Parse a persisted egress configuration document, refusing junk. */
export function parseEgressConfig(input: unknown): EgressPolicyConfig {
  if (typeof input !== "object" || input === null) return { ...EGRESS_DEFAULTS };
  const raw = input as Record<string, unknown>;
  const enabled = raw["enabled"] === true;
  const consent = typeof raw["consentGrantedAtIso"] === "string" ? raw["consentGrantedAtIso"] : undefined;
  const hosts = Array.isArray(raw["allowedHosts"])
    ? raw["allowedHosts"]
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.toLowerCase())
    : undefined;
  return {
    enabled,
    ...(consent === undefined ? {} : { consentGrantedAtIso: consent }),
    ...(hosts === undefined ? {} : { allowedHosts: hosts }),
  };
}
