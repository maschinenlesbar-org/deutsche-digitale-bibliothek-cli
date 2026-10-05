// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), follows redirects (stripping credentials on cross-origin hops),
// and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  DdbApiError,
  DdbError,
  DdbNetworkError,
  DdbParseError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";

// The v2 API is versioned in the path: every resource lives under `/2`. The
// read routes this client targets (search, items, version) are public — no key.
export const DEFAULT_BASE_URL = "https://api.deutsche-digitale-bibliothek.de/2";
const DEFAULT_USER_AGENT = "deutsche-digitale-bibliothek-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a DdbError.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://api.deutsche-digitale-bibliothek.de/2.
   * Checked by `validateBaseUrl`: not blank, no surrounding whitespace, http(s)
   * only, no query or fragment; anything else makes the constructor throw a
   * DdbValidationError.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header. Must be non-blank, without control characters
   * (tab allowed) and Latin-1 only (`headerValueProblem`), or the constructor
   * throws a DdbValidationError.
   */
  userAgent?: string;
  /**
   * Extra headers sent on every request to the configured origin. When a redirect
   * crosses to a different origin, all of them are dropped (only the engine's own
   * Accept and User-Agent go along), so no credential — Authorization,
   * Proxy-Authorization, Cookie, X-API-Key, X-Auth-Token or any other — leaks to an
   * arbitrary host named in Location. Names must be HTTP tokens and values pass
   * the same check as `userAgent`, or the constructor throws a DdbValidationError.
   */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); used without a
   * Retry-After. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a DdbApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional diagnostic sink for non-fatal warnings (e.g. a followed
   * `https:`->`http:` redirect downgrade). Defaults to a no-op so the client
   * stays silent as a library; the CLI wires it to stderr.
   */
  warn?: (message: string) => void;
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
    throw new DdbError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
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
 * fold every whitespace run (newlines included) into one space and cap the length.
 */
function cleanDetail(detail: string): string {
  const clean = sanitizeServerText(detail).replace(/\s+/g, " ").trim();
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
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

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or a
  // credential header can't be logged by accident. Messages show request URLs
  // through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  readonly #defaultHeaders: Record<string, string>;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(options: EngineOptions = {}) {
    // Checked raw, before the trailing-slash strip (see validateBaseUrl).
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only `undefined` selects the default; a blank or otherwise unsendable value
    // is a DdbValidationError here rather than a network error at request time.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid(`defaultHeaders name ${JSON.stringify(name)}`, name, headerNameProblem);
      assertValid(`defaultHeaders[${JSON.stringify(name)}]`, value, headerValueProblem);
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
    this.sleep = options.sleep ?? realSleep;
    this.warn = options.warn ?? (() => {});
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
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
      throw new DdbError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    let headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
      ...this.#defaultHeaders,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
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

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = response.headers["location"];
      const next =
        FOLLOWED_REDIRECTS.has(status) && redirects < this.maxRedirects
          ? resolveLocation(location, url)
          : undefined;
      if (next !== undefined) {
        const prev = new URL(url);
        // SECURITY: the v2 read routes need no credentials, but a caller may still
        // inject one (Authorization, Proxy-Authorization, a token header ...) via
        // defaultHeaders. When a redirect crosses origins, drop every caller header
        // so none is ever sent to a foreign host (the classic credential-leak-on-
        // redirect that fetch/curl guard against).
        if (next.origin !== prev.origin) {
          headers = engineHeadersOnly(headers);
        }
        // A same-scheme change from https: to http: is a transport downgrade: the
        // remaining hops (and the response body) travel in cleartext. Credentials
        // are already stripped above (the origin differs), but warn so a hostile
        // host silently steering the client onto http: is visible to the user.
        if (prev.protocol === "https:" && next.protocol === "http:") {
          this.warn(
            `Warning: following an https->http redirect downgrade to ${next.origin} ` +
              "(subsequent traffic is unencrypted; credentials were stripped).",
          );
        }
        url = next.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, no usable Location, or past
      // maxRedirects — falls through and surfaces as a DdbApiError naming the target.

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    // A successful response with an empty body (e.g. 204 No Content) is not a
    // parse failure — treat it as `null` rather than surfacing a DdbParseError.
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new DdbParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  /** Perform a GET returning the decoded response body as text (e.g. /version). */
  async getText(path: string, query?: QueryParams): Promise<string> {
    const res = await this.request("GET", path, { query, accept: "*/*" });
    return res.data.toString("utf8");
  }

  /** Perform a GET returning the raw bytes (binary downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
  ): DdbApiError {
    const text = this.scrub(body.toString("utf8"));
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
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, this.scrub(locationHeader)) : undefined;
    return new DdbApiError({ status, url, method, body: text, detail, apiName, location });
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
