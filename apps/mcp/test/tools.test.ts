// This server's tools against a mock of the DDB v2 API (the client's live answers of 2026-11-19),
// with the skills' traps as cases: each tool answers through the protocol (its structuredContent
// checked by the SDK against its output schema), the source is the request as sent (a view in
// another language names both requests), counts come from numFound and facets without zeros,
// years go out as day numbers, the rights are where they really are, the holder is no parent,
// an empty hierarchy and a missing manifest are said in words, records come in chunks, and every
// result carries the CC0 licence with the media caveat. The rules every server follows are the
// conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { dayNumberOfYear } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client";
import { ddbApi, PRINT, RECORD, SECTION, SERIES, VOLUME } from "./helpers.js";

const API = "https://api.deutsche-digitale-bibliothek.de/2";

test("seven tools: the search use cases, the object use cases, then any other component", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["searchObjects", "countObjects", "getObject", "getObjectContext", "listObjectChildren", "getObjectMedia", "getObjectRecord"]);
});

test("searchObjects: hits with the media type in words and dates; the source is the request as sent; the CC0 licence with the media caveat", async () => {
  const transport = ddbApi();
  const connection = await connect({ transport });
  const result = await connection.call("searchObjects", { query: "Oktoberfest", limit: 3 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal(content["total"], 1617);
  assert.equal(content["nextOffset"], 3);
  const [hit] = content["objects"] as { id: string; mediaType: string; date: unknown }[];
  assert.equal(hit?.mediaType, "text");
  assert.deepEqual(hit?.date, { from: "1957-01-01", to: "1957-12-31" });
  assert.equal(content["source"], transport.calls[0]?.url);
  assert.match(String(content["licence"]), /^Metadata: CC0 1\.0 \(Deutsche Digitale Bibliothek\).*not covered.*DATA_LICENSE\.md$/);
  await connection.close();
});

test("searchObjects: years go out as begin_time day numbers, filters as exact quoted values", async () => {
  const transport = ddbApi();
  const connection = await connect({ transport });
  const result = await connection.call("searchObjects", { query: "Oktoberfest", provider: "Staatsarchiv München", fromYear: 1890, toYear: 1899, mediaType: "none" });
  const fq = new URL(transport.calls[0]?.url ?? "").searchParams.getAll("fq");
  assert.deepEqual(fq, ["type_fct:mediatype_007", 'provider_fct:"Staatsarchiv München"', `begin_time:[${dayNumberOfYear(1890)} TO ${dayNumberOfYear(1900) - 1}]`]);
  assert.equal(result.structuredContent?.["status"], "empty", "the mock knows no such search: what was searched is said");
  assert.deepEqual((result.structuredContent?.["searched"] as { filters: string[] }).filters, fq);
  assert.match((result.structuredContent?.["notes"] as string[]).join(" "), /begin_time.*without a date is left out/);
  await connection.close();
});

test("countObjects: the total and facets as value/count pairs, zero counts dropped, codes labelled", async () => {
  const connection = await connect({ transport: ddbApi() });
  const content = (await connection.call("countObjects", { query: "Oktoberfest", facets: ["mediaType", "provider"], limit: 5 })).structuredContent ?? {};
  assert.equal(content["total"], 1617);
  const [media, provider] = content["facets"] as { name: string; values: { value: string; label?: string; count: number }[] }[];
  assert.deepEqual(media?.values.map((v) => v.label), ["no digitised media (metadata only)", "image", "text", "video", "audio"]);
  assert.deepEqual(provider?.values[0], { value: "Stiftung Deutsches Historisches Museum", count: 286 });
  const bad = await connection.call("countObjects", { query: "Oktoberfest", facets: ["state"] });
  assert.equal(bad.isError, true, "no federal-state facet");
  await connection.close();
});

test("getObject: the rights where they are, the holder, a link as the id; a view in English falls back, naming both requests", async () => {
  const transport = ddbApi();
  const connection = await connect({ transport });
  const content = (await connection.call("getObject", { id: `https://www.deutsche-digitale-bibliothek.de/item/${PRINT}`, lang: "en" })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual(content["rights"], { metadata: "http://creativecommons.org/publicdomain/zero/1.0/", media: "http://creativecommons.org/licenses/by-nc-nd/4.0/" });
  assert.equal((content["institution"] as { name: string }).name, "Stiftung Deutsches Historisches Museum");
  assert.match((content["notes"] as string[])[0] ?? "", /no view in "en"/);
  assert.equal(content["source"], `${API}/{items/${PRINT}/view?lang=en,items/${PRINT}/view}`);
  const unknown = (await connection.call("getObject", { id: "A".repeat(32) })).structuredContent ?? {};
  assert.equal(unknown["status"], "empty");
  assert.match(String(unknown["reason"]), /No DDB object has the id/);
  const lower = await connection.call("getObject", { id: PRINT.toLowerCase() });
  assert.equal(lower.isError, true);
  assert.match(lower.content[0]?.text ?? "", new RegExp(`try "${PRINT}"`));
  await connection.close();
});

test("getObjectContext: the holder is no parent; an empty hierarchy says where to look", async () => {
  const connection = await connect({ transport: ddbApi() });
  const archival = (await connection.call("getObjectContext", { id: RECORD })).structuredContent ?? {};
  assert.equal((archival["partOf"] as unknown[]).length, 5);
  assert.equal((archival["heldBy"] as { label: string }).label, "Staatsarchiv München");
  assert.equal(archival["source"], `${API}/items/${RECORD}/parents`);
  const section = (await connection.call("getObjectContext", { id: SECTION })).structuredContent ?? {};
  assert.equal(section["status"], "empty");
  assert.match(String(section["reason"]), /source-record/);
  await connection.close();
});

test("listObjectChildren pages: total, a page, nextOffset", async () => {
  const transport = ddbApi();
  const connection = await connect({ transport });
  const content = (await connection.call("listObjectChildren", { id: SERIES, offset: 1, limit: 2 })).structuredContent ?? {};
  assert.equal(content["total"], 100);
  assert.deepEqual((content["children"] as { id: string }[]).map((c) => c.id), ["PWKS2K7L7GTUPAYCZLFBQKDZILIDJIW6", "OBO7MWSO3UKYR564FSZDBEBZOV4WHO6Q"]);
  assert.equal(content["nextOffset"], 3);
  assert.equal(content["source"], `${API}/items/${SERIES}/children?rows=2&offset=1`);
  await connection.close();
});

test("getObjectMedia: each file with its licence and credit line", async () => {
  const connection = await connect({ transport: ddbApi() });
  const content = (await connection.call("getObjectMedia", { id: PRINT })).structuredContent ?? {};
  const [file] = content["files"] as { licence: string; credit: string; url: string }[];
  assert.equal(file?.licence, "http://creativecommons.org/licenses/by-nc-nd/4.0/");
  assert.match(file?.credit ?? "", /Rechtewahrnehmung: Deutsches Historisches Museum/);
  await connection.close();
});

test("getObjectRecord: EDM in chunks a page at a time; a section's source-record is its volume's; no manifest is empty, not an error", async () => {
  const connection = await connect({ transport: ddbApi() });
  const edm = (await connection.call("getObjectRecord", { id: PRINT, part: "edm", limit: 2 })).structuredContent ?? {};
  assert.equal(edm["format"], "xml");
  assert.equal((edm["chunks"] as string[]).length, 2);
  assert.equal(edm["nextOffset"], 2);
  const held = (await connection.call("getObjectRecord", { id: SECTION, part: "source-record" })).structuredContent ?? {};
  assert.equal(held["heldBy"], VOLUME);
  assert.equal(held["source"], `${API}/{items/${SECTION}/source/record,items/${VOLUME}/source/record}`);
  const iiif = await connection.call("getObjectRecord", { id: PRINT, part: "iiif" });
  assert.notEqual(iiif.isError, true);
  assert.equal(iiif.structuredContent?.["status"], "empty");
  const view = await connection.call("getObjectRecord", { id: PRINT, part: "view" });
  assert.equal(view.isError, true, "the view has its own tool");
  await connection.close();
});
