import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient } from "../src/client/client.js";
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

test("item forwards lang for view but not for parents; children takes rows/offset", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });

  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "view", { lang: "en" });
  assert.equal(queryOf(mt.last()).get("lang"), "en");

  await c.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "parents", { lang: "en" });
  assert.equal(queryOf(mt.last()).get("lang"), null);

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
