// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { DdbClient as Client } from "../src/client/client.js";
import {
  DdbError as BaseError,
  DdbParseError as ParseError,
  DdbValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.search({ query: "Goethe" });
const textBody = (text: string): unknown => ({ response: { numFound: 1, start: 0, docs: [{ id: "A", label: text }] } });
const readText = (result: unknown): string =>
  (result as { response: { docs: Array<{ label: string }> } }).response.docs[0]!.label;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { response: "x" }, { error: "boom" }, { response: null },
  // Solr's error document, a string numFound, a response without docs, the DDB envelope (03 note 5).
  { error: { msg: "undefined field", code: 400 } },
  { response: { numFound: "3", start: 0, docs: [] } },
  { response: { numFound: 1, start: 0 } },
  { name: "ItemNotFoundException", message: "gone", stacktrace: [] },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["item(5)", () => new Client().item(5 as unknown as string)],
  ["item(null)", () => new Client().item(null as unknown as string)],
  ["item(id, 'nope')", () => new Client().item("A".repeat(32), "nope" as never)],
  ["item(id, 'view', 5)", () => new Client().item("A".repeat(32), "view", 5 as never)],
  ["search(null)", () => new Client().search(null as never)],
  ["search({ query: 5 })", () => new Client().search({ query: 5 as unknown as string })],
  ["search({ rows: '5' })", () => new Client().search({ query: "x", rows: "5" as unknown as number })],
  ["search({ facetLimit without facetFields })", () => new Client().search({ query: "x", facetLimit: 3 })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["maxRedirects: 21", () => new Client({ maxRedirects: 21 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as never })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 1", () => new Client({ sleep: 1 as never })],
  ["warn: 1", () => new Client({ warn: 1 as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
