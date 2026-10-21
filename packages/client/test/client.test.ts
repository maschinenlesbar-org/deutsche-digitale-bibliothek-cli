import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient, DEFAULT_SEARCH_ROWS } from "../src/client.js";
import * as lib from "../src/index.js";
import { DdbApiError, DdbError, DdbParseError, DdbValidationError } from "../src/errors.js";
import type { ItemPart, SearchParams } from "../src/types.js";
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
        err.message ===
          (body === ""
            ? "GET https://api.deutsche-digitale-bibliothek.de/2/search/index/search/select?q=x&wt=json&rows=10: empty response body."
            : "GET https://api.deutsche-digitale-bibliothek.de/2/search/index/search/select?q=x&wt=json&rows=10: " +
              `unexpected response shape: expected ${expected}. Only request ` +
              `handlers that return Solr's standard response envelope (a "response" object with "numFound" ` +
              `and "docs") are supported; handler "select" did not.`),
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
  cases.push([() => c.item(""), /^Invalid id: Expected a non-empty value\.$/]);
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
    transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("\ufeff" + JSON.stringify({ response: { numFound: 0, start: 0, docs: [] } })) }),
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

test("own messages quote a server's or user's value at most 200 characters long (L3)", async () => {
  // A redirect that is not followed names its target: cut, not 20 000 characters.
  const target = `https://mirror.test/${"x".repeat(20_000)}`;
  const redirect = new DdbClient({ transport: async () => ({ status: 300, headers: { location: target }, body: Buffer.alloc(0) }) });
  await assert.rejects(redirect.version(), (err: Error) => {
    assert.ok(err instanceof DdbApiError);
    assert.match(err.message, /redirect to https:\/\/mirror\.test\/x+… not followed/);
    assert.ok(err.message.length < 600, `${err.message.length}`);
    return true;
  });
  // A request handler that does not answer Solr's envelope is named, cut.
  const handler = "h".repeat(20_000);
  const search = new DdbClient({ transport: async () => jsonResponse({ ok: true }) });
  await assert.rejects(search.search({ query: "x", requestHandler: handler }), (err: Error) => {
    assert.ok(err instanceof DdbParseError);
    assert.ok(err.message.length < 1000, `${err.message.length}`);
    assert.match(err.message, /handler "h{200}…" did not/);
    return true;
  });
});

test("the query and every filter go out in composed Unicode (NFC) (bug 1, 2026-10-15)", async () => {
  // The query `München` with U+0308 found 231 documents where the composed form found 2,770,474;
  // `place_fct:"München"` in NFD found 0 where NFC found 2,517,097.
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const client = new DdbClient({ transport: mt.transport });
  await client.search({
    query: "München",
    filters: ['place_fct:"München"', "type_fct:mediatype_002"],
    facetFields: ["place_fct"],
  });
  const q = queryOf(mt.calls[0]!);
  assert.equal(q.get("q"), "München");
  assert.deepEqual(q.getAll("fq"), ['place_fct:"München"', "type_fct:mediatype_002"]);
  assert.equal(q.get("facet.field"), "place_fct");
});

test("a number the answer cannot carry exactly is a parse error in search and item (bug 2, 2026-10-15)", async () => {
  // JSON.parse rounded 12345678901234567890 to 12345678901234567000 and turned 1e400 into
  // Infinity (printed as null), with exit 0, in search docs and in item JSON parts.
  const ID = "A".repeat(32);
  for (const n of ["12345678901234567890", "1e400", "-1e400"]) {
    const search = makeMockTransport(() =>
      rawResponse(`{"response":{"numFound":1,"docs":[{"id":"x","label":"a 12345678901234567890 in text","begin_time":${n}}]}}`, "application/json"),
    );
    await assert.rejects(new DdbClient({ transport: search.transport }).search({ query: "x" }), (err) => {
      assert.ok(err instanceof DdbParseError, n);
      assert.equal(err.message, `GET https://api.deutsche-digitale-bibliothek.de/2/search/index/search/select?q=x&wt=json&rows=10: the number ${n} cannot be represented exactly.`);
      return true;
    });
    const item = makeMockTransport(() => rawResponse(`{"item":{"pages":${n}}}`, "application/json"));
    await assert.rejects(new DdbClient({ transport: item.transport }).item(ID), (err) => {
      assert.ok(err instanceof DdbParseError, n);
      assert.equal(err.message, `GET https://api.deutsche-digitale-bibliothek.de/2/items/${ID}/view: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly passes, digits inside strings included.
  const ok = makeMockTransport(() =>
    rawResponse('{"response":{"numFound":1,"docs":[{"id":"x","label":"12345678901234567890","begin_time":9007199254740991,"w":1.10}]}}', "application/json"),
  );
  const res = await new DdbClient({ transport: ok.transport }).search({ query: "x" });
  assert.equal((res.response.docs[0] as Record<string, unknown>)["begin_time"], 9007199254740991);
});

test("a big number written as a decimal or an exponent, a fraction past 2^53 and an underflow are parse errors too (kit rollout K1, 2026-10-21)", async () => {
  // These passed the check and printed 12345678901234567000, 9007199254740992 and 0, exit 0.
  const ID = "A".repeat(32);
  for (const n of ["12345678901234567890.0", "9007199254740993e0", "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399", "123456789012345678901234567890"]) {
    const search = makeMockTransport(() =>
      rawResponse(`{"response":{"numFound":1,"docs":[{"id":"x","begin_time":${n}}]}}`, "application/json"),
    );
    await assert.rejects(new DdbClient({ transport: search.transport }).search({ query: "x" }), (err) => {
      assert.ok(err instanceof DdbParseError, n);
      assert.equal(err.message, `GET https://api.deutsche-digitale-bibliothek.de/2/search/index/search/select?q=x&wt=json&rows=10: the number ${n} cannot be represented exactly.`);
      return true;
    });
    const item = makeMockTransport(() => rawResponse(`{"item":{"pages":${n}}}`, "application/json"));
    await assert.rejects(new DdbClient({ transport: item.transport }).item(ID), (err) => {
      assert.ok(err instanceof DdbParseError, n);
      assert.equal(err.message, `GET https://api.deutsche-digitale-bibliothek.de/2/items/${ID}/view: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // The same values in other forms, zero in any form, and a decimal fraction below 2^53 pass.
  const ok: Array<[string, number]> = [
    ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53], ["90071992547409920E-1", 2 ** 53], ["1.2e21", 1.2e21],
    ["0", 0], ["0.0e-500", 0], ["0e5", 0], ["-0", -0], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["1e2", 100],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
  ];
  for (const [n, value] of ok) {
    const mt = makeMockTransport(() => rawResponse(`{"response":{"numFound":1,"docs":[{"id":"x","begin_time":${n}}]}}`, "application/json"));
    const res = await new DdbClient({ transport: mt.transport }).search({ query: "x" });
    assert.equal((res.response.docs[0] as Record<string, unknown>)["begin_time"], value, n);
    const item = makeMockTransport(() => rawResponse(`{"item":{"pages":${n}}}`, "application/json"));
    const got = await new DdbClient({ transport: item.transport }).item(ID);
    assert.equal(((got.json as Record<string, Record<string, unknown>>)["item"]!)["pages"], value, n);
  }
});

test("the query and every filter go out trimmed, a Solr-escaped trailing space kept (kit rollout K6)", async () => {
  // A value pasted with a trailing space or no-break space went out as typed: on a string facet
  // field (`place_fct`) `München` + U+00A0 is another value and matched nothing.
  const NBSP = String.fromCharCode(0xa0);
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const client = new DdbClient({ transport: mt.transport });
  await client.search({
    query: `  München${NBSP}\n`,
    filters: [` place_fct:München${NBSP}`, "\ttype_fct:mediatype_002 ", "label:foo\\ ", "label:foo\\\\ "],
  });
  const q = queryOf(mt.calls[0]!);
  assert.equal(q.get("q"), "München");
  assert.deepEqual(q.getAll("fq"), ["place_fct:München", "type_fct:mediatype_002", "label:foo\\ ", "label:foo\\\\"]);
  // A value blank once trimmed (U+00A0 included) is refused before any request.
  for (const params of [{ query: `${NBSP} ` }, { query: "x", filters: ["a:b", ` ${NBSP}`] }]) {
    await assert.rejects(client.search(params), DdbValidationError);
  }
  assert.equal(mt.calls.length, 1);
  assert.equal(lib.normalizeText(" Müller "), "Müller");
});

test("Solr's _version_ is delivered as its exact decimal literal, a string, in search and item; undeclared numbers keep the rule (Bug 05-1, 2026-10-21)", async () => {
  // Every live Solr doc carries `_version_` (about 1.85e18, past 2^53); the number check refused
  // it, so every search with hits exited 1 and search() rejected.
  const ID = "A".repeat(32);
  const body =
    '{"response":{"numFound":3,"docs":[' +
    '{"id":"a","_version_":1850000000000000001,"label":"x \\"_version_\\":123 y"},' +
    '{"id":"b","_version_" : 5},' +
    '{"id":"c","\\u005fversion_":-7,"_version_x":1,"x_version_":2}]}}';
  const mt = makeMockTransport(() => rawResponse(body, "application/json"));
  const res = await new DdbClient({ transport: mt.transport }).search({ query: "x" });
  const docs = res.response.docs as Array<Record<string, unknown>>;
  assert.equal(docs[0]!["_version_"], "1850000000000000001");
  // A string holding the same text is left alone.
  assert.equal(docs[0]!["label"], 'x "_version_":123 y');
  // A small value is a string too, so the type never depends on the size.
  assert.equal(docs[1]!["_version_"], "5");
  // A member name written with an escape is the same name; other names are not.
  assert.equal(docs[2]!["_version_"], "-7");
  assert.equal(docs[2]!["_version_x"], 1);
  assert.equal(docs[2]!["x_version_"], 2);
  assert.equal(res.response.numFound, 3);

  const item = makeMockTransport(() => rawResponse('{"item":{"_version_":1858054135406919680,"pages":4}}', "application/json"));
  const got = await new DdbClient({ transport: item.transport }).item(ID);
  assert.deepEqual(got.json, { item: { _version_: "1858054135406919680", pages: 4 } });

  // An undeclared big number next to it is still refused, in search and in item.
  const big = makeMockTransport(() =>
    rawResponse('{"response":{"numFound":1,"docs":[{"id":"a","_version_":1850000000000000001,"begin_time":1850000000000000001}]}}', "application/json"),
  );
  await assert.rejects(new DdbClient({ transport: big.transport }).search({ query: "x" }), (err) => {
    assert.ok(err instanceof DdbParseError);
    assert.equal(err.message, "GET https://api.deutsche-digitale-bibliothek.de/2/search/index/search/select?q=x&wt=json&rows=10: the number 1850000000000000001 cannot be represented exactly.");
    return true;
  });
  const bigItem = makeMockTransport(() => rawResponse('{"_version_":1,"n":1850000000000000001}', "application/json"));
  await assert.rejects(new DdbClient({ transport: bigItem.transport }).item(ID), /the number 1850000000000000001 cannot be represented exactly/);
});

test("a caller's bigIntegerKeys are added to _version_, and a bad value is refused", async () => {
  const mt = makeMockTransport(() => rawResponse('{"response":{"numFound":1,"docs":[{"id":"a","_version_":1,"begin_time":2}]}}', "application/json"));
  const res = await new DdbClient({ transport: mt.transport, bigIntegerKeys: new Set(["begin_time"]) }).search({ query: "x" });
  assert.deepEqual(res.response.docs[0], { id: "a", _version_: "1", begin_time: "2" });
  assert.throws(() => new DdbClient({ bigIntegerKeys: "begin_time" as unknown as ReadonlySet<string> }), DdbValidationError);
});

test("a JSON item part answered with a non-JSON body is a parse error, never data (Bug 04-1, 2026-10-21)", async () => {
  // A captive portal, a proxy login page or a wrong base URL answered `view` with 200 text/html:
  // item() resolved { contentType: "text/html", text: "<html>…" } and the CLI printed it, exit 0.
  // Whether a part is JSON is the part's, not the Content-Type's.
  const ID = "A".repeat(32);
  for (const part of ["view", "aip", "binaries", "children", "parents", "source", "source-description", "iiif"] as const) {
    const mt = makeMockTransport(() => rawResponse("<html>portal</html>", "text/html"));
    await assert.rejects(new DdbClient({ transport: mt.transport }).item(ID, part), (err: unknown) => {
      assert.ok(err instanceof DdbParseError, part);
      assert.match(err.message, /not valid JSON \(expected JSON, got Content-Type "text\/html"\)/, `${part}: ${err.message}`);
      return true;
    });
  }
  // A JSON part with a JSON body under another type is still read as JSON.
  const plain = makeMockTransport(() => rawResponse('{"a":1}', "text/plain"));
  assert.deepEqual((await new DdbClient({ transport: plain.transport }).item(ID)).json, { a: 1 });
  // The raw parts stay text, whatever their type says.
  for (const part of ["edm", "source-record", "citation"] as const) {
    const mt = makeMockTransport(() => rawResponse('{"a":1}', "application/json"));
    const r = await new DdbClient({ transport: mt.transport }).item(ID, part);
    assert.equal(r.text, '{"a":1}', part);
    assert.equal(r.json, undefined, part);
  }
});

test("every answer error of search, item and version names the request, method and URL (T9, D9, 2026-10-21)", async () => {
  const BASE = "https://api.deutsche-digitale-bibliothek.de/2";
  const ID = "A".repeat(32);
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["search shape", () => new DdbClient({ transport: makeMockTransport(() => jsonResponse({ docs: [] })).transport }).search({ query: "x", rows: 1 }),
      `GET ${BASE}/search/index/search/select?q=x&wt=json&rows=1: unexpected response shape: expected a response object.`],
    ["search error document", () => new DdbClient({ transport: makeMockTransport(() => jsonResponse({ error: { msg: "bad" } })).transport }).search({ query: "x" }),
      `GET ${BASE}/search/index/search/select?q=x&wt=json&rows=10: an error document with a success status: bad`],
    ["item shape", () => new DdbClient({ transport: makeMockTransport(() => jsonResponse(5)).transport }).item(ID),
      `GET ${BASE}/items/${ID}/view: unexpected response shape: expected a JSON object or array.`],
    ["item number", () => new DdbClient({ transport: makeMockTransport(() => rawResponse('{"n":1e400}', "application/json")).transport }).item(ID, "children", { rows: 2 }),
      `GET ${BASE}/items/${ID}/children?rows=2: the number 1e400 cannot be represented exactly.`],
    ["version", () => new DdbClient({ transport: makeMockTransport(() => rawResponse("<html>", "text/html")).transport }).version(),
      `GET ${BASE}/version: expected a version string such as "7.5", got "<html>".`],
  ];
  for (const [label, call, message] of cases) {
    await assert.rejects(call(), (err: unknown) => {
      assert.ok(err instanceof DdbParseError, label);
      assert.equal(err.message.startsWith(message.split(": ")[0]! + ": "), true, `${label}: ${err.message}`);
      assert.ok(err.message.startsWith(message), `${label}: ${err.message}`);
      return true;
    });
  }
});

test("a refusal quotes the value visibly: invisible and format characters escaped, never raw (T10, D10, 2026-10-21)", async () => {
  const c = new DdbClient({ transport: makeMockTransport(() => jsonResponse({})).transport });
  for (const key of ["fil\u200bters", "a\u202eb", "x\u00ady", "q\u2028"]) {
    await assert.rejects(c.search({ query: "x", [key]: ["y"] } as unknown as SearchParams), (err: unknown) => {
      assert.ok(err instanceof DdbValidationError, key);
      const ch = [...key].find((x) => /[\u200b\u202e\u00ad\u2028]/.test(x))!;
      assert.ok(!err.message.includes(ch), `${JSON.stringify(key)}: raw in ${err.message}`);
      assert.ok(err.message.includes(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`), err.message);
      return true;
    });
  }
});

test("a facet field, the sort and the field list go out trimmed or are refused; never sent raw (Bug 01-2, 2026-10-21)", async () => {
  // `--facet ' type_fct '` went out as `facet.field=%20type_fct%20`: live, HTTP 500
  // `undefined field: " type_fct "`. The sort and the field list were sent raw too.
  const mt = makeMockTransport(() => jsonResponse(fx.solrExact));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "x", facetFields: [" type_fct ", "place_fct\n"], sort: " score desc ", fields: " id , label " });
  const q = queryOf(mt.last());
  assert.deepEqual(q.getAll("facet.field"), ["type_fct", "place_fct"]);
  assert.equal(q.get("sort"), "score desc");
  assert.equal(q.get("fl"), "id,label");
  // A sort clause names a direction; a function with commas inside is one clause.
  await c.search({ query: "x", sort: "sum(a_i,b_i) desc, id ASC" });
  assert.equal(queryOf(mt.last()).get("sort"), "sum(a_i,b_i) desc, id ASC");
  mt.calls.length = 0;
  const refused: Array<[SearchParams, RegExp]> = [
    [{ query: "x", facetFields: ["type​_fct"] }, /^Invalid facetFields entry: "type\\u200b_fct" contains an invisible/],
    [{ query: "x", facetFields: [" "] }, /^Invalid facetFields entry: /],
    [{ query: "x", sort: "score" }, /^Invalid sort: "score": a Solr sort is/],
    [{ query: "x", sort: "score desc," }, /^Invalid sort: /],
    [{ query: "x", fields: "id,,label" }, /^Invalid fields: item 2 of 3: Expected a non-empty value\.$/],
    [{ query: "x", fields: "id,la­bel" }, /^Invalid fields: item 2 of 2: "la\\u00adbel" contains/],
  ];
  for (const [params, message] of refused) {
    await assert.rejects(c.search(params), (err: unknown) => err instanceof DdbValidationError && message.test(err.message), JSON.stringify(params));
  }
  assert.equal(mt.calls.length, 0);
});

test("lang is one of de, en, fr, sent trimmed; anything else is a validation error, never a 404 (Bug 01-1, 2026-10-21)", async () => {
  // `--lang ' de '` went out as `lang=%20de%20` and `--lang DE` as `lang=DE`; upstream answered
  // HTTP 404 "Language < de > is not valid, only <[de, en, fr]> are allowed!", exit 4 ("not
  // found"), which Usage.md and the skill read as "no record in that language".
  const ID = "A".repeat(32);
  const mt = makeMockTransport(() => jsonResponse(fx.itemView));
  const c = new DdbClient({ transport: mt.transport });
  for (const [lang, sent] of [[" de ", "de"], ["en", "en"], ["fr\n", "fr"]] as const) {
    await c.item(ID, "view", { lang });
    assert.equal(queryOf(mt.last()).get("lang"), sent, JSON.stringify(lang));
  }
  mt.calls.length = 0;
  for (const lang of ["DE", "it", "de-DE", "d​e"]) {
    await assert.rejects(c.item(ID, "view", { lang }), (err: unknown) => err instanceof DdbValidationError && /^Invalid lang: /.test(err.message), lang);
  }
  await assert.rejects(c.item(ID, "view", { lang: "DE" }), /Invalid lang: "DE": expected one of: de, en, fr\./);
  assert.equal(mt.calls.length, 0);
  assert.deepEqual([...lib.ITEM_LANGS], ["de", "en", "fr"]);
});
