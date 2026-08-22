import type {
  MemoryContextProvider,
  MemoryContextRetrieval,
  MemorySceneIntent,
} from "../../core/ports/memory-context.js";

export const MNEMOSYNE_PACKAGE_NAME = "@delos/mnemosyne";

export type MnemosynePackageLoader = (specifier: string) => Promise<unknown>;

export type MnemosynePackageErrorKind =
  | "package_unavailable"
  | "package_incompatible"
  | "database_unavailable";

/** Safe startup failure: messages never include loader errors or database paths. */
export class MnemosynePackageError extends Error {
  constructor(
    readonly kind: MnemosynePackageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MnemosynePackageError";
  }
}

type Fn = (...args: unknown[]) => unknown;

interface MnemosyneModuleShape {
  readonly Anamnesis: {
    readonly buildMemoryReadPacket: Fn;
    readonly renderMemoryPacket: Fn;
  };
  readonly SqliteMnemosyne: {
    readonly openMnemosyne: Fn;
  };
}

interface MnemosyneHandleShape {
  readonly store: unknown;
  readonly log: { close(): void };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFunction(value: unknown): value is Fn {
  return typeof value === "function";
}

function parseModule(value: unknown): MnemosyneModuleShape {
  if (!isRecord(value)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package does not expose the required public API.",
    );
  }
  const anamnesis = value["Anamnesis"];
  const sqlite = value["SqliteMnemosyne"];
  if (!isRecord(anamnesis) || !isRecord(sqlite)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package does not expose the required public API.",
    );
  }
  const buildMemoryReadPacket = anamnesis["buildMemoryReadPacket"];
  const renderMemoryPacket = anamnesis["renderMemoryPacket"];
  const openMnemosyne = sqlite["openMnemosyne"];
  if (
    !requireFunction(buildMemoryReadPacket) ||
    !requireFunction(renderMemoryPacket) ||
    !requireFunction(openMnemosyne)
  ) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package does not expose the required public API.",
    );
  }
  return {
    Anamnesis: { buildMemoryReadPacket, renderMemoryPacket },
    SqliteMnemosyne: { openMnemosyne },
  };
}

function parseHandle(value: unknown): MnemosyneHandleShape {
  if (!isRecord(value)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package returned an incompatible database handle.",
    );
  }
  const log = value["log"];
  if (!("store" in value) || !isRecord(log)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package returned an incompatible database handle.",
    );
  }
  const close = log["close"];
  if (!requireFunction(close)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package returned an incompatible database handle.",
    );
  }
  return {
    store: value["store"],
    log: { close: () => void Reflect.apply(close, log, []) },
  };
}

const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature";

function warningType(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (typeof first !== "object" || first === null || !("type" in first)) return undefined;
  const type = (first as { readonly type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Mnemosyne uses Node's built-in SQLite. Keep the same narrow success-stderr
 * rule as the CLI bootstrap: suppress only Node's implementation-status
 * warning while the package graph first loads, then restore warning behavior.
 */
export const defaultMnemosynePackageLoader: MnemosynePackageLoader = async (specifier) => {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning;
    if (
      message.startsWith(SQLITE_EXPERIMENTAL_WARNING) &&
      warningType(args) === "ExperimentalWarning"
    ) {
      return;
    }
    return Reflect.apply(originalEmitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return await import(specifier);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
};

export interface CreateMnemosyneMemoryContextOptions {
  readonly dbPath: string;
  /** Test/construction seam. Production imports the published package name. */
  readonly loadPackage?: MnemosynePackageLoader;
}

function sceneForPackage(scene: MemorySceneIntent | undefined): {
  mode: "ordinary" | "au";
  auId?: string;
  intimacyActive: boolean;
} {
  if (scene?.mode === "au") {
    return { mode: "au", auId: scene.auId, intimacyActive: scene.intimacyActive };
  }
  // Unknown host scene intentionally narrows to ordinary on READ. The write
  // decision pipeline preserves `unknown` and quarantines it rather than
  // silently classifying it as ordinary.
  return { mode: "ordinary", intimacyActive: scene?.intimacyActive ?? false };
}

function packetMetadata(packet: unknown): {
  selectedIds: readonly string[];
  priorVersions: Readonly<Record<string, number>>;
} {
  if (!isRecord(packet)) return { selectedIds: [], priorVersions: {} };

  const selectedIds: string[] = [];
  const audit = packet["audit"];
  if (isRecord(audit) && Array.isArray(audit["selected"])) {
    for (const entry of audit["selected"]) {
      if (isRecord(entry) && typeof entry["id"] === "string") selectedIds.push(entry["id"]);
    }
  }

  const priorVersions: Record<string, number> = {};
  const priors = packet["priors"];
  if (Array.isArray(priors)) {
    for (const prior of priors) {
      if (
        isRecord(prior) &&
        typeof prior["key"] === "string" &&
        typeof prior["version"] === "number" &&
        Number.isInteger(prior["version"])
      ) {
        priorVersions[prior["key"]] = prior["version"];
      }
    }
  }
  return { selectedIds, priorVersions };
}

/**
 * Connect Delos to Mnemosyne strictly through the package's public surface.
 * No private source path, schema table or implementation module is imported.
 */
export async function createMnemosyneMemoryContextProvider(
  options: CreateMnemosyneMemoryContextOptions,
): Promise<MemoryContextProvider> {
  const loader = options.loadPackage ?? defaultMnemosynePackageLoader;
  let moduleValue: unknown;
  try {
    moduleValue = await loader(MNEMOSYNE_PACKAGE_NAME);
  } catch {
    throw new MnemosynePackageError(
      "package_unavailable",
      "Memory backend mnemosyne is enabled, but @delos/mnemosyne is not installed.",
    );
  }
  const module = parseModule(moduleValue);

  let handle: MnemosyneHandleShape;
  try {
    handle = parseHandle(module.SqliteMnemosyne.openMnemosyne(options.dbPath));
  } catch (error) {
    if (error instanceof MnemosynePackageError) throw error;
    throw new MnemosynePackageError(
      "database_unavailable",
      "Mnemosyne could not open the configured memory database.",
    );
  }

  let closed = false;
  return {
    async retrieve(
      query: string,
      nowIso: string,
      scene?: MemorySceneIntent,
    ): Promise<MemoryContextRetrieval> {
      try {
        const packet = module.Anamnesis.buildMemoryReadPacket({
          source: handle.store,
          query,
          scene: sceneForPackage(scene),
          nowIso,
        });
        const rendered = module.Anamnesis.renderMemoryPacket(packet);
        if (typeof rendered !== "string") {
          return {
            status: "degraded",
            detail: "Mnemosyne returned no usable memory packet for this turn.",
          };
        }
        const metadata = packetMetadata(packet);
        return { status: "ok", text: rendered, ...metadata };
      } catch {
        return {
          status: "degraded",
          detail: "Mnemosyne retrieval was unavailable for this turn.",
        };
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      handle.log.close();
    },
  };
}
