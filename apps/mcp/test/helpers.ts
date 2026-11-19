// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream on the DDB v2 API (the client's ddb.ts: live answers recorded on 2026-11-19), a mock
// search over given documents, and the client's transport helpers. The generic harness (a
// connection, a config, a log recorder, the HTTP server) is harness.ts.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/test/helpers";

export * from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/test/helpers";
export * from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/test/ddb";

/** A mock search over `docs`: every query matches them all, paged by start and rows as Solr does. */
export function searchWith(docs: Record<string, unknown>[]): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const start = Number(url.searchParams.get("start") ?? "0");
    const rows = Number(url.searchParams.get("rows") ?? "10");
    return jsonResponse({ response: { numFound: docs.length, start, docs: docs.slice(start, start + rows) } });
  });
}
