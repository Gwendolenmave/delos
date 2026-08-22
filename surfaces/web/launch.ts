#!/usr/bin/env node
/**
 * `npm run app:web` - start the daemon on a free loopback port and open the
 * browser at the served UI.
 *
 * The only file in the web surface that touches the real process. Data lives
 * under the platform's application-data directory (override with
 * DELOS_DATA_DIR); provider profiles seed from ./delos.config.json when it is
 * a schemaVersion 2 configuration.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../daemon/daemon.js";
import { defaultDataDir } from "../../adapters/config/app-data-dir.js";


async function seedProfiles(): Promise<readonly unknown[]> {
  try {
    const raw = JSON.parse(await readFile(resolve("delos.config.json"), "utf8")) as {
      schemaVersion?: number;
      providers?: unknown[];
    };
    if (raw.schemaVersion === 2 && Array.isArray(raw.providers)) return raw.providers;
  } catch {
    /* no config beside the working directory - start empty */
  }
  return [];
}

function openBrowser(url: string): void {
  const command =
    platform() === "win32" ? ["cmd", "/c", "start", "", url]
    : platform() === "darwin" ? ["open", url]
    : ["xdg-open", url];
  try {
    spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* opening is a courtesy; the URL is printed either way */
  }
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const daemon = await startDaemon({
    dataDir: process.env["DELOS_DATA_DIR"] ?? defaultDataDir(process.env),
    shippedPersonaDir: join(repoRoot, "personas"),
    env: process.env,
    seedProfiles: await seedProfiles(),
  });

  process.stdout.write(`Delos is running at ${daemon.origin}\n`);
  process.stdout.write(`Data directory: ${process.env["DELOS_DATA_DIR"] ?? defaultDataDir(process.env)}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");
  openBrowser(daemon.origin);

  const shutdown = (): void => {
    process.removeListener("SIGINT", shutdown);
    void daemon.close().then(() => {
      process.exitCode = 130;
    });
  };
  process.on("SIGINT", shutdown);
}

await main();
