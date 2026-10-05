import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient, DEFAULT_SEARCH_ROWS } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { DdbApiError, DdbError, DdbParseError, DdbValidationError } from "../src/client/errors.js";
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
  assert.equal(await c.version(), "7.5");
  assert.equal(pathOf(mt.last().url), "/2/version");
});

test("the client rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new DdbClient({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof DdbValidationError &&
        err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
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
  cases.push([() => c.item(id, "foo" as ItemPart), /^Invalid part: Expected one of: view, aip, edm, .*, citation\.$/]);
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

test("a body is decoded by its declared charset; an unknown one is a parse error for JSON (P8)", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify({ response: { numFound: 1, start: 0, docs: [{ label: text }] } }), encoding);
    const c = new DdbClient({ transport: async () => ({ status: 200, headers: { "content-type": `application/json; charset=${charset}` }, body }) });
    const r = await c.search({ query: "x" });
    assert.equal((r.response?.docs[0] as unknown as { label: string }).label, text, charset);
  }
  // A UTF-8 BOM is dropped rather than failing JSON.parse.
  const bom = new DdbClient({
    transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("﻿" + JSON.stringify({ response: { numFound: 0, start: 0, docs: [] } })) }),
  });
  await assert.doesNotReject(bom.search({ query: "x" }));
  const bogus = new DdbClient({ transport: async () => ({ status: 200, headers: { "content-type": "application/json; charset=x-bogus" }, body: Buffer.from("{}") }) });
  await assert.rejects(bogus.search({ query: "x" }), (e: unknown) => e instanceof DdbParseError && /x-bogus/.test(e.message));
  // A raw XML part with a Latin-1 body: exact bytes kept, text decoded.
  const xml = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>Müller</a>', "latin1");
  const item = new DdbClient({ transport: async () => ({ status: 200, headers: { "content-type": "application/xml; charset=ISO-8859-1" }, body: xml }) });
  const r = await item.item("A".repeat(32), "source-record");
  assert.ok(r.text?.includes("Müller"));
  assert.ok(r.bytes?.equals(xml));
});

test("item options with an unknown key are a validation error before any request (P10)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ item: {} }));
  const c = new DdbClient({ transport: mt.transport });
  for (const opts of [{ limit: 5 }, { Lang: "en" }, JSON.parse('{"__proto__": {"lang": "en"}}')]) {
    await assert.rejects(c.item("A".repeat(32), "children", opts as never), DdbValidationError, JSON.stringify(opts));
  }
  assert.equal(mt.calls.length, 0);
});

test("item follows a component the API points at an ancestor through the base URL (01#1)", async () => {
  const SECTION = "JG3YAM7VLFJPVGMAWK4IBCJVFHNFZ5NP";
  const VOLUME = "JY7HJBJAUBYMG437RSIFJNUPMMSAHT26";
  // The live answer: 303 with an absolute Location that lacks the /2 prefix.
  const mt = makeMockTransport((req) =>
    req.url.includes(SECTION)
      ? { status: 303, headers: { location: `https://api.deutsche-digitale-bibliothek.de/items/${VOLUME}/source/record`, "content-type": "application/xml" }, body: Buffer.from("<x/>") }
      : rawResponse("<mets/>", "application/xml"),
  );
  const r = await new DdbClient({ transport: mt.transport }).item(SECTION, "source-record");
  assert.equal(r.text, "<mets/>");
  assert.equal(r.heldBy, VOLUME);
  assert.deepEqual(mt.calls.map((c) => c.url), [
    `https://api.deutsche-digitale-bibliothek.de/2/items/${SECTION}/source/record`,
    `https://api.deutsche-digitale-bibliothek.de/2/items/${VOLUME}/source/record`,
  ]);
});

test("an ancestor chain that ends in a 404 says so instead of naming another id alone (06)", async () => {
  const [UNIT, PARENT, TOP] = ["N4N7TIGNXOHU6IW5L64Z3RPYARCTWNEL", "NSNKITEB5XPCOXWSRHPQSCWSAKRLO2JH", "RQBX".padEnd(32, "A")];
  const next: Record<string, string> = { [UNIT]: PARENT, [PARENT]: TOP };
  const mt = makeMockTransport((req) => {
    const id = /items\/([A-Z0-9]{32})/.exec(req.url)![1]!;
    return next[id]
      ? { status: 303, headers: { location: `https://api.deutsche-digitale-bibliothek.de/items/${next[id]}/source/record` }, body: Buffer.alloc(0) }
      : jsonResponse({ name: "ItemNotFoundException", message: "No data row is available (size=0)." }, 404);
  });
  await assert.rejects(new DdbClient({ transport: mt.transport }).item(UNIT, "source-record"), (e: unknown) => {
    assert.ok(e instanceof DdbApiError && e.status === 404, String(e));
    assert.match(e.message, /No data row is available/);
    assert.match(e.message, new RegExp(`item ${UNIT} has no source-record of its own; the API points to its ancestors \\(${UNIT} → ${PARENT} → ${TOP}\\), and the last has none either`));
    return true;
  });
  assert.equal(mt.calls.length, 3);
  // maxRedirects bounds the walk: 0 reports the redirect instead of following it.
  const once = makeMockTransport(() => ({ status: 303, headers: { location: `https://x.example/items/${PARENT}/source/record` }, body: Buffer.alloc(0) }));
  await assert.rejects(new DdbClient({ transport: once.transport, maxRedirects: 0 }).item(UNIT, "source-record"), (e: unknown) =>
    e instanceof DdbApiError && e.status === 303 && /redirect to https:\/\/x\.example\/items\/NSNK.* not followed/.test(e.message),
  );
  assert.equal(once.calls.length, 1);
});
