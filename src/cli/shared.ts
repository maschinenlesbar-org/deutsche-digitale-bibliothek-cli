// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result-rendering path.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { DdbClientOptions } from "../client/client.js";
import { DdbError, DdbUsageError } from "../client/errors.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  return parseBoundedInt(0, Number.MAX_SAFE_INTEGER)(value);
}

/**
 * Build a commander value-parser for an integer constrained to [min, max]. A
 * well-formed number that is too large (even beyond 2^53) says so, rather than
 * "Expected a non-negative integer".
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    if (!/^[0-9]+$/.test(value)) {
      throw new InvalidArgumentError("Expected a non-negative integer.");
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    return n;
  };
}

/**
 * The largest value Solr accepts for an int parameter (`rows`, `start`,
 * `facet.limit`): Java's Integer.MAX_VALUE. Beyond it Solr fails with HTTP 500.
 */
export const SOLR_MAX_INT = 2_147_483_647;

/** commander value-parser for a Solr int parameter: 0..SOLR_MAX_INT. */
export const parseSolrInt = parseBoundedInt(0, SOLR_MAX_INT);

/**
 * commander value-parser for --facet-limit: 0..SOLR_MAX_INT, or -1, which Solr
 * reads as "no limit" (every value of the facet; the default limit is 100).
 */
export function parseFacetLimit(value: string): number {
  return value === "-1" ? -1 : parseSolrInt(value);
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for `-o, --output <file>`. A blank or whitespace-only path
 * is a usage error: `-o ""` used to print to stdout silently and `-o " "` created a
 * file named " ". `-` is kept as is and means stdout (see {@link action}), the
 * usual convention, rather than a file named "-".
 */
export function parseOutputPath(value: string): string {
  return parseNonEmpty(value);
}

/**
 * commander value-parser for --base-url. The base URL is trusted input, but only
 * `http:`/`https:` are accepted so a stray `file:`/`ftp:` value fails at parse
 * time (exit 2) with a clear message rather than deep in the transport.
 */
export function parseBaseUrl(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("Expected a non-empty URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError("Only http: and https: base URLs are supported.");
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path ("http://h/2#f" requests "/2" for every command).
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  // new URL() trims surrounding whitespace silently; the raw value is what the
  // engine uses, so reject it rather than guess.
  if (value !== value.trim()) {
    throw new InvalidArgumentError("A base URL cannot have surrounding whitespace.");
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * Rejects control characters — a CR/LF (or other C0/DEL byte) would otherwise reach
 * Node's HTTP layer and throw an opaque `ERR_INVALID_CHAR`. Tab (0x09) is allowed;
 * checked by char code so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
  }
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): DdbClientOptions {
  const options: DdbClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  // Likewise, a blank --user-agent falls back to the engine's default UA rather
  // than sending an empty User-Agent header.
  if (global.userAgent !== undefined && global.userAgent.trim().length > 0) {
    options.userAgent = global.userAgent;
  }
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a DdbError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new DdbError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short stderr confirmation so stdout stays
 * clean for piping), or to stdout otherwise.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    deps.io.writeFile(global.output, data, global.force);
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // --force only lets -o overwrite a file; on its own it would be ignored.
    if (global.force === true && global.output === undefined) {
      throw new DdbUsageError("--force needs --output (it only allows overwriting the -o file).");
    }
    // `-o -` means stdout: from here on it is the same as no -o.
    if (global.output === "-") delete global.output;
    // Route engine warnings (e.g. an https->http redirect downgrade) to stderr so
    // stdout stays clean for piping.
    const client = deps.createClient({
      ...toEngineOptions(global),
      warn: (message) => deps.io.err(message),
    });
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
