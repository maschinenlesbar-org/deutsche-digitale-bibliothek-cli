// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), follows redirects (stripping credentials on cross-origin hops),
// and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  DdbApiError,
  DdbError,
  DdbNetworkError,
  DdbParseError,
  DdbValidationError,
  credentialsIn,
  cutForMessage,
  echoedCredentialForms,
  messageUrl,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";

// The v2 API is versioned in the path: every resource lives under `/2`. The
// read routes this client targets (search, items, version) are public — no key.
export const DEFAULT_BASE_URL = "https://api.deutsche-digitale-bibliothek.de/2";
const DEFAULT_USER_AGENT = "deutsche-digitale-bibliothek-cli";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain `http:`
 * URL it returns one sentence (no `warning: ` prefix) naming the host (`url.host`: host
 * and port, never the userinfo) and what secret travels with the requests: `secrets`
 * are noun phrases such as `"the API key"`, and a `user:password@` in the URL adds
 * "the base URL's credentials". The secrets themselves are never in the sentence. Not
 * an error (a mirror on a trusted network is a legitimate setup), so the CLI logs it as
 * a `WARN` record of `ddb.http` on stderr (once per run, before the first request).
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/** Per-request options for {@link RequestEngine.request}. */
export interface RequestOptions {
  query?: QueryParams | undefined;
  accept: string;
  /**
   * Called for each redirect the engine would follow, with its resolved target. Returning
   * `false` stops there: the 3xx surfaces as a DdbApiError whose `location` names the target,
   * so the caller can decide (the client uses it for item redirects to another item).
   */
  followRedirect?: ((target: URL) => boolean) | undefined;
}

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large, not a number) makes the constructor throw a
 * DdbValidationError, and so does a `transport`, `sleep` or `warn` that is not a
 * function.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://api.deutsche-digitale-bibliothek.de/2.
   * Checked by `validateBaseUrl`: not blank, no surrounding whitespace, http(s)
   * only, no query or fragment; anything else makes the constructor throw a
   * DdbValidationError.
   */
  baseUrl?: string | undefined;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport.
   *
   * Contract: a custom transport must not follow redirects — it honours
   * `HttpRequest.redirect` (`"manual"`, e.g. `fetch(url, { redirect: req.redirect })`) and
   * returns the 3xx as is, because one that follows them sends every header
   * (`defaultHeaders`, the base URL's `Authorization`) to the redirect target before the
   * engine sees the answer, which the library cannot prevent; it can only reject the
   * response afterwards (a `HttpResponse.url` on another origin is a DdbNetworkError).
   */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header. Must be non-blank, without control characters
   * (tab allowed) and Latin-1 only (`headerValueProblem`), or the constructor
   * throws a DdbValidationError.
   */
  userAgent?: string | undefined;
  /**
   * Extra headers sent on every request to the configured origin. When a redirect
   * crosses to a different origin, all of them are dropped (only the engine's own
   * Accept and User-Agent go along), so no credential — Authorization,
   * Proxy-Authorization, Cookie, X-API-Key, X-Auth-Token or any other — leaks to an
   * arbitrary host named in Location. Names must be HTTP tokens and values pass
   * the same check as `userAgent`, or the constructor throws a DdbValidationError.
   */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Per-request timeout in milliseconds (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms),
   * covering the whole response body. Enforced by the engine for every transport.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections, 0..`MAX_RETRIES` (10). Each waits `retryDelayMs * attempt`, or longer
   * if the response's `Retry-After` asks (up to `MAX_RETRY_AFTER_MS`; a longer one is
   * not retried, and the error names the requested wait).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly); used without a
   * Retry-After. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number | undefined;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a DdbApiError naming the target.
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Enforced by the engine for every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Optional diagnostic sink for non-fatal warnings (e.g. a followed
   * `https:`->`http:` redirect downgrade). Defaults to a no-op so the client
   * stays silent as a library; the CLI wires it to stderr.
   */
  warn?: ((message: string) => void) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `ddb.api` (`warn` above is for the connection, `ddb.http`).
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values are known integers past 2^53 that a double can't carry
   * (Solr's 64-bit `_version_`). The value of a declared member, whatever its size, is
   * delivered as its exact literal as written, as a JSON string (`"_version_":5` becomes
   * `"5"`), so its type never depends on its size. A declared member whose value is not a
   * number (a string, `null`, an object) is left as it is. Every undeclared number keeps the
   * rule: exact, or a DdbParseError. Matched by name anywhere in a JSON answer, an escaped
   * name (`"\u005fversion_"`) included. Defaults to none; anything but a set or list of
   * non-empty strings makes the constructor throw a DdbValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a DdbApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. Node's transport
 * lower-cases them; a custom one may not (`Retry-After`, `Location`, `Content-Type`), and
 * a fetch transport naturally returns its `Headers` object, which has no plain properties.
 * Such an object (anything with `get` and `forEach`: `Headers`, a `Map`) is copied.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header (a repeated one arrives as an array). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a DdbNetworkError caused by a reset or aborted connection, which the engine
 * retries — whichever transport raised it (a Node error, fetch's TypeError with an undici
 * cause). A refused connection, a DNS failure or a timeout is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof DdbNetworkError && hasTransientCode(err.cause);
}

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -1` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    // A string or object is echoed by type, not value: it may be long or carry anything.
    const shown = typeof value === "number" ? String(value) : `a ${typeof value}`;
    throw new DdbValidationError(`Invalid option ${name}: expected an integer from 0 to ${max}, got ${shown}.`);
  }
  return value;
}

/**
 * Read a function-valued option (`transport`, `sleep`, `warn`): `undefined` gives the
 * default, anything but a function throws a DdbValidationError here rather than a raw
 * TypeError ("this.transport is not a function") at request time.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new DdbValidationError(`Invalid option ${name}: expected a function, got ${value === null ? "null" : typeof value}.`);
  }
  return value;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a DdbValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new DdbValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

/**
 * Strip C0/C1 control characters (except tab and newline) from a string that
 * originated in an attacker-controlled response body. A JSON error body can encode
 * an ESC as the six-character escape backslash-u-001b, which `JSON.parse` decodes
 * into a real control byte; without this a hostile or MITM'd endpoint could drive
 * ANSI/OSC escape sequences into the user's terminal when the error `detail` is
 * printed to stderr. It is also reused by the CLI to clean the raw item/version
 * passthrough before it reaches a terminal. The CLI's JSON output is escaped
 * separately (`escapeControlChars` in cli/shared.ts): `JSON.stringify` alone leaves
 * DEL and the C1 range raw. Written with
 * a char-code check so no control byte ever appears literally in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Check a configured base URL ({@link baseUrlProblem}: not blank, no surrounding
 * whitespace, a parseable http(s) URL without a query or fragment) and return it
 * with trailing slashes stripped. Throws a DdbValidationError
 * (`Invalid baseUrl: …`), never echoing the value.
 *
 * Runs on the raw value, before the slash strip, so `"https://h/2/ "` cannot slip
 * past it. The default transport also gates the scheme per hop (a
 * DdbNetworkError), but the engine is exported as a library and may be handed a
 * custom transport that does no such check, so the configured base URL is gated
 * here too.
 */
export function validateBaseUrl(baseUrl: string): string {
  return assertValid("baseUrl", baseUrl, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Longest error `detail` the engine keeps (in characters). A longer server message is
 * cut and ends in "…", so a hostile or buggy body cannot flood stderr.
 */
const MAX_DETAIL_LENGTH = 500;

/**
 * The DDB wraps a failing Solr request as HTTP 500 `{"message": "<Solr JSON>"}`: the
 * Solr error document arrives as a *string*. Return its `error.msg` (the one useful
 * line, e.g. `undefined field: "time_fct"`) when `message` is such a document.
 */
function solrErrorMessage(message: string): string | undefined {
  if (!message.trimStart().startsWith("{")) return undefined;
  try {
    const inner = JSON.parse(message) as { error?: unknown };
    const error = inner?.error;
    if (typeof error === "object" && error !== null) {
      const msg = (error as { msg?: unknown }).msg;
      if (typeof msg === "string" && msg.trim() !== "") return msg;
    }
  } catch {
    // Not JSON after all: use the message as it is.
  }
  return undefined;
}

/**
 * Clean an error detail for a one-line stderr message: strip control characters,
 * fold every whitespace run (newlines included) into one space and cap the length
 * (never inside a surrogate pair).
 */
function cleanDetail(detail: string): string {
  const clean = sanitizeServerText(detail).replace(/\s+/g, " ").trim();
  return cutForMessage(clean, MAX_DETAIL_LENGTH);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The headers the engine sets itself, under the exact keys it uses. They are the
// only ones that follow a cross-origin redirect.
const ENGINE_HEADERS = new Set(["Accept", "User-Agent"]);

/**
 * A copy of `headers` without any caller-supplied header (used on cross-origin
 * redirects). A list of known credential headers is never complete
 * (Proxy-Authorization, X-Auth-Token, ...), so only the engine's own
 * non-credential headers are kept.
 */
function engineHeadersOnly(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => ENGINE_HEADERS.has(key)));
}

/**
 * Whether the UTF-16 code unit `code` is a bidi formatting control: the Arabic letter mark
 * U+061C, the marks U+200E/U+200F, the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override in server
 * data can reorder what the user sees ("Trojan Source" spoofing). The CLI escapes them in its
 * JSON output.
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
export interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or a
  // credential header can't be logged by accident. Messages show request URLs
  // through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  readonly #defaultHeaders: Record<string, string>;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly warn: (message: string) => void;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    // Checked raw, before the trailing-slash strip (see validateBaseUrl).
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.#echoed = credentialsIn(this.#baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only `undefined` selects the default; a blank or otherwise unsendable value
    // is a DdbValidationError here rather than a network error at request time.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    const defaultHeaders: unknown = options.defaultHeaders ?? {};
    if (typeof defaultHeaders !== "object" || defaultHeaders === null || Array.isArray(defaultHeaders)) {
      throw new DdbValidationError(
        `Invalid option defaultHeaders: expected an object of header names and values, got ${defaultHeaders === null ? "null" : Array.isArray(defaultHeaders) ? "an array" : `a ${typeof defaultHeaders}`}.`,
      );
    }
    this.#defaultHeaders = { ...(defaultHeaders as Record<string, string>) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid(`defaultHeaders name ${JSON.stringify(cutForMessage(name))}`, name, headerNameProblem);
      assertValid(`defaultHeaders[${JSON.stringify(cutForMessage(name))}]`, value, headerValueProblem);
    }
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.warn = functionOption("warn", options.warn, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /**
   * Tell `onWarning` that `replaced` characters of the answer to `request` were replaced with
   * U+FFFD (nothing when none were). A throwing callback never breaks the request.
   */
  private reportReplaced(request: string, replaced: number): void {
    if (replaced === 0) return;
    try {
      this.onWarning?.(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /**
   * The body of an answer as text, decoded by its charset ({@link decodeBody}); bytes that are
   * not valid in it are replaced with U+FFFD and reported through `onWarning`, never silently.
   */
  private decodeText(res: RawResponse, request: string): string {
    const decoded = decodeBody(res.data, res.contentType, request);
    this.reportReplaced(request, decoded.replaced);
    return decoded.text;
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws a DdbError for a path with a "." or ".." segment. The client puts ids,
   * collections and request handlers into the path with `encodeURIComponent`, which
   * leaves those two unchanged, and URL parsing then resolves them: a collection of
   * ".." with handler "version" would request `/2/search/version`. Neither can name
   * a resource. (Percent-encoded forms such as "%2e%2e" are safe:
   * encodeURIComponent turns their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new DdbValidationError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    return this.joinUrl(normalizedPath, query);
  }

  /** Base URL + path + query string, without buildUrl's validation. */
  private joinUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host that gave
   * a bad answer, which matters with a custom base URL), userinfo redacted (`https://***@host`)
   * and cut at MAX_MESSAGE_URL_LENGTH characters (`messageUrl`). It never throws: describing a
   * URL for a message does not validate it (buildUrl does).
   */
  describeUrl(path: string, query?: QueryParams): string {
    return messageUrl(redactUrl(this.joinUrl(path, query)));
  }

  /**
   * The base URL without its userinfo, for the URLs a transport sees: the engine sends
   * the userinfo as an `Authorization` header instead (see {@link basicAuthorization}).
   */
  private requestBase(): string {
    const parsed = new URL(this.#baseUrl);
    if (parsed.username === "" && parsed.password === "") return this.#baseUrl;
    parsed.username = "";
    parsed.password = "";
    return parsed.href.replace(/\/+$/, "");
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DdbNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: RequestOptions = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The transport never sees the base URL's userinfo: the engine sends it as an
    // Authorization header, per hop, so a redirect to the same origin (relative or
    // absolute) keeps it and one to another origin or scheme drops it. A transport such
    // as fetch also refuses a URL with credentials outright.
    let url = this.requestBase() + this.buildUrl(path, options.query).slice(this.#baseUrl.length);
    let headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
      ...this.#defaultHeaders,
    };
    const authorization = basicAuthorization(this.#baseUrl);
    // A caller's own Authorization header (defaultHeaders) wins over the userinfo.
    if (authorization !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
      headers["Authorization"] = authorization;
    }
    /** Why a redirect dropped the base URL's credentials, for a 401/403 message. */
    let dropped: string | undefined;

    // Only an idempotent request is sent again after a reset: request() is public, and a
    // POST re-sent after a reset may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a proxy) reset is the network-level twin of a 503:
        // retry an idempotent request, whichever transport reported it. Timeouts are not
        // retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        // The default transport rejects with DdbNetworkError only; an injected one may
        // throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a DdbError — and scrub that text.
        if (cause instanceof DdbError && !(cause instanceof DdbNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new DdbNetworkError(
          `${method} ${redactUrl(url)} failed: ${cleanDetail(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the DdbError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new DdbNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried a credential header to another host — fetch
      // strips only Authorization, not X-Auth-Token or X-API-Key — and the answer is not
      // the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new DdbNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${cleanDetail(redactUrl(this.scrub(finalUrl)))}); a transport must not follow redirects ` +
            `(HttpRequest.redirect is "manual").`,
        );
      }

      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new DdbNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can ask for longer, never
        // for less: `Retry-After: 0` or a date in the past made a zero-delay burst against a
        // server that had just asked for less load. A Retry-After beyond MAX_RETRY_AFTER_MS
        // is not retried: the error below surfaces at once and names the requested wait.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = headerValue(responseHeaders["location"]);
      const candidate =
        FOLLOWED_REDIRECTS.has(status) && redirects < this.maxRedirects
          ? resolveLocation(location, url)
          : undefined;
      const next =
        candidate !== undefined && options.followRedirect !== undefined && !options.followRedirect(candidate)
          ? undefined
          : candidate;
      if (next !== undefined) {
        const prev = new URL(url);
        // Only http(s) is followed: a `file:`, `javascript:` or `data:` target is refused here,
        // before any transport (a custom one may not check the scheme) is called with it.
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new DdbNetworkError(
            `Refusing to follow redirect to unsupported protocol "${cleanDetail(next.protocol)}" for ${method} ${redactUrl(url)}`,
          );
        }
        // Userinfo in a Location is not used: credentials come from the base URL only,
        // as the Authorization header, never from a server.
        next.username = "";
        next.password = "";
        // SECURITY: when a redirect crosses origins — scheme, host or port — drop every
        // caller header and the base URL's Authorization, so none is ever sent to a
        // foreign host (the classic credential-leak-on-redirect that fetch/curl guard
        // against). The same origin keeps them, whether the Location is relative or
        // absolute.
        if (next.origin !== prev.origin) {
          if (dropped === undefined && Object.keys(headers).some((k) => !ENGINE_HEADERS.has(k))) {
            dropped =
              prev.protocol === "http:" && next.protocol === "https:" && prev.hostname === next.hostname
                ? "the server redirected http→https, which dropped the base URL's credentials; use an https base URL"
                : `the redirect to ${cutForMessage(next.origin)} dropped the credentials (they are sent to their own origin only)`;
          }
          headers = engineHeadersOnly(headers);
        }
        // A same-scheme change from https: to http: is a transport downgrade: the
        // remaining hops (and the response body) travel in cleartext. Credentials
        // are already stripped above (the origin differs), but warn so a hostile
        // host silently steering the client onto http: is visible to the user.
        if (prev.protocol === "https:" && next.protocol === "http:") {
          this.warn(
            `Warning: following an https->http redirect downgrade to ${cutForMessage(next.origin)} ` +
              "(subsequent traffic is unencrypted; credentials were stripped).",
          );
        }
        url = next.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as a DdbApiError naming the target.

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(
          method,
          url,
          status,
          body,
          contentType,
          location,
          status === 401 || status === 403
            ? dropped
            : status === 414
              ? `the request URL is too long for the server (${url.length} characters); ` +
                "shorten the query or the filter list (--filter), or split it into several searches"
            : retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS
              ? `the server asked to wait ${Math.ceil(retryAfter / 1000)} s (Retry-After), longer than the ` +
                `${MAX_RETRY_AFTER_MS / 1000} s the client waits; retrying sooner won't help`
              : undefined,
        );
      }

      return { data: body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T` ({@link parseJson}). */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    return this.parseJson<T>(res, `GET ${this.describeUrl(path, query)}`);
  }

  /**
   * A JSON answer, decoded by its charset and parsed. Every error about the answer is a
   * DdbParseError that names the request (`request`, as `GET <url>`, userinfo redacted):
   * an unknown charset, an empty body (every JSON answer is a document; read as "nothing", it
   * let a script carry on as if the API had found nothing), a body that isn't JSON (naming its
   * Content-Type when that isn't JSON either: an HTML maintenance or proxy page), and a number
   * JSON.parse can't carry exactly. Declared big integers (`bigIntegerKeys`) are quoted first.
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  parseJson<T>(res: RawResponse, request: string): T {
    const decoded = decodeBody(res.data, res.contentType, request);
    if (decoded.text.trim() === "") throw new DdbParseError(`${request}: empty response body.`);
    const repaired = wellFormedEscapes(decoded.text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      throw new DdbParseError(`${request}: the answer is not valid JSON${typeHint(res.contentType)}.`, { cause });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new DdbParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    this.reportReplaced(request, decoded.replaced + repaired.replaced);
    return parsed;
  }

  /** Perform a GET returning the decoded response body as text (e.g. /version). */
  async getText(path: string, query?: QueryParams): Promise<string> {
    const res = await this.request("GET", path, { query, accept: "*/*" });
    return this.decodeText(res, `GET ${this.describeUrl(path, query)}`);
  }

  /** Perform a GET returning the raw bytes (binary downloads). */
  async getRaw(
    path: string,
    accept: string,
    query?: QueryParams,
    followRedirect?: (target: URL) => boolean,
  ): Promise<RawResponse> {
    return this.request("GET", path, { query, accept, ...(followRedirect ? { followRedirect } : {}) });
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    contentType: string,
    locationHeader?: string,
    hint?: string,
  ): DdbApiError {
    const text = this.scrub(decodeBody(body, contentType, url, "lenient").text);
    let detail: string | undefined;
    let apiName: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        name?: unknown;
        message?: unknown;
        detail?: unknown;
        // Solr reports errors as `{ error: { msg, code } }`.
        error?: { msg?: unknown } | unknown;
      };
      if (parsed && typeof parsed.message === "string") {
        detail = solrErrorMessage(parsed.message) ?? parsed.message;
      }
      else if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (
        parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        typeof (parsed.error as { msg?: unknown }).msg === "string"
      ) {
        detail = (parsed.error as { msg: string }).msg;
      }
      if (parsed && typeof parsed.name === "string") apiName = parsed.name;
    } catch {
      // Non-JSON error body (e.g. an item XML component's error page); leave undefined.
    }
    // `detail` came from the attacker-controlled response body; strip control
    // characters so a hostile/MITM'd endpoint can't smuggle terminal escape
    // sequences into stderr when this message is printed (DDB-01), and keep it to
    // one bounded line.
    if (detail !== undefined) detail = cleanDetail(detail);
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, this.scrub(locationHeader)) : undefined;
    return new DdbApiError({ status, url, method, body: text, detail, apiName, location });
  }
}

/**
 * ` (expected JSON, got Content-Type "text/html")` for an answer that is not JSON when its type
 * isn't either, so it reads as an upstream problem rather than a client bug; "" otherwise.
 */
function typeHint(contentType: string): string {
  const type = contentType.split(";")[0]?.trim() ?? "";
  return type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(cleanDetail(type))}")` : "";
}

/**
 * Decode a response body by the charset of its Content-Type (UTF-8 when none is given,
 * as JSON requires). TextDecoder drops a leading byte order mark, which Buffer#toString
 * keeps and JSON.parse then rejects. An unknown charset label is a DdbParseError naming
 * it and `request` (`GET <url>`), or, with `"lenient"` (raw XML parts, error bodies),
 * decoded as UTF-8 — those callers keep the exact bytes anyway. Bytes that are not valid in the
 * charset become U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte
 * charsets; for UTF-16 a U+FFFD the server sent counts too.
 */
export function decodeBody(
  body: Buffer,
  contentType: string,
  request: string,
  mode: "strict" | "lenient" = "strict",
): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    if (mode !== "lenient") {
      throw new DdbParseError(`${request}: unsupported response charset "${cutForMessage(cleanDetail(charset))}".`);
    }
    decoder = new TextDecoder("utf-8", { fatal: true });
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch {
    // Not valid in the charset: decode with replacement, and count what was replaced.
    const text = new TextDecoder(decoder.encoding).decode(body);
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The `Authorization` header for a URL's userinfo (`Basic base64(user:password)`, both
 * percent-decoded, as Node's own http client builds it), or undefined without userinfo.
 */
function basicAuthorization(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return undefined;
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The origin (scheme, host, port) of a URL, or the value itself if it doesn't parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).replace(/\s+/g, " ").trim();
  return clean === "" ? undefined : clean;
}
