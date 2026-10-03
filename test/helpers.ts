// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import type { CliDeps } from "../src/cli/io.js";
import { defaultDeps } from "../src/cli/program.js";
import { run } from "../src/cli/run.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(data: string | Buffer, contentType: string, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** Parse the query string of a recorded request URL into a URLSearchParams. */
export function queryOf(req: HttpRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}

// ---- CLI <-> library parity ---------------------------------------------------

/** What the CLI did with one input: exit code, captured output and requests. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  /** Files the CLI wrote with -o (path -> bytes), kept in memory. */
  files: Map<string, Buffer>;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, and requests. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

export interface ParityResult {
  cli: CliOutcome;
  lib: LibOutcome;
}

/**
 * Send one input through the CLI (`run(argv)` with the real client factory, on a
 * recording mock transport) and through a library call (`call(transport)`, e.g.
 * `(t) => new DdbClient({ transport: t }).item(id)`) on that same transport.
 * Returns both outcomes with the requests each side sent, so a test can assert
 * the same outcome: both reject with no request, or both send the identical
 * request. A synchronous throw from the library call (constructor validation) is
 * captured like a rejection.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse({}),
): Promise<ParityResult> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
    env: {},
  };
  const code = await run(argv, deps);
  const cliRequests = mt.calls.splice(0);
  const cli: CliOutcome = { code, out: out.join("\n"), err: err.join("\n"), files, requests: cliRequests };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.splice(0) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.splice(0) };
  }
  return { cli, lib };
}

/** The `METHOD url` of each request, for comparing both sides of a parity run. */
export function requestLines(requests: HttpRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.url}`);
}
