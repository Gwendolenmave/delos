import { dirname, isAbsolute, resolve } from "node:path";

import {
  createMnemosyneMemoryContextProvider,
  MnemosynePackageError,
  type MnemosynePackageLoader,
} from "../adapters/memory/mnemosyne-package.js";
import type { MemoryContextProvider } from "../core/ports/memory-context.js";
import type { RunTurnInput, TurnService } from "../core/services/turn-service.js";
import {
  createRuntime as createBaseRuntime,
  describeStartupFailure as describeBaseStartupFailure,
  type CreateRuntimeOptions as BaseCreateRuntimeOptions,
  type DelosRuntime,
  type RuntimeStartupErrorKind as BaseRuntimeStartupErrorKind,
} from "./create-runtime-base.js";

export type {
  DelosRuntime,
  EnvironmentLike,
  FetchLike,
} from "./create-runtime-base.js";
export { RuntimeStartupError } from "./create-runtime-base.js";

export type RuntimeStartupErrorKind = BaseRuntimeStartupErrorKind | "memory_unavailable";

export interface CreateRuntimeOptions extends BaseCreateRuntimeOptions {
  /** Test seam. Production resolves the optional peer package by name. */
  readonly memoryPackageLoader?: MnemosynePackageLoader;
}

/**
 * Public v0.2 host-memory activation contract.
 *
 * Memory stays outside the provider JSON schema so existing schemaVersion 1
 * and schemaVersion 2 files remain valid without migration. `off` is the
 * default. `mnemosyne` is an explicit host-local opt-in and requires a path to
 * the local SQLite authority. The path is configuration, never a credential.
 */
interface MnemosyneRuntimeConfig {
  readonly dbPath: string;
}

class MemoryRuntimeStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRuntimeStartupError";
  }
}

export function describeStartupFailure(error: unknown): string {
  if (error instanceof MemoryRuntimeStartupError) return error.message;
  return describeBaseStartupFailure(error);
}

/**
 * Resolve the publication-facing memory environment contract.
 *
 * - unset / `off`: no memory package is loaded and the established Delos path
 *   is unchanged;
 * - `mnemosyne`: `DELOS_MEMORY_DB_PATH` is required;
 * - a relative database path resolves against the selected Delos config file,
 *   not process.cwd(), so launching from another directory does not silently
 *   point at another database.
 *
 * Unsupported backend values are never echoed. This keeps an accidentally
 * pasted secret or other private value out of startup errors.
 */
function resolveMnemosyneRuntimeConfig(options: BaseCreateRuntimeOptions): MnemosyneRuntimeConfig | null {
  const backend = options.env["DELOS_MEMORY_BACKEND"]?.trim() ?? "off";
  if (backend === "" || backend === "off") return null;
  if (backend !== "mnemosyne") {
    throw new MemoryRuntimeStartupError(
      "Unsupported DELOS_MEMORY_BACKEND. Expected off or mnemosyne.",
    );
  }

  const configuredPath = options.env["DELOS_MEMORY_DB_PATH"]?.trim();
  if (configuredPath === undefined || configuredPath.length === 0) {
    throw new MemoryRuntimeStartupError(
      "Memory backend mnemosyne requires DELOS_MEMORY_DB_PATH.",
    );
  }

  const dbPath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(dirname(options.configPath), configuredPath);
  return { dbPath };
}

function withMemoryContext(
  turnService: TurnService,
  memory: MemoryContextProvider,
): TurnService {
  return {
    async runTurn(input: RunTurnInput) {
      // Expiry/lifecycle policy needs an honest instant. Existing public CLI
      // turns already carry one. Other surfaces that omit it degrade to the
      // unchanged memoryless turn rather than guessing time.
      if (input.atIso === undefined) {
        return turnService.runTurn(input);
      }

      let retrieval;
      try {
        retrieval = await memory.retrieve(input.userText, input.atIso);
      } catch {
        return turnService.runTurn(input);
      }
      if (retrieval.status !== "ok") {
        return turnService.runTurn(input);
      }

      return turnService.runTurn({
        ...input,
        context: [
          ...(input.context ?? []),
          { kind: "retrieved-memory", text: retrieval.text },
        ],
      });
    },
  };
}

/**
 * Public-v0.2 composition wrapper: keep the proven provider/runtime path
 * untouched, then optionally attach Mnemosyne through its package API. This
 * branch does not copy Mnemosyne source or import private implementation paths.
 */
export async function createRuntime(options: CreateRuntimeOptions): Promise<DelosRuntime> {
  const { memoryPackageLoader, ...baseOptions } = options;
  const base = await createBaseRuntime(baseOptions);

  let config: MnemosyneRuntimeConfig | null;
  try {
    config = resolveMnemosyneRuntimeConfig(baseOptions);
  } catch (error) {
    await base.close();
    throw error;
  }
  if (config === null) return base;

  let memory: MemoryContextProvider;
  try {
    memory = await createMnemosyneMemoryContextProvider({
      dbPath: config.dbPath,
      ...(memoryPackageLoader === undefined ? {} : { loadPackage: memoryPackageLoader }),
    });
  } catch (error) {
    await base.close();
    if (error instanceof MnemosynePackageError) {
      throw new MemoryRuntimeStartupError(error.message);
    }
    throw new MemoryRuntimeStartupError("Mnemosyne could not be attached to Delos.");
  }

  let closed = false;
  return {
    ...base,
    turnService: withMemoryContext(base.turnService, memory),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await base.close();
      } finally {
        await memory.close?.();
      }
    },
  };
}
