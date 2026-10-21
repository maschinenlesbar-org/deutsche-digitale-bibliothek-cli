// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result-rendering path.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, OutputRefusedError, logOf, type CliDeps } from "./io.js";
import type { DdbClientOptions } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/client";
import { DdbError, DdbUsageError, cutForMessage } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/errors";
import { baseUrlProblem, headerValueProblem } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/validate";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/engine";
import { SOLR_MAX_INT } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/types";

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
 * commander value-parser for a Solr int parameter: 0..SOLR_MAX_INT, the library's
 * bound (Java's Integer.MAX_VALUE; beyond it Solr fails with HTTP 500).
 */
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
 *
 * Any other dash-leading value is refused as the next option: `ddb -o --compact search x`
 * wrote a pretty-printed file named "--compact" with exit 0, because commander hands a value
 * option the next argument whatever it looks like. commander hands the parser the same
 * string for `-o -x` and `--output=-x`, so a file whose name starts with a dash is written as
 * `./-x`.
 */
export function parseOutputPath(value: string): string {
  parseNonEmpty(value);
  if (value !== "-" && value.startsWith("-")) {
    throw new InvalidArgumentError(
      `looks like a missing value — ${JSON.stringify(cutForMessage(value))} is the next option, consumed because ` +
        "this one was left without a value. For a file whose name starts with a dash, write ./-name.",
    );
  }
  return value;
}

/**
 * commander value-parser for --base-url: the library's rule (baseUrlProblem: not
 * blank, no surrounding whitespace, http(s) only, no query or fragment), as a
 * usage error at parse time (exit 2) rather than deep in the transport.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's rule (headerValueProblem: non-blank, no control characters except
 * tab, Latin-1 only), as a usage error.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
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
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the
 * 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which reorder
 * the text that follows. The output is server data, so escape them; the result is
 * equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
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
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on
 * Node 26 the fast path aborts the process ("Zone Allocation failed", exit 134, a native
 * dump on stderr) on a string of some 250 MB that JSON.parse made, while the gap path (an
 * empty gap, the same text) prints it. The fast path stays the default because on Node 26
 * only it is iterative and prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
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

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
}

/** `fn`, with any failure an `OutputError` (message and cause kept). */
function asOutputError(fn: () => void): void {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof OutputError) throw cause;
    throw new OutputError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/**
 * `deps.io.writeFile`, with any failure an `OutputError` (message and cause kept), so
 * every `-o` failure is logged under `ddb.output`, whatever the `CliIO` threw.
 */
export function writeOutputFile(deps: CliDeps, path: string, data: Buffer, force: boolean | undefined): void {
  asOutputError(() => deps.io.writeFile(path, data, force));
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
    writeOutputFile(deps, global.output, data, global.force);
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    // An -o path that exists (without --force; a dangling link too), or a directory, is a
    // usage error before any request, with the message the write would give afterwards —
    // no traffic for nothing.
    if (global.output !== undefined) {
      const output = global.output;
      try {
        deps.io.checkOutput?.(output, global.force);
      } catch (cause) {
        throw new OutputRefusedError(cause instanceof Error ? cause.message : String(cause), { cause });
      }
    }
    // One warning per run (a WARN record of `ddb.http`), before the first request, when
    // the base URL is plain http: to a host other than loopback. Help, version and usage
    // errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    // Route engine warnings (e.g. an https->http redirect downgrade) to stderr so
    // stdout stays clean for piping.
    const client = deps.createClient({
      ...toEngineOptions(global),
      warn: (message) => logOf(deps).warn("http", message.replace(/^warning: /i, "")),
      onRetry: (event) => logOf(deps).warn("http", retryMessage(event)),
      // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
      onWarning: (message) => logOf(deps).warn("api", message),
    });
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
