import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient, DEFAULT_SEARCH_ROWS } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { DdbError, DdbNetworkError, DdbParseError, DdbValidationError } from "../src/client/errors.js";
import type { ItemPart, SearchParams } from "../src/client/types.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function pathOf(url: string): string {
  return new URL(url).pathname;
}

test("search hits the Solr passthrough path and forwards q, rows, start, sort, fl, wt", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "Goethe", rows: 10, start: 20, sort: "id asc", fields: "id,title" });
  const req = mt.last();
  assert.equal(pathOf(req.url), "/2/search/index/search/select");
  const q = queryOf(req);
  assert.equal(q.get("q"), "Goethe");
  assert.equal(q.get("rows"), "10");
  assert.equal(q.get("start"), "20");
  assert.equal(q.get("sort"), "id asc");
  assert.equal(q.get("fl"), "id,title");
  assert.equal(q.get("wt"), "json");
});

test("search sends rows=DEFAULT_SEARCH_ROWS (10) when no rows is given", async () => {
  assert.equal(DEFAULT_SEARCH_ROWS, 10);
  assert.equal(lib.DEFAULT_SEARCH_ROWS, DEFAULT_SEARCH_ROWS);
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  await new DdbClient({ transport: mt.transport }).search({ query: "Goethe" });
  assert.equal(queryOf(mt.last()).get("rows"), "10");
});

test("search enables faceting and forwards repeated facet.field + facet.limit", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*:*", facetFields: ["type_fct", "place_fct"], facetLimit: 5 });
  const q = queryOf(mt.last());
  assert.equal(q.get("facet"), "true");
  assert.deepEqual(q.getAll("facet.field"), ["type_fct", "place_fct"]);
  assert.equal(q.get("facet.limit"), "5");
});

test("search forwards repeated filter queries as fq", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*:*", filters: ["type_fct:mediatype_002", 'place_fct:"Berlin"'] });
  assert.deepEqual(queryOf(mt.last()).getAll("fq"), ["type_fct:mediatype_002", 'place_fct:"Berlin"']);
});

test("search collection/requestHandler override the path segments", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "x", collection: "newspaper", requestHandler: "mlt" });
  assert.equal(pathOf(mt.last().url), "/2/search/index/newspaper/mlt");
});

test("no Authorization header is sent (v2 read routes are keyless)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*:*" });
  assert.equal(mt.last().headers?.["Authorization"], undefined);
});

test("item defaults to the view component and parses JSON", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.itemView));
  const c = new DdbClient({ transport: mt.transport });
  const res = await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK/view");
  assert.deepEqual(res.json, fx.itemView);
  assert.equal(res.text, undefined);
});

test("item with part=aip hits the bare item endpoint", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "aip");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK");
});

test("item edm is returned as raw text, not parsed", async () => {
  const mt = makeMockTransport(() => rawResponse(fx.edmXml, "application/rdf+xml;charset=utf-8"));
  const c = new DdbClient({ transport: mt.transport });
  const res = await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "edm");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK/edm");
  assert.equal(res.text, fx.edmXml);
  assert.equal(res.json, undefined);
});

test("item source-description and source-record map to nested paths", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "source-description");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK/source/description");
  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "source-record");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK/source/record");
});

test("item citation maps to the (misspelled) upstream /citiation path", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "citation");
  assert.equal(pathOf(mt.last().url), "/2/items/TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK/citiation");
});

test("item forwards lang for view, rejects it for parents; children takes rows/offset", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });

  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "view", { lang: "en" });
  assert.equal(queryOf(mt.last()).get("lang"), "en");

  const before = mt.calls.length;
  await assert.rejects(
    () => c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "parents", { lang: "en" }),
    (err) =>
      err instanceof DdbValidationError &&
      err.message ===
        "Invalid lang: applies only to part view, aip, edm, binaries, source, source-description (got parents).",
  );
  await assert.rejects(
    () => c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "edm", { rows: 5 }),
    (err) => err instanceof DdbValidationError && err.message === "Invalid rows: applies only to part children (got edm).",
  );
  await assert.rejects(
    () => c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", undefined, { offset: 0 }),
    (err) => err instanceof DdbValidationError && err.message === "Invalid offset: applies only to part children (got view).",
  );
  assert.equal(mt.calls.length, before);

  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "children", { rows: 5, offset: 10 });
  const q = queryOf(mt.last());
  assert.equal(q.get("rows"), "5");
  assert.equal(q.get("offset"), "10");
});

test("version reads the plain-text /version endpoint", async () => {
  const mt = makeMockTransport(() => rawResponse("7.5\n", "text/plain"));
  const c = new DdbClient({ transport: mt.transport });
  assert.equal(await c.version(), "7.5\n");
  assert.equal(pathOf(mt.last().url), "/2/version");
});

test("the client rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new DdbClient({ baseUrl, transport: mt.transport }),
      (err) => err instanceof DdbNetworkError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("search rejects a 2xx body that is not a Solr JSON object", async () => {
  const cases: [string, string][] = [
    ["", "a JSON object"],
    ["null", "a JSON object"],
    ["[1,2,3]", "a JSON object"],
    ["42", "a JSON object"],
    ['{"response":[1]}', "a response object"],
  ];
  for (const [body, expected] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json"));
    const c = new DdbClient({ transport: mt.transport });
    await assert.rejects(
      () => c.search({ query: "x" }),
      (err) =>
        err instanceof DdbParseError &&
        err.message === `Unexpected response shape from /search/index/search/select: expected ${expected}.`,
      body,
    );
  }
});

test("the client rejects bad search parameters without a request", async () => {
  const cases: [SearchParams, string][] = [
    [{ query: "" }, 'Invalid query: expected a non-empty string, got "".'],
    [{ query: "   " }, 'Invalid query: expected a non-empty string, got "   ".'],
    [{ query: "x", rows: -5 }, "Invalid rows: expected an integer from 0 to 2147483647, got -5."],
    [{ query: "x", start: 1.5 }, "Invalid start: expected an integer from 0 to 2147483647, got 1.5."],
    [{ query: "x", rows: 2147483648 }, "Invalid rows: expected an integer from 0 to 2147483647, got 2147483648."],
    [
      { query: "x", facetFields: ["a"], facetLimit: NaN },
      "Invalid facetLimit: expected an integer from -1 to 2147483647, got NaN.",
    ],
    [{ query: "x", filters: [""] }, 'Invalid filters entry: expected a non-empty string, got "".'],
    [{ query: "x", facetFields: [" "] }, 'Invalid facetFields entry: expected a non-empty string, got " ".'],
    [{ query: "x", sort: "" }, 'Invalid sort: expected a non-empty string, got "".'],
    [{ query: "x", facetLimit: 3 }, "Invalid facetLimit: it needs facetFields (it caps the values returned per facet field)."],
  ];
  for (const [params, message] of cases) {
    const mt = makeMockTransport(() => jsonResponse(fx.solr));
    const c = new DdbClient({ transport: mt.transport });
    await assert.rejects(() => c.search(params), (err) => err instanceof DdbError && err.message === message, message);
    assert.equal(mt.calls.length, 0);
  }
  // -1 (Solr: no limit) is accepted.
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  await new DdbClient({ transport: mt.transport }).search({ query: "x", facetFields: ["a"], facetLimit: -1 });
  assert.equal(queryOf(mt.last()).get("facet.limit"), "-1");
});

test("the client rejects a blank id, an unknown part and bad item options without a request", async () => {
  const id = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";
  const cases: [() => Promise<unknown>, RegExp][] = [];
  const mt = makeMockTransport(() => jsonResponse(fx.itemView));
  const c = new DdbClient({ transport: mt.transport });
  cases.push([() => c.item(""), /^Invalid id: Expected exactly 32 characters \(got 0\)\. /]);
  cases.push([() => c.item(id, "foo" as ItemPart), /^Invalid part: expected one of view, aip, edm, .*, got "foo"\.$/]);
  cases.push([() => c.item(id, "toString" as ItemPart), /^Invalid part: /]);
  cases.push([() => c.item(id, "children", { rows: -1 }), /^Invalid rows: /]);
  cases.push([() => c.item(id, "children", { offset: 0.5 }), /^Invalid offset: /]);
  cases.push([() => c.item(id, "view", { lang: " " }), /^Invalid lang: /]);
  for (const [call, message] of cases) {
    await assert.rejects(call, (err) => err instanceof DdbError && message.test(err.message), String(message));
  }
  assert.equal(mt.calls.length, 0);
});

test("item trims the id and rejects a malformed one with DdbValidationError, without a request", async () => {
  const id = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";
  const mt = makeMockTransport(() => jsonResponse(fx.itemView));
  const c = new DdbClient({ transport: mt.transport });
  await c.item(` ${id}\n`, "edm");
  assert.equal(pathOf(mt.last().url), `/2/items/${id}/edm`);
  mt.calls.length = 0;
  const cases: [string, RegExp][] = [
    ["ABC", /^Invalid id: Expected exactly 32 characters \(got 3\)\./],
    [id.toLowerCase(), new RegExp(`^Invalid id: Item ids are upper case: try "${id}"\\.$`)],
    [`${id.slice(0, 31)}!`, /^Invalid id: Expected 32 upper-case letters and digits/],
    ["a/b", /^Invalid id: Expected exactly 32 characters/],
  ];
  for (const [bad, message] of cases) {
    await assert.rejects(
      () => c.item(bad),
      (err) => err instanceof DdbValidationError && message.test(err.message),
      bad,
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("the engine rejects out-of-range numeric options at construction", () => {
  const bad: [string, number][] = [
    ["timeoutMs", -1],
    ["timeoutMs", NaN],
    ["maxRetries", -3],
    ["maxRetries", Infinity],
    ["maxRetries", 11],
    ["retryDelayMs", -100],
    ["maxRedirects", 21],
    ["maxResponseBytes", -1],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new DdbClient({ [name]: value }),
      (err) =>
        err instanceof DdbError &&
        new RegExp(`^Invalid option ${name}: expected an integer from 0 to \\d+, got ${String(value)}\\.$`).test(err.message),
      `${name}=${value}`,
    );
  }
  assert.doesNotThrow(() => new DdbClient({ timeoutMs: 0, maxRetries: 10, maxRedirects: 0, maxResponseBytes: 0 }));
});
