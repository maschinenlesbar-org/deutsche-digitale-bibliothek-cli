// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/http";
import type { CliDeps } from "../src/cli/io.js";
import { defaultDeps } from "../src/cli/program.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/test/helpers";

export * from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [ddb.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
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

/**
 * What the library did with the same input: its value or error (anything thrown that is not
 * an Error is wrapped in one), and requests. The kit's shape, which the shared conformance
 * bodies (P24, P25) read.
 */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  error?: Error;
  requests: HttpRequest[];
}

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
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), files, requests: cliRequests };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.splice(0) };
  } catch (error) {
    lib = { ok: false, error: error instanceof Error ? error : new Error(String(error)), requests: mt.calls.splice(0) };
  }
  return { cli, lib };
}

/** The `METHOD url` of each request, for comparing both sides of a parity run. */
export function requestLines(requests: HttpRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.url}`);
}
