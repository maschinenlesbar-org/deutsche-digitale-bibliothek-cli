// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), follows redirects (stripping credentials on cross-origin hops),
// and decodes responses.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { DdbApiError, DdbParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.deutsche-digitale-bibliothek.de";
const DEFAULT_USER_AGENT = "deutsche-digitale-bibliothek-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://api.deutsche-digitale-bibliothek.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request (e.g. the Authorization API key). */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Header names (lower-cased) that carry credentials and must never follow a
// redirect to a different origin.
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

/** Return a copy of `headers` with any credential-bearing header removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
      ...this.defaultHeaders,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = response.headers["location"];
        // A 3xx without a usable Location is malformed; surface it as an API
        // error rather than silently treating it as success below.
        if (typeof location !== "string" || location.length === 0) {
          throw this.toApiError(method, url, status, response.body);
        }
        const prev = new URL(url);
        const next = new URL(location, url);
        // SECURITY: the header object carries `Authorization: OAuth
        // oauth_consumer_key="<key>"`. When the redirect crosses origins, drop
        // every credential header so the API key is never sent to a foreign host
        // (the classic credential-leak-on-redirect that fetch/curl guard against).
        if (next.origin !== prev.origin) {
          headers = stripCredentialHeaders(headers);
        }
        url = next.toString();
        redirects += 1;
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
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

  private toApiError(method: string, url: string, status: number, body: Buffer): DdbApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    let apiName: string | undefined;
    try {
      const parsed = JSON.parse(text) as { name?: unknown; message?: unknown; detail?: unknown };
      if (parsed && typeof parsed.message === "string") detail = parsed.message;
      else if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      if (parsed && typeof parsed.name === "string") apiName = parsed.name;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    return new DdbApiError({ status, url, method, body: text, detail, apiName });
  }
}
