// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { DdbNetworkError, redactUrl, credentialsIn, redactCredentials, typedUrlCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects. The engine
   * follows them itself and decides per hop which headers go along (the base URL's
   * `Authorization` and every `defaultHeaders` entry: same origin only). A fetch-based
   * transport passes it on: `fetch(url, { redirect })`. One that ignores it sends those
   * headers to the redirect target before the engine can see the redirect — a documented
   * limitation the library cannot enforce; the engine only rejects the response afterwards.
   */
  redirect?: "manual";
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL the response came from, if the transport knows it (fetch's `response.url`).
   * When it is on another origin than the request, the transport followed a redirect
   * itself and the engine rejects the response with a DdbNetworkError.
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs). The body's chunks are joined as they arrive
 * (every COALESCE_CHUNKS chunks or COALESCE_BYTES bytes), so its memory follows the bytes, not
 * the number of chunks a server sends.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new DdbNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(new DdbNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // Wall-clock deadline for the *whole* exchange. `req.setTimeout` below only
    // fires on an idle socket, so a server that drips one byte per interval could
    // otherwise keep the request alive forever despite --timeout. This total timer
    // destroys the request once `timeoutMs` has elapsed regardless of activity.
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    const onResponse = (res: http.IncomingMessage): void => {
      // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them or
      // COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks a server
      // chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
      const chunks: Buffer[] = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          clearDeadline();
          res.destroy();
          reject(new DdbNetworkError(sizeLimitMessage(maxBytes)));
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
          chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
          pending = [];
          pendingBytes = 0;
        }
      });
      res.on("end", () => {
        if (aborted) return;
        clearDeadline();
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat([...chunks, ...pending]),
        });
      });
      res.on("error", (err) => {
        if (aborted) return; // we already rejected with the size-cap error
        clearDeadline();
        reject(new DdbNetworkError(`Response stream error: ${err.message}`, { cause: err }));
      });
    };

    // driver.request throws synchronously for a header value Node cannot send (CR/LF,
    // a character above U+00FF); surface that as a typed error, not a raw TypeError.
    let req: http.ClientRequest;
    try {
      req = driver.request(url, { method: request.method, headers: request.headers }, onResponse);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      reject(new DdbNetworkError(`Invalid request: ${reason}`, { cause: err }));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const delay = Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
      // Idle-socket timeout (no bytes for timeoutMs).
      req.setTimeout(delay, () => {
        req.destroy(new DdbNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
      // Total wall-clock deadline (bytes may keep trickling but the whole exchange
      // must finish within timeoutMs). `unref` so a pending timer never keeps the
      // process alive on its own.
      deadline = setTimeout(() => {
        req.destroy(new DdbNetworkError(`Request exceeded the ${request.timeoutMs}ms deadline`));
      }, delay);
      deadline.unref?.();
    }

    if (request.signal !== undefined) {
      const signal = request.signal;
      const abort = (): void => {
        req.destroy(
          signal.reason instanceof DdbNetworkError
            ? signal.reason
            : new DdbNetworkError(`Request exceeded the ${request.timeoutMs ?? 0}ms deadline`),
        );
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      clearDeadline();
      // A timeout destroy already passes a DdbNetworkError; don't double-wrap.
      reject(err instanceof DdbNetworkError ? err : new DdbNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
