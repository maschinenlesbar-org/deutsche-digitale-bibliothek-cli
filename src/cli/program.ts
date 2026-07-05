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

/**
 * Read DDB_API_KEY from the given environment, trimmed. A missing, empty, or
 * whitespace-only value is treated as unset (returns undefined) so it never
 * produces a malformed `Authorization: OAuth oauth_consumer_key=""` header.
 */
export function readEnvApiKey(env: Record<string, string | undefined>): string | undefined {
  const raw = env["DDB_API_KEY"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("ddb")
    .description(
      "CLI for the Deutsche Digitale Bibliothek API " +
        "(https://api.deutsche-digitale-bibliothek.de) — search digitised " +
        "cultural-heritage objects from German archives, libraries and museums. " +
        "Needs an API key: pass --api-key or set DDB_API_KEY (a free personal key " +
        "is available from a \"Mein DDB\" account).",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", parseBaseUrl, DEFAULT_BASE_URL)
    .option("--api-key <key>", "DDB API key (env: DDB_API_KEY)")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout")
    .showHelpAfterError();

  // Seed --api-key from DDB_API_KEY (trimmed; blank treated as unset). commander
  // treats this as the option's value, which an explicit --api-key on the command
  // line overrides during parse, giving precedence: --api-key > DDB_API_KEY > none.
  const envKey = readEnvApiKey(deps.env ?? process.env);
  if (envKey !== undefined) program.setOptionValue("apiKey", envKey);

  registerCommands(program, deps);

  return program;
}
