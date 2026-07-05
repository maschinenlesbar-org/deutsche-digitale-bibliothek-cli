import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient } from "../src/client/client.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function pathOf(url: string): string {
  return new URL(url).pathname;
}

test("search hits /search and forwards query, rows, offset, sort", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "Goethe", rows: 10, offset: 20, sort: "ALPHA_ASC" });
  const req = mt.last();
  assert.equal(pathOf(req.url), "/search");
  const q = queryOf(req);
  assert.equal(q.get("query"), "Goethe");
  assert.equal(q.get("rows"), "10");
  assert.equal(q.get("offset"), "20");
  assert.equal(q.get("sort"), "ALPHA_ASC");
});

test("search forwards repeated --facet and facet.limit", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*", facet: ["type_fct", "place_fct"], facetLimit: 5 });
  const q = queryOf(mt.last());
  assert.deepEqual(q.getAll("facet"), ["type_fct", "place_fct"]);
  assert.equal(q.get("facet.limit"), "5");
});

test("search forwards facet-value filters as query params (repeated keys)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*", filters: { place_fct: ["Berlin", "München"], type_fct: ["Bild"] } });
  const q = queryOf(mt.last());
  assert.deepEqual(q.getAll("place_fct"), ["Berlin", "München"]);
  assert.equal(q.get("type_fct"), "Bild");
});

test("a core parameter is never clobbered by a colliding filter key", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport });
  // A filter that (mischievously) reuses the `query` key must not override the
  // real query term.
  await c.search({ query: "Goethe", filters: { query: ["evil"] } });
  assert.equal(queryOf(mt.last()).get("query"), "Goethe");
});

test("the API key is sent as an OAuth Authorization header", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport, apiKey: "SECRET" });
  await c.search({ query: "*" });
  assert.equal(mt.last().headers?.["Authorization"], 'OAuth oauth_consumer_key="SECRET"');
});

test("no Authorization header is sent when no key is supplied", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.search));
  const c = new DdbClient({ transport: mt.transport });
  await c.search({ query: "*" });
  assert.equal(mt.last().headers?.["Authorization"], undefined);
});

test("item defaults to the view component", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.itemView));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF");
  assert.equal(pathOf(mt.last().url), "/items/OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF/view");
});

test("item with part=aip hits the bare item endpoint", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "aip");
  assert.equal(pathOf(mt.last().url), "/items/OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF");
});

test("item with part=edm hits the edm sub-endpoint", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const c = new DdbClient({ transport: mt.transport });
  await c.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "edm");
  assert.equal(pathOf(mt.last().url), "/items/OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF/edm");
});

test("facets lists available facet fields", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.facetsList));
  const c = new DdbClient({ transport: mt.transport });
  await c.facets();
  assert.equal(pathOf(mt.last().url), "/search/facets");
});

test("facetValues hits /search/facets/{name} and scopes with query", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.facetValues));
  const c = new DdbClient({ transport: mt.transport });
  await c.facetValues("place_fct", { query: "Goethe" });
  assert.equal(pathOf(mt.last().url), "/search/facets/place_fct");
  assert.equal(queryOf(mt.last()).get("query"), "Goethe");
});

test("institutions forwards hasItems and sector", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.institutions));
  const c = new DdbClient({ transport: mt.transport });
  await c.institutions({ hasItems: true, sector: "sec_06" });
  assert.equal(pathOf(mt.last().url), "/institutions");
  const q = queryOf(mt.last());
  assert.equal(q.get("hasItems"), "true");
  assert.equal(q.get("sector"), "sec_06");
});

test("version reads the plain-text /version endpoint", async () => {
  const mt = makeMockTransport(() => rawResponse("5.6.7\n", "text/plain"));
  const c = new DdbClient({ transport: mt.transport });
  assert.equal(await c.version(), "5.6.7\n");
  assert.equal(pathOf(mt.last().url), "/version");
});
