/**
 * The portable persona-pack format.
 *
 * A persona is CONTENT: a manifest plus a directory of Markdown blocks. This
 * module owns the manifest schema and every validation rule about it. It
 * performs no I/O - a loader hands it an already-read manifest document and a
 * listing of the files the pack claims, and this module says whether the
 * claim is coherent.
 *
 * The rules are strict because packs are IMPORTED: a pack is the first thing
 * a user will ever bring in from outside, and every path here is untrusted
 * input until proven boring.
 */

export const SUPPORTED_PACK_SCHEMA_VERSION = 1 as const;

/** How a variant becomes active. */
export const ACTIVATION_POLICIES = ["always", "manual", "contextual", "surface"] as const;
export type ActivationPolicy = (typeof ACTIVATION_POLICIES)[number];

export interface PersonaBlockRef {
  /** Pack-relative POSIX path of a Markdown block, e.g. "base/identity.md". */
  readonly path: string;
  /** Logical name, derived from the filename when not given. */
  readonly name: string;
}

export interface PersonaVariant {
  readonly id: string;
  readonly path: string;
  readonly displayName: string;
  readonly policy: ActivationPolicy;
  /**
   * Resolution priority among variants; higher loads later (and therefore
   * speaks later in the assembled prompt). Deterministic tie-break is the
   * manifest's declaration order.
   */
  readonly priority: number;
  /** For "surface" policy: which surfaces activate it. */
  readonly surfaces?: readonly string[];
  readonly description?: string;
}

export interface SurfaceOverlay {
  readonly surface: string;
  readonly path: string;
}

export interface PersonaManifest {
  readonly schemaVersion: typeof SUPPORTED_PACK_SCHEMA_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  /** BCP-47-ish tag, validated loosely: this is metadata, not a lookup key. */
  readonly language?: string;
  /** Free-text attribution. Never an email address. */
  readonly author?: string;
  /** Ordered base blocks - the persona's spine, in speaking order. */
  readonly base: readonly PersonaBlockRef[];
  readonly variants: readonly PersonaVariant[];
  readonly overlays: readonly SurfaceOverlay[];
  /** Pack-relative path of an optional contextual-rules file. */
  readonly rulesPath?: string;
}

export type PackErrorCode =
  | "schema_unsupported"
  | "field_invalid"
  | "path_invalid"
  | "duplicate_id"
  | "secret_in_manifest";

export class PersonaPackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PersonaPackError";
  }
}

const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BLOCK_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Pack-relative paths: forward slashes, no traversal, no absolutes, no
 * drive letters, no hidden segments, Markdown or JSON only, bounded depth.
 *
 * The rule is allowlist-shaped on purpose. Rejecting known-bad substrings is
 * how imports get exploited; accepting only the boring shape is how they
 * do not.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validatePackPath(path: string, field: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) {
    throw new PersonaPackError("path_invalid", `${field}: not a usable path`, field);
  }
  if (path.includes("\\")) {
    throw new PersonaPackError(
      "path_invalid",
      `${field}: use forward slashes ("/") in pack paths`,
      field,
    );
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new PersonaPackError("path_invalid", `${field}: absolute paths are refused`, field);
  }
  const segments = path.split("/");
  if (segments.length > 6) {
    throw new PersonaPackError("path_invalid", `${field}: pack paths nest too deeply`, field);
  }
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.length === 0) {
      throw new PersonaPackError(
        "path_invalid",
        `${field}: "." and ".." segments are refused`,
        field,
      );
    }
    if (segment.startsWith(".")) {
      throw new PersonaPackError("path_invalid", `${field}: hidden segments are refused`, field);
    }
    if (!SAFE_SEGMENT.test(segment)) {
      throw new PersonaPackError(
        "path_invalid",
        `${field}: path segment ${JSON.stringify(segment)} is not allowed`,
        field,
      );
    }
  }
  const last = segments[segments.length - 1] ?? "";
  if (!/\.(md|json)$/i.test(last)) {
    throw new PersonaPackError(
      "path_invalid",
      `${field}: pack entries are Markdown or JSON only`,
      field,
    );
  }
  return path;
}

/** Manifest keys that would carry a credential. A pack has no business with one. */
const SECRET_KEYS = new Set([
  "apikey", "api_key", "key", "token", "secret", "password", "credential",
  "authorization", "auth",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectSecretKeys(value: unknown, path = ""): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ""))) {
      throw new PersonaPackError(
        "secret_in_manifest",
        `A persona manifest must not carry ${JSON.stringify(here)}. Packs ` +
          `are content; credentials belong to provider profiles.`,
        here,
      );
    }
    rejectSecretKeys(child, here);
  }
}

function fail(code: PackErrorCode, message: string, field?: string): never {
  throw new PersonaPackError(code, message, field);
}

function str(v: unknown, field: string, maxLength = 512): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    fail("field_invalid", `${field} must be a non-empty string`, field);
  }
  if (v.length > maxLength) fail("field_invalid", `${field} is too long`, field);
  // An email address in author/description metadata is a privacy leak the
  // scanner would catch later; refuse it at the door instead.
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(v)) {
    fail("field_invalid", `${field} must not contain an email address`, field);
  }
  return v;
}

function blockName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.(md|json)$/i, "");
}

/** Validate one manifest document against the files the pack actually holds. */
export function parsePersonaManifest(
  document: unknown,
  presentFiles: readonly string[],
): PersonaManifest {
  if (!isRecord(document)) fail("field_invalid", "persona.json must be a JSON object");

  if (document["schemaVersion"] !== SUPPORTED_PACK_SCHEMA_VERSION) {
    fail(
      "schema_unsupported",
      `Unsupported persona-pack schemaVersion ` +
        `${String(document["schemaVersion"])}. This build understands ` +
        `version ${SUPPORTED_PACK_SCHEMA_VERSION} only.`,
      "schemaVersion",
    );
  }

  rejectSecretKeys(document);

  const id = str(document["id"], "id", 64);
  if (!PERSONA_ID.test(id)) {
    fail("field_invalid", "id must be lowercase letters, digits and hyphens", "id");
  }

  const displayName = document["displayName"] === undefined ? id : str(document["displayName"], "displayName", 128);
  const description = document["description"] === undefined ? undefined : str(document["description"], "description", 2000);
  const author = document["author"] === undefined ? undefined : str(document["author"], "author", 256);

  let language: string | undefined;
  if (document["language"] !== undefined) {
    language = str(document["language"], "language", 32);
    if (!LANGUAGE_TAG.test(language)) {
      fail("field_invalid", "language must look like a BCP-47 tag, e.g. en or zh-Hant", "language");
    }
  }

  const present = new Set(presentFiles);
  function requirePresent(path: string, field: string): void {
    if (!present.has(path)) {
      fail("path_invalid", `${field} names ${path}, which is not in the pack`, field);
    }
  }

  // --- base blocks ---------------------------------------------------------
  const baseRaw = document["base"];
  if (!Array.isArray(baseRaw) || baseRaw.length === 0) {
    fail("field_invalid", "base must be a non-empty array of block paths", "base");
  }
  if (baseRaw.length > 32) fail("field_invalid", "base lists too many blocks", "base");
  const base: PersonaBlockRef[] = [];
  const seenBase = new Set<string>();
  for (const [index, entry] of baseRaw.entries()) {
    const field = `base[${index}]`;
    const path = validatePackPath(
      typeof entry === "string" ? entry : isRecord(entry) ? String(entry["path"]) : "",
      field,
    );
    if (!path.toLowerCase().endsWith(".md")) {
      fail("path_invalid", `${field}: base blocks are Markdown`, field);
    }
    requirePresent(path, field);
    if (seenBase.has(path)) fail("duplicate_id", `${field}: ${path} listed twice`, field);
    seenBase.add(path);
    base.push({ path, name: blockName(path) });
  }

  // --- variants ------------------------------------------------------------
  const variantsRaw = document["variants"] ?? [];
  if (!Array.isArray(variantsRaw) || variantsRaw.length > 32) {
    fail("field_invalid", "variants must be an array", "variants");
  }
  const variants: PersonaVariant[] = [];
  const seenVariant = new Set<string>();
  for (const [index, entry] of variantsRaw.entries()) {
    const field = `variants[${index}]`;
    if (!isRecord(entry)) fail("field_invalid", `${field} must be an object`, field);
    const vid = str(entry["id"], `${field}.id`, 64);
    if (!PERSONA_ID.test(vid)) {
      fail("field_invalid", `${field}.id must be lowercase letters, digits and hyphens`, `${field}.id`);
    }
    if (seenVariant.has(vid)) fail("duplicate_id", `duplicate variant id ${vid}`, `${field}.id`);
    seenVariant.add(vid);

    const path = validatePackPath(String(entry["path"] ?? ""), `${field}.path`);
    requirePresent(path, `${field}.path`);

    const policy = entry["policy"];
    if (!(ACTIVATION_POLICIES as readonly unknown[]).includes(policy)) {
      fail(
        "field_invalid",
        `${field}.policy must be one of: ${ACTIVATION_POLICIES.join(", ")}`,
        `${field}.policy`,
      );
    }

    const priority = entry["priority"] ?? 0;
    if (typeof priority !== "number" || !Number.isInteger(priority) || Math.abs(priority) > 1000) {
      fail("field_invalid", `${field}.priority must be an integer within +/-1000`, `${field}.priority`);
    }

    let surfaces: readonly string[] | undefined;
    if (policy === "surface") {
      const raw = entry["surfaces"];
      if (!Array.isArray(raw) || raw.length === 0) {
        fail("field_invalid", `${field}.surfaces is required for surface policy`, `${field}.surfaces`);
      }
      surfaces = raw.map((s, i) => {
        const v = str(s, `${field}.surfaces[${i}]`, 32).toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(v)) {
          fail("field_invalid", `${field}.surfaces[${i}] is not a surface name`, field);
        }
        return v;
      });
    } else if (entry["surfaces"] !== undefined) {
      fail("field_invalid", `${field}.surfaces applies only to surface policy`, `${field}.surfaces`);
    }

    variants.push({
      id: vid,
      path,
      displayName: entry["displayName"] === undefined ? vid : str(entry["displayName"], `${field}.displayName`, 128),
      policy: policy as ActivationPolicy,
      priority,
      ...(surfaces === undefined ? {} : { surfaces }),
      ...(entry["description"] === undefined
        ? {}
        : { description: str(entry["description"], `${field}.description`, 500) }),
    });
  }

  // --- overlays ------------------------------------------------------------
  const overlaysRaw = document["overlays"] ?? [];
  if (!Array.isArray(overlaysRaw) || overlaysRaw.length > 16) {
    fail("field_invalid", "overlays must be an array", "overlays");
  }
  const overlays: SurfaceOverlay[] = [];
  const seenSurface = new Set<string>();
  for (const [index, entry] of overlaysRaw.entries()) {
    const field = `overlays[${index}]`;
    if (!isRecord(entry)) fail("field_invalid", `${field} must be an object`, field);
    const surface = str(entry["surface"], `${field}.surface`, 32).toLowerCase();
    if (seenSurface.has(surface)) fail("duplicate_id", `two overlays for surface ${surface}`, field);
    seenSurface.add(surface);
    const path = validatePackPath(String(entry["path"] ?? ""), `${field}.path`);
    requirePresent(path, `${field}.path`);
    overlays.push({ surface, path });
  }

  // --- rules ---------------------------------------------------------------
  let rulesPath: string | undefined;
  if (document["rules"] !== undefined) {
    rulesPath = validatePackPath(String(document["rules"]), "rules");
    if (!rulesPath.toLowerCase().endsWith(".json")) {
      fail("path_invalid", "rules must name a JSON file", "rules");
    }
    requirePresent(rulesPath, "rules");
  }

  return {
    schemaVersion: SUPPORTED_PACK_SCHEMA_VERSION,
    id,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(language === undefined ? {} : { language }),
    ...(author === undefined ? {} : { author }),
    base,
    variants,
    overlays,
    ...(rulesPath === undefined ? {} : { rulesPath }),
  };
}

/**
 * Contextual-activation rules: the transparent, deterministic, local rule
 * engine the manifest may reference. A rule is a list of literal terms; a
 * variant with matching terms activates for the turn. No model call, no
 * embedding, no scoring - a user can read the file and predict the behaviour.
 */
export interface ContextualRule {
  readonly variantId: string;
  /** Case-insensitive literal terms matched against the current user message. */
  readonly anyOf: readonly string[];
}

export function parseContextualRules(
  document: unknown,
  manifest: PersonaManifest,
): readonly ContextualRule[] {
  if (!isRecord(document) || !Array.isArray(document["rules"])) {
    fail("field_invalid", "a rules file is an object with a rules array", "rules");
  }
  const contextualIds = new Set(
    manifest.variants.filter((v) => v.policy === "contextual").map((v) => v.id),
  );
  const out: ContextualRule[] = [];
  for (const [index, entry] of (document["rules"] as unknown[]).entries()) {
    const field = `rules[${index}]`;
    if (!isRecord(entry)) fail("field_invalid", `${field} must be an object`, field);
    const variantId = str(entry["variantId"], `${field}.variantId`, 64);
    if (!contextualIds.has(variantId)) {
      fail(
        "field_invalid",
        `${field}.variantId ${variantId} is not a contextual variant of this pack`,
        field,
      );
    }
    const anyOf = entry["anyOf"];
    if (!Array.isArray(anyOf) || anyOf.length === 0 || anyOf.length > 64) {
      fail("field_invalid", `${field}.anyOf must be a non-empty term array`, field);
    }
    out.push({
      variantId,
      anyOf: anyOf.map((t, i) => str(t, `${field}.anyOf[${i}]`, 128).toLowerCase()),
    });
  }
  return out;
}
