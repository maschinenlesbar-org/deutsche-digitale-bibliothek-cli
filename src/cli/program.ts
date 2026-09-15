// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { DdbClient } from "../client/client.js";
import { DEFAULT_BASE_URL } from "../client/engine.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerCommands } from "./commands/index.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem + real env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new DdbClient(options),
  env: process.env,
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("ddb")
    .description(
      "CLI for the Deutsche Digitale Bibliothek v2 API " +
        "(https://api.deutsche-digitale-bibliothek.de/2) — search digitised " +
        "cultural-heritage objects from German archives, libraries and museums, " +
        "and fetch item detail. The v2 read routes are public: no API key needed.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, DEFAULT_BASE_URL)
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseBoundedInt(0, MAX_TIMEOUT_MS))
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout")
    .option("--force", "overwrite the --output file if it already exists")
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
