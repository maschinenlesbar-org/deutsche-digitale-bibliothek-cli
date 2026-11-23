// The use cases (operations.ts) against the recorded answers (ddb.ts), with the skills' traps as
// cases: count with numFound, never by paging; begin_time is a day number, not a year; facets are
// flat [value, count] arrays with zero counts; codes need their meaning; `parents` starts with
// the object and ends with the institution, and can be empty for a part of a work; a view in
// another language can 404; the rights are not where `rights` suggests; iiif and citation exist
// for some objects only; a section's source-record is its volume's; ids are 32 upper-case
// characters, a pasted link works, a lower-cased id is never taken silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient } from "../src/client.js";
import { DdbApiError, DdbValidationError } from "../src/errors.js";
import {
  chunksOf,
  countObjects,
  dateOfDayNumber,
  dayNumberOfYear,
  filterQueries,
  getObject,
  getObjectContext,
  getObjectMedia,
  getObjectRecord,
  hitOf,
  listObjectChildren,
  objectIdFrom,
  requestsOf,
  searchObjects,
} from "../src/operations.js";
import type { HttpRequest } from "../src/http.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";
import { ddbApi, EDM_PRINT, ILLUSTRATION, PRINT, RECORD, SECTION, SERIES, VOLUME } from "./ddb.js";

const clientOf = (mock: ReturnType<typeof ddbApi>) => new DdbClient({ transport: mock.transport, maxRetries: 0 });
const params = (request: HttpRequest | undefined) => new URL(request?.url ?? "http://x/").searchParams;

// ---- day numbers and filters -----------------------------------------------------------------

test("years become the index's day numbers (Python's toordinal() + 1), and back", () => {
  assert.equal(dayNumberOfYear(1810), 660725, "1 Jan 1810, as the skill's print has it");
  assert.equal(dayNumberOfYear(1893), 691041);
  assert.equal(dateOfDayNumber(660725), "1810-01-01");
  assert.equal(dateOfDayNumber(661089), "1810-12-31");
  assert.equal(dateOfDayNumber(714416), "1957-01-01");
  assert.equal(dateOfDayNumber(2), "0001-01-01", "ordinal 1 is day number 2");
  assert.equal(dateOfDayNumber(3_652_060), "9999-12-31");
  assert.equal(dateOfDayNumber(1), undefined);
  assert.equal(dateOfDayNumber("1810"), undefined);
  assert.equal(dateOfDayNumber(0), undefined);
});

test("the friendly filters become Solr filter queries: codes, quoted exact values, a begin_time range of day numbers", () => {
  assert.deepEqual(
    filterQueries({ query: "x", mediaType: "image", sector: "museum", place: 'Berlin "Mitte"', provider: "Stiftung Deutsches Historisches Museum", fromYear: 1900, toYear: 1909, filters: ["language_fct:ger"] }),
    [
      "type_fct:mediatype_002",
      "sector_fct:sec_06",
      'place_fct:"Berlin \\"Mitte\\""',
      'provider_fct:"Stiftung Deutsches Historisches Museum"',
      `begin_time:[${dayNumberOfYear(1900)} TO ${dayNumberOfYear(1910) - 1}]`,
      "language_fct:ger",
    ],
  );
  assert.deepEqual(filterQueries({ query: "x", fromYear: 1810 }), [`begin_time:[660725 TO *]`]);
  assert.deepEqual(filterQueries({ query: "x", toYear: 1810 }), [`begin_time:[2 TO 661089]`], "toYear alone starts at 1 Jan of the year 1, not at *");
  assert.equal(dayNumberOfYear(1), 2);
  assert.throws(() => filterQueries({ query: "x", fromYear: 1910, toYear: 1900 }), /fromYear 1910 is after toYear 1900/);
  assert.throws(() => filterQueries({ query: "x", place: "  " }), DdbValidationError);
  assert.throws(() => filterQueries({ query: "x", mediaType: "photo" as never }), /mediaType: expected one of audio, image/);
});

test("toYear leaves out the records without a usable date, whose begin_time is the index's placeholder 0", async () => {
  // Live (2026-11-22): 56 947 records (archive files dated "o.D.") have begin_time 0 and
  // end_time 364; an open range [* TO day] counted them as objects from before any year asked.
  const mock = makeMockTransport(() => jsonResponse({ response: { numFound: 0, start: 0, docs: [] } }));
  await countObjects(new DdbClient({ transport: mock.transport, maxRetries: 0 }), { query: "*:*", toYear: 1500 });
  const [range] = params(mock.calls[0]).getAll("fq");
  const match = /^begin_time:\[(\S+) TO (\d+)\]$/.exec(range ?? "");
  assert.ok(match !== null, range);
  assert.notEqual(match[1], "*", "an open lower bound takes in begin_time 0");
  assert.ok(Number(match[1]) > 0 && Number(match[1]) <= dayNumberOfYear(1), range);
});

test("a hit whose begin_time is the placeholder 0, or no date at all, shows no date: not half of one", () => {
  const ID = "I44JTUQ7AY3ON2PB7AK6V6AQE4KJ5XHW";
  // Live (2026-11-22): the undated archive files answer begin_time [0], end_time [364].
  assert.equal(hitOf({ id: ID, begin_time: [0], end_time: [364] }).date, undefined, "364 alone would read as 0001-12-29");
  assert.equal(hitOf({ id: ID, begin_time: [-5000], end_time: [660725] }).date, undefined);
  assert.equal(hitOf({ id: ID, begin_time: ["1810"], end_time: [661089] }).date, undefined);
  assert.deepEqual(hitOf({ id: ID, begin_time: [660725], end_time: [661089] }).date, { from: "1810-01-01", to: "1810-12-31" });
  assert.deepEqual(hitOf({ id: ID, end_time: [661089] }).date, { to: "1810-12-31" }, "no begin_time at all: the end is still a date");
});

test("an invisible character in place, provider, objectType or keyword is refused naming that argument, not the raw filters", async () => {
  for (const key of ["place", "provider", "objectType", "keyword"] as const) {
    for (const bad of ["Bau\u202Ehaus", "Bau\u200Bhaus"]) {
      assert.throws(() => filterQueries({ query: "x", [key]: bad }), (err: unknown) => {
        assert.ok(err instanceof DdbValidationError);
        assert.match(err.message, new RegExp(`^Invalid ${key}: .*invisible character \\(U\\+20(2E|0B)\\)`));
        assert.doesNotMatch(err.message, /filters|_fct/);
        return true;
      });
    }
  }
  const mock = ddbApi();
  await assert.rejects(countObjects(clientOf(mock), { query: "x", place: "Bau\u202Ehaus" }), /^DdbValidationError: Invalid place:/);
  assert.equal(mock.calls.length, 0);
});

// ---- searchObjects ---------------------------------------------------------------------------

test("searchObjects: the total is numFound, each hit with its media type in words, its dates and the portal page; no _version_", async () => {
  const mock = ddbApi();
  const answer = await searchObjects(clientOf(mock), { query: " Oktoberfest ", limit: 3 });
  assert.equal(answer.status, "ok");
  assert.equal(answer.total, 1617);
  assert.equal(answer.objects.length, 3);
  assert.deepEqual(answer.objects[0], {
    id: "KE43D2INXYOPHOEEME6T3BEJIMIKTPLU",
    page: "https://www.deutsche-digitale-bibliothek.de/item/KE43D2INXYOPHOEEME6T3BEJIMIKTPLU",
    label: "Oktoberfest",
    mediaType: "text",
    objectTypes: ["Abschnitt (Publikation)", "Fotografie"],
    provider: "Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden",
    date: { from: "1957-01-01", to: "1957-12-31" },
    mediaLicence: "http://rightsstatements.org/vocab/InC/1.0/",
  });
  assert.equal(answer.nextOffset, 3);
  assert.equal(mock.calls.length, 1);
  const sent = params(mock.calls[0]);
  assert.equal(sent.get("q"), "Oktoberfest", "sent trimmed");
  assert.equal(sent.get("rows"), "3");
  assert.equal(sent.get("start"), "0");
  assert.doesNotMatch(sent.get("fl") ?? "", /_version_/);
  assert.deepEqual(requestsOf(answer), [`/search/index/search/select?${new URL(mock.calls[0]?.url ?? "").search.slice(1)}`], "the source is the request as sent");
});

test("searchObjects: a provider filter is an exact quoted value; the archive's records are Akten without media, dated by their day numbers", async () => {
  const mock = ddbApi();
  const answer = await searchObjects(clientOf(mock), { query: "Oktoberfest", provider: "Staatsarchiv München", limit: 2 });
  assert.deepEqual(params(mock.calls[0]).getAll("fq"), ['provider_fct:"Staatsarchiv München"']);
  assert.equal(answer.total, 261);
  assert.deepEqual(answer.objects[0]?.date, { from: "1893-01-01", to: "1893-12-31" });
  assert.equal(answer.objects[0]?.mediaType, "no digitised media (metadata only)");
  assert.deepEqual(answer.objects[0]?.places, ["München, Oktoberfest, Trabrennen", "München, Trabrennen, Oktoberfest"]);
  assert.match(answer.notes.join(" "), /exact value/);
});

test("searchObjects: nothing found is empty with what was searched; a page past the end says so", async () => {
  const none = await searchObjects(clientOf(ddbApi()), { query: "Nichtsda", mediaType: "video" });
  assert.equal(none.status, "empty");
  assert.deepEqual(none.searched, { query: "Nichtsda", filters: ["type_fct:mediatype_005"] });
  assert.match(none.reason ?? "", /Try fewer filters/);
  const past = await searchObjects(clientOf(ddbApi()), { query: "Oktoberfest", offset: 5 });
  assert.equal(past.status, "empty");
  assert.match(past.reason ?? "", /1617 objects match; offset 5 is past the end/);
});

test("searchObjects: a document without a usable id is left out with a note, never a hit with the page …/item/undefined", async () => {
  const GOOD = "KE43D2INXYOPHOEEME6T3BEJIMIKTPLU";
  const docs = [{ label: ["kein id"] }, { id: "lowercase" }, { id: GOOD, label: ["gut"] }, { id: 42 }];
  const mock = makeMockTransport(() => jsonResponse({ response: { numFound: 9, start: 0, docs } }));
  const answer = await searchObjects(new DdbClient({ transport: mock.transport, maxRetries: 0 }), { query: "x", limit: 4 });
  assert.equal(answer.status, "ok");
  assert.deepEqual(answer.objects.map((o) => o.id), [GOOD]);
  assert.ok(answer.objects.every((o) => !o.page.endsWith("/undefined")));
  assert.match(answer.notes.join(" "), /3 of the 4 documents .* no usable id .* left out/);
  assert.equal(answer.nextOffset, 4, "the next page starts after the documents the API sent, the dropped ones too");
  const none = makeMockTransport(() => jsonResponse({ response: { numFound: 9, start: 0, docs: [{ label: ["kein id"] }] } }));
  const empty = await searchObjects(new DdbClient({ transport: none.transport, maxRetries: 0 }), { query: "x", limit: 1 });
  assert.equal(empty.status, "empty");
  assert.match(empty.reason ?? "", /no usable id/);
  assert.equal(empty.nextOffset, 1);
});

test("searchObjects: a bad page size, year or filter is refused before any request", async () => {
  const mock = ddbApi();
  await assert.rejects(searchObjects(clientOf(mock), { query: "x", limit: 51 }), DdbValidationError);
  await assert.rejects(searchObjects(clientOf(mock), { query: "x", fromYear: 0 }), /year from 1 to 2100/);
  await assert.rejects(searchObjects(clientOf(mock), { query: "   " }), DdbValidationError);
  assert.equal(mock.calls.length, 0);
});

// ---- countObjects ----------------------------------------------------------------------------

test("countObjects: rows 0, facets as value/count pairs with zero counts dropped and codes labelled", async () => {
  const mock = ddbApi();
  const answer = await countObjects(clientOf(mock), { query: "Oktoberfest", facets: ["mediaType", "sector", "place"], limit: 10 });
  const sent = params(mock.calls[0]);
  assert.equal(sent.get("rows"), "0", "no documents to count");
  assert.deepEqual(sent.getAll("facet.field"), ["type_fct", "sector_fct", "place_fct"]);
  assert.equal(answer.total, 1617);
  const media = answer.facets[0];
  assert.deepEqual(media?.values.map((v) => [v.value, v.label, v.count]), [
    ["mediatype_007", "no digitised media (metadata only)", 1036],
    ["mediatype_002", "image", 477],
    ["mediatype_003", "text", 100],
    ["mediatype_005", "video", 2],
    ["mediatype_001", "audio", 1],
  ], "mediatype_010 had 0: dropped");
  assert.equal(media?.complete, true);
  assert.deepEqual(answer.facets[1]?.values.map((v) => v.label), ["archive", "museum", "library", "media library", "research"], "sec_03 and sec_07 had 0");
  const places = answer.facets[2];
  assert.equal(places?.values.length, 10);
  assert.equal(places?.complete, false, "ten values for a limit of ten: there may be more");
  assert.equal(places?.values[3]?.value, "München, Oktoberfest", "values as delivered, not merged");
  assert.equal(places?.values[0]?.label, undefined, "a place is no code");
  assert.match(answer.notes.join(" "), /several spellings/);
});

test("countObjects: a facet missing from the answer is not 'no values, complete'; Solr's map form is read as pairs", async () => {
  const answerWith = (facetFields: unknown) =>
    makeMockTransport(() => jsonResponse({ response: { numFound: 1617, start: 0, docs: [] }, facet_counts: { facet_fields: facetFields } }));
  const missing = await countObjects(new DdbClient({ transport: answerWith({ place_fct: ["München", 10] }).transport, maxRetries: 0 }), { query: "x", facets: ["place", "provider"] });
  assert.deepEqual(missing.facets[0]?.values, [{ value: "München", count: 10 }]);
  assert.deepEqual(missing.facets[1]?.values, []);
  assert.equal(missing.facets[1]?.complete, false, "no values listed is not a complete list of none");
  assert.match(missing.notes.join(" "), /provider.*not in the API's answer.*unknown, not none/);
  const mapped = await countObjects(new DdbClient({ transport: answerWith({ place_fct: { München: 10, Berlin: 5, Leer: 0 } }).transport, maxRetries: 0 }), { query: "x", facets: ["place"], limit: 3 });
  assert.deepEqual(mapped.facets[0]?.values, [{ value: "München", count: 10 }, { value: "Berlin", count: 5 }]);
  assert.equal(mapped.facets[0]?.complete, true);
  assert.doesNotMatch(mapped.notes.join(" "), /not in the API's answer/);
  const odd = await countObjects(new DdbClient({ transport: answerWith({ place_fct: "München" }).transport, maxRetries: 0 }), { query: "x", facets: ["place"] });
  assert.equal(odd.facets[0]?.complete, false);
  assert.match(odd.notes.join(" "), /place.*not in the API's answer/);
});

test("countObjects: the total alone without facets; an unknown facet is refused before any request; none is empty", async () => {
  const mock = ddbApi();
  const total = await countObjects(clientOf(mock), { query: "Oktoberfest" });
  assert.equal(total.total, 1617);
  assert.deepEqual(total.facets, []);
  assert.equal(params(mock.calls[0]).get("facet"), null);
  await assert.rejects(countObjects(clientOf(mock), { query: "x", facets: ["state" as never] }), /facet: "state"; expected one of mediaType/);
  assert.equal(mock.calls.length, 1);
  const none = await countObjects(clientOf(ddbApi()), { query: "Nichtsda" });
  assert.equal(none.status, "empty");
});

// ---- getObject -------------------------------------------------------------------------------

test("getObject: the view with its rights where they are (license.resource, the misspelled metdata-rights), the holder and the displayed fields", async () => {
  const mock = ddbApi();
  const answer = await getObject(clientOf(mock), { id: PRINT });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(answer.title, "Oktoberfest 1810");
  assert.equal(answer.identifier, "DE-MUS-319517/GR105655");
  assert.deepEqual(answer.institution, { id: "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463", name: "Stiftung Deutsches Historisches Museum", url: "http://www.dhm.de" });
  assert.deepEqual(answer.rights, { metadata: "http://creativecommons.org/publicdomain/zero/1.0/", media: "http://creativecommons.org/licenses/by-nc-nd/4.0/" }, "the empty `rights` left out");
  assert.equal(answer.sourcePage, "https://db.dhm.de/objekt/GR105655");
  assert.deepEqual(answer.fields.find((f) => f.name === "(wer)")?.values, ["Zeichner: Peter von Hess", "Stecher: ? Weller"]);
  assert.equal(answer.fields.some((f) => f.name === "Title"), false, "index fields are not displayed ones");
  assert.equal(answer.viewers, undefined, "an empty viewer list is left out");
  assert.match(answer.notes.join(" "), /media carry their own rights/);
});

test("getObject: a link to the object page works; a lower-cased id is refused with its upper-case form, never taken", async () => {
  const mock = ddbApi();
  const linked = await getObject(clientOf(mock), { id: `https://www.deutsche-digitale-bibliothek.de/item/${PRINT}?lang=de` });
  assert.equal(linked.status, "ok");
  assert.equal(objectIdFrom(`https://api.deutsche-digitale-bibliothek.de/2/items/${PRINT}/view`), PRINT);
  await assert.rejects(getObject(clientOf(mock), { id: PRINT.toLowerCase() }), new RegExp(`try "${PRINT}"`));
  assert.equal(mock.calls.length, 1);
});

test("getObject: a view in English answers 404; the default view is given with a note, not 'unknown id'", async () => {
  const mock = ddbApi();
  const answer = await getObject(clientOf(mock), { id: PRINT, lang: "en" });
  assert.equal(answer.status, "ok");
  assert.match(answer.notes[0] ?? "", /no view in "en" \(HTTP 404\)/);
  assert.equal(mock.calls.length, 2);
  assert.equal(params(mock.calls[0]).get("lang"), "en");
  assert.equal(params(mock.calls[1]).get("lang"), null);
  assert.deepEqual(requestsOf(answer), [`/items/${PRINT}/view?lang=en`, `/items/${PRINT}/view`]);
});

test("getObject: an unknown id is empty with what to do, not a bare error; other failures stay errors", async () => {
  const answer = await getObject(clientOf(ddbApi()), { id: "A".repeat(32) });
  assert.equal(answer.status, "empty");
  assert.match(answer.status === "empty" ? answer.reason : "", /No DDB object has the id A{32}.*fresh searchObjects/);
  const failing = new DdbClient({ transport: makeMockTransport(() => jsonResponse({ error: "boom" }, 500)).transport, maxRetries: 0 });
  await assert.rejects(getObject(failing, { id: PRINT }), DdbApiError);
});

// ---- hierarchy and media ---------------------------------------------------------------------

test("getObjectContext: the object itself is skipped, the institution is the holder, not a parent", async () => {
  const single = await getObjectContext(clientOf(ddbApi()), { id: PRINT });
  assert.equal(single.status, "ok");
  assert.deepEqual(single.partOf, []);
  assert.equal(single.heldBy?.label, "Stiftung Deutsches Historisches Museum");
  assert.equal(single.heldBy?.type, "institution");
  assert.match(single.notes.join(" "), /single object/);
  const archival = await getObjectContext(clientOf(ddbApi()), { id: RECORD });
  assert.deepEqual(archival.partOf.map((e) => e.label), ["Oktoberfest in München", "Veranstaltungsplakate", "Plakatsammlung", "V. Sammlungsgut / Dokumentationen", "Staatsarchiv München (Archivtektonik)"]);
  assert.equal(archival.heldBy?.label, "Staatsarchiv München");
});

test("getObjectContext: the chain can end in two institutions (a library and the foundation it belongs to): the nearest holds it, the other is not a parent record", async () => {
  const answer = await getObjectContext(clientOf(ddbApi()), { id: ILLUSTRATION });
  assert.deepEqual(answer.partOf.map((e) => e.label), ["Tome Premier", "Mémoires De Goethe"]);
  assert.equal(answer.heldBy?.label, "Staatsbibliothek zu Berlin - Preußischer Kulturbesitz");
  assert.deepEqual(answer.holderBelongsTo?.map((e) => e.label), ["Stiftung Preußischer Kulturbesitz"]);
  const single = await getObjectContext(clientOf(ddbApi()), { id: PRINT });
  assert.equal(single.holderBelongsTo, undefined, "one institution: nothing above it");
});

test("getObjectContext: an empty chain is not 'part of nothing': it says where the holder and the containing work are", async () => {
  const answer = await getObjectContext(clientOf(ddbApi()), { id: SECTION });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /doesn't mean it is part of nothing.*getObject.*source-record/);
});

test("listObjectChildren: a page of children with the total and the next offset", async () => {
  const mock = ddbApi();
  const answer = await listObjectChildren(clientOf(mock), { id: SERIES, limit: 2 });
  assert.equal(answer.total, 100);
  assert.deepEqual(answer.children.map((c) => c.label), ["Bekanntmachung. Oktoberfest 1921", "Bekanntmachung. Oktoberfest 1895 betr."]);
  assert.deepEqual(answer.children[0], { id: "Q4WVE5KVBVO25ZVTJZ6N4PAKWTVCK6GT", label: "Bekanntmachung. Oktoberfest 1921", type: "htype_034", leaf: true, position: "01248" });
  assert.equal(answer.nextOffset, 2);
  assert.equal(params(mock.calls[0]).get("rows"), "2");
  assert.equal(params(mock.calls[0]).get("offset"), "0");
  const leaf = await listObjectChildren(clientOf(ddbApi()), { id: PRINT });
  assert.equal(leaf.status, "empty");
  assert.match(leaf.reason ?? "", /no children/);
});

test("getObjectMedia: each file with its own licence and credit line; links only", async () => {
  const answer = await getObjectMedia(clientOf(ddbApi()), { id: PRINT });
  assert.equal(answer.status, "ok");
  assert.deepEqual(answer.files, [
    {
      name: "Oktoberfest 1810",
      credit: "Urheber*in: Hess, Peter von; Weller, ? (Herstellung) / Rechtewahrnehmung: Deutsches Historisches Museum",
      mimeType: "image/jpeg",
      primary: true,
      url: "https://objekt.db.dhm.de/GR105655/download/large_without_watermark",
      licence: "http://creativecommons.org/licenses/by-nc-nd/4.0/",
      licenceGroup: "rights_002",
    },
  ]);
  assert.match(answer.notes.join(" "), /nothing is downloaded/);
});

// ---- getObjectRecord -------------------------------------------------------------------------

test("getObjectRecord: the EDM as XML in chunks that join to the whole record, a page at a time", async () => {
  const first = await getObjectRecord(clientOf(ddbApi()), { id: PRINT, part: "edm", limit: 2 });
  assert.equal(first.status, "ok");
  assert.equal(first.format, "xml");
  assert.ok(first.totalChunks > 2);
  assert.equal(first.nextOffset, 2);
  assert.ok(first.chunks.every((c) => c.length <= 1800));
  const rest = await getObjectRecord(clientOf(ddbApi()), { id: PRINT, part: "edm", offset: 2, limit: 12 });
  assert.equal(rest.nextOffset, undefined);
  assert.equal([...first.chunks, ...rest.chunks].join("\n").replace(/\n/g, ""), EDM_PRINT.replace(/\n/g, ""));
});

test("getObjectRecord: a section's source-record is its volume's whole record, and says so", async () => {
  const answer = await getObjectRecord(clientOf(ddbApi()), { id: SECTION, part: "source-record" });
  assert.equal(answer.heldBy, VOLUME);
  assert.match(answer.notes[0] ?? "", new RegExp(`no source-record of its own: this is the whole source-record of its ancestor ${VOLUME}`));
  assert.deepEqual(requestsOf(answer), [`/items/${SECTION}/source/record`, `/items/${VOLUME}/source/record`]);
});

test("getObjectRecord: a 404 for iiif means no manifest, not a bad id; a part with its own tool is refused", async () => {
  const answer = await getObjectRecord(clientOf(ddbApi()), { id: PRINT, part: "iiif" });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /has no IIIF manifest.*says nothing about the id/);
  await assert.rejects(getObjectRecord(clientOf(ddbApi()), { id: PRINT, part: "view" as never }), /part: expected one of edm/);
});

test("chunksOf cuts at line ends, else after a tag, else hard, never inside a surrogate pair", () => {
  assert.deepEqual(chunksOf("ab\ncd\nef", 5), ["ab\ncd", "ef"]);
  assert.deepEqual(chunksOf("<a><b>", 4), ["<a>", "<b>"]);
  assert.deepEqual(chunksOf("abcdefg", 3), ["abc", "def", "g"]);
  assert.deepEqual(chunksOf("ab😀cd", 3), ["ab", "😀c", "d"]);
});
