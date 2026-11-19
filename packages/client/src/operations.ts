// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's tools, a
// library user) has to know them:
// - searchObjects and countObjects (ddb-search): objects for a query and friendly filters (media
//   type, sector, place, provider, years), a page at a time; and how many match, with facet
//   distributions as value/count pairs, zero counts dropped and codes labelled;
// - getObject, getObjectContext, listObjectChildren, getObjectMedia (ddb-item): one object's
//   view with its rights where they really are, what it is part of and who holds it, its
//   children a page at a time, its media files with each file's licence;
// - getObjectRecord: any other component (EDM, the provider's record, IIIF, …) as text, a page
//   of chunks at a time, for what those don't reach.
//
// The rules they keep: no bare "not found" (an empty answer says what was searched and what to
// try); the traps are answered, not left to the caller (begin_time is a day number, facets hold
// zeros, `parents` lists the object itself and the institution, a `lang` view can 404, the
// metadata licence key is misspelled upstream); each answer is a named type (public API of the
// CLI package: a changed shape is a `feat(client)!:` commit); every request an answer made is
// kept (`requestsOf(answer)`), for the answer's source.

import { itemComponentPath, searchRequest, type DdbClient } from "./client.js";
import { DdbApiError, DdbValidationError } from "./errors.js";
import { buildQueryString, type QueryParams } from "./query.js";
import type { ItemPart, ItemResult, JsonObject, JsonValue, SearchParams, SolrDoc } from "./types.js";
import { assertValid, langProblem, normalizeItemId, normalizeToken } from "./validate.js";

// ---- the requests an answer made -------------------------------------------------------------

const REQUESTS = new WeakMap<object, readonly string[]>();

/**
 * The requests (path and query under the base URL, no host) the operation that returned `answer`
 * made, in order: what its `source` names. Empty for an object no operation returned.
 */
export function requestsOf(answer: object): readonly string[] {
  return REQUESTS.get(answer) ?? [];
}

/** The requests of one operation call. */
class Trace {
  readonly paths: string[] = [];

  note(path: string, query: QueryParams = {}): void {
    const qs = buildQueryString(query);
    this.paths.push(qs === "" ? path : `${path}?${qs}`);
  }

  done<T extends object>(answer: T): T {
    REQUESTS.set(answer, [...this.paths]);
    return answer;
  }
}

// ---- codes and day numbers -------------------------------------------------------------------

/** The media types (`type_fct`), by the name the tools take; labelled from sampled objects (2026-09-15). */
export const MEDIA_TYPES = Object.freeze({
  audio: "mediatype_001",
  image: "mediatype_002",
  text: "mediatype_003",
  video: "mediatype_005",
  none: "mediatype_007",
  "3d": "mediatype_010",
} as const);
export type MediaType = keyof typeof MEDIA_TYPES;

/** The cultural sectors (`sector_fct`), by the name the tools take. */
export const SECTORS = Object.freeze({
  archive: "sec_01",
  library: "sec_02",
  monument: "sec_03",
  research: "sec_04",
  media: "sec_05",
  museum: "sec_06",
  other: "sec_07",
} as const);
export type Sector = keyof typeof SECTORS;

/** What a media-type or sector code means, in words. */
const CODE_LABELS: Record<string, string> = {
  mediatype_001: "audio",
  mediatype_002: "image",
  mediatype_003: "text",
  mediatype_005: "video",
  mediatype_007: "no digitised media (metadata only)",
  mediatype_010: "3D model",
  sec_01: "archive",
  sec_02: "library",
  sec_03: "monument protection",
  sec_04: "research",
  sec_05: "media library",
  sec_06: "museum",
  sec_07: "other",
};

/** A code's meaning in words, or undefined for a value that isn't a known code. */
export function codeLabel(code: string): string | undefined {
  return CODE_LABELS[code];
}

/** The facets the tools count, by name: the Solr field each one is. No state or time facet exists. */
export const FACETS = Object.freeze({
  mediaType: "type_fct",
  objectType: "objecttype_fct",
  place: "place_fct",
  provider: "provider_fct",
  sector: "sector_fct",
  language: "language_fct",
  keyword: "keywords_fct",
  mimeType: "mimetype_fct",
} as const);
export type FacetName = keyof typeof FACETS;

/** Days between Python's date ordinal 1 (0001-01-01) and 1970-01-01. */
const ORDINAL_1970 = 719_163;
const DAY_MS = 86_400_000;

/**
 * The index's day number of 1 January of `year` (proleptic Gregorian): `begin_time` and
 * `end_time` hold Python's `date.toordinal()` + 1, not years (1 Jan 1810 is 660725), so
 * `begin_time:[1900 TO 1909]` matched nothing without an error.
 */
export function dayNumberOfYear(year: number): number {
  const p = year - 1;
  return 365 * p + Math.floor(p / 4) - Math.floor(p / 100) + Math.floor(p / 400) + 2;
}

/** A day number of `begin_time`/`end_time` as an ISO date (`1893-01-01`), or undefined if it isn't one. */
export function dateOfDayNumber(day: unknown): string | undefined {
  if (typeof day !== "number" || !Number.isSafeInteger(day) || day < 2 || day > 3_652_060) return undefined;
  const date = new Date((day - 1 - ORDINAL_1970) * DAY_MS);
  const year = date.getUTCFullYear();
  const yyyy = year >= 0 && year <= 9999 ? String(year).padStart(4, "0") : String(year);
  return `${yyyy}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** The earliest and latest year the year filters take. */
export const MIN_YEAR = 1;
export const MAX_YEAR = 2100;

// ---- object ids ------------------------------------------------------------------------------

/**
 * An object id from what a user pastes: the 32-character id, or a link to a DDB object page
 * (`…/item/<id>`) or to the API (`…/items/<id>/…`), whose id segment is taken. The id is then
 * checked as the client checks it (32 upper-case letters and digits; a lower-cased one gets its
 * upper-case form suggested, never taken silently: ids are case sensitive).
 */
export function objectIdFrom(input: string): string {
  if (typeof input !== "string") return normalizeItemId(input);
  const text = input.trim();
  const linked = /\/items?\/([A-Za-z0-9]{32})(?:[/?#]|$)/.exec(text);
  return normalizeItemId(linked?.[1] ?? text);
}

/** The object's page on the DDB portal. */
export const objectPage = (id: string): string => `https://www.deutsche-digitale-bibliothek.de/item/${id}`;

// ---- search ----------------------------------------------------------------------------------

/** The filters a search or a count takes: the query, the friendly filters, and raw Solr filters. */
export interface ObjectFilters {
  /** The Solr query (`q`): words, "phrases", AND/OR/NOT, `field:value`; `*:*` matches everything. */
  query: string;
  mediaType?: MediaType | undefined;
  sector?: Sector | undefined;
  /** A place as the index spells it ("München", "Berlin"); exact, not a prefix. */
  place?: string | undefined;
  /** A contributing institution as the index spells it ("Staatsarchiv München"). */
  provider?: string | undefined;
  /** An object type ("Fotografie", "Akten"). */
  objectType?: string | undefined;
  /** A language code as the index has it (ISO 639-2: "ger", "eng", "lat"). */
  language?: string | undefined;
  /** A subject keyword. */
  keyword?: string | undefined;
  /** Objects whose date range starts in this year or later (begin_time). */
  fromYear?: number | undefined;
  /** Objects whose date range starts in this year or earlier (begin_time). */
  toYear?: number | undefined;
  /** Raw Solr filter queries (`fq`), ANDed, for what the friendly filters don't reach. */
  filters?: string[] | undefined;
}

/** What a search or count was asked: the filters as given, and the Solr filter queries sent. */
export interface ObjectSearched {
  query: string;
  filters: string[];
}

/** A value in a Solr phrase: quotes and backslashes escaped. */
const phrase = (value: string): string => `"${value.trim().normalize("NFC").replace(/[\\"]/g, (c) => `\\${c}`)}"`;

function yearOf(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < MIN_YEAR || value > MAX_YEAR) {
    throw new DdbValidationError(`Invalid ${name}: expected a year from ${MIN_YEAR} to ${MAX_YEAR}, got ${String(value)}.`);
  }
  return value;
}

/** The Solr filter queries of `input`'s friendly and raw filters, checked before any request. */
export function filterQueries(input: ObjectFilters): string[] {
  const fq: string[] = [];
  if (input.mediaType !== undefined) {
    const code = MEDIA_TYPES[input.mediaType];
    if (code === undefined) throw new DdbValidationError(`Invalid mediaType: expected one of ${Object.keys(MEDIA_TYPES).join(", ")}.`);
    fq.push(`type_fct:${code}`);
  }
  if (input.sector !== undefined) {
    const code = SECTORS[input.sector];
    if (code === undefined) throw new DdbValidationError(`Invalid sector: expected one of ${Object.keys(SECTORS).join(", ")}.`);
    fq.push(`sector_fct:${code}`);
  }
  const fields: [keyof ObjectFilters, string][] = [
    ["place", "place_fct"],
    ["provider", "provider_fct"],
    ["objectType", "objecttype_fct"],
    ["language", "language_fct"],
    ["keyword", "keywords_fct"],
  ];
  for (const [key, field] of fields) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") throw new DdbValidationError(`Invalid ${key}: expected a non-empty string.`);
    fq.push(`${field}:${phrase(value)}`);
  }
  const from = yearOf("fromYear", input.fromYear);
  const to = yearOf("toYear", input.toYear);
  if (from !== undefined && to !== undefined && from > to) {
    throw new DdbValidationError(`Invalid years: fromYear ${from} is after toYear ${to}.`);
  }
  if (from !== undefined || to !== undefined) {
    const lo = from === undefined ? "*" : String(dayNumberOfYear(from));
    const hi = to === undefined ? "*" : String(dayNumberOfYear(to + 1) - 1);
    fq.push(`begin_time:[${lo} TO ${hi}]`);
  }
  for (const raw of input.filters ?? []) fq.push(raw);
  return fq;
}

/** Notes every answer of a search or count with these filters carries. */
function filterNotes(input: ObjectFilters): string[] {
  const notes: string[] = [];
  if (input.fromYear !== undefined || input.toYear !== undefined) {
    notes.push("The years filter on begin_time, the start of an object's date range: an object without a date is left out.");
  }
  if (input.place !== undefined || input.provider !== undefined || input.objectType !== undefined || input.keyword !== undefined) {
    notes.push("Place, provider, object type and keyword match the index's exact value (as countObjects lists them), not a part of it.");
  }
  return notes;
}

/** The fields a search asks for: what a hit shows (no `_version_`, Solr's internal document version). */
const HIT_FIELDS = "id,label,title,type_fct,objecttype,provider,place_fct,begin_time,end_time,license";

/** One object a search found. */
export interface ObjectHit {
  id: string;
  label?: string;
  /** The media type in words (type_fct). */
  mediaType?: string;
  objectTypes?: string[];
  provider?: string;
  places?: string[];
  /** The date range (begin_time/end_time as dates). */
  date?: { from?: string; to?: string };
  /** The media's licence (a rights URI); the metadata are CC0. */
  mediaLicence?: string;
  /** The object's page on the DDB portal. */
  page: string;
}

const strings = (value: JsonValue | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
const first = (value: JsonValue | undefined): string | undefined => strings(value)[0];
const firstNumber = (value: JsonValue | undefined): number | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "number" ? v : undefined;
};

/** A search document as a hit: its label, codes in words, day numbers as dates. */
export function hitOf(doc: SolrDoc): ObjectHit {
  const hit: ObjectHit = { id: doc.id, page: objectPage(doc.id) };
  const label = first(doc["label"]) ?? first(doc["title"]);
  if (label !== undefined) hit.label = label;
  const type = first(doc["type_fct"]);
  if (type !== undefined) hit.mediaType = codeLabel(type) ?? type;
  const objectTypes = strings(doc["objecttype"]);
  if (objectTypes.length > 0) hit.objectTypes = objectTypes;
  const provider = first(doc["provider"]);
  if (provider !== undefined) hit.provider = provider;
  const places = strings(doc["place_fct"]);
  if (places.length > 0) hit.places = places;
  const from = dateOfDayNumber(firstNumber(doc["begin_time"]));
  const to = dateOfDayNumber(firstNumber(doc["end_time"]));
  if (from !== undefined || to !== undefined) hit.date = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
  const licence = first(doc["license"]);
  if (licence !== undefined) hit.mediaLicence = licence;
  return hit;
}

/** Default and largest page of {@link searchObjects}. */
export const DEFAULT_OBJECTS = 10;
export const MAX_OBJECTS = 50;

/** The input of {@link searchObjects}. */
export interface SearchObjectsInput extends ObjectFilters {
  /** Where the page starts (Solr start, default 0). */
  offset?: number | undefined;
  /** Objects per page (1–50, default 10). */
  limit?: number | undefined;
}

/** The answer of {@link searchObjects}. */
export interface ObjectSearch {
  status: "ok" | "empty";
  searched: ObjectSearched;
  /** How many objects match (numFound): read this to count, never page everything. */
  total: number;
  offset: number;
  objects: ObjectHit[];
  /** Where the next page starts, when there is one. */
  nextOffset?: number;
  reason?: string;
  notes: string[];
}

function pageSize(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new DdbValidationError(`Invalid ${name}: expected an integer from 1 to ${max}, got ${String(value)}.`);
  }
  return value;
}

/** Search with the request kept for the answer's source. */
async function traced(client: DdbClient, trace: Trace, params: SearchParams) {
  const { path, query } = searchRequest(params);
  trace.note(path, query);
  return client.search(params);
}

/**
 * Objects for a query and filters, a page at a time: each with its label, media type in words,
 * object types, provider, places, date range (from the day numbers) and media licence. The total
 * is the index's count (numFound); none found is `empty` with what was searched.
 */
export async function searchObjects(client: DdbClient, input: SearchObjectsInput): Promise<ObjectSearch> {
  const trace = new Trace();
  const filters = filterQueries(input);
  const limit = pageSize("limit", input.limit, DEFAULT_OBJECTS, MAX_OBJECTS);
  const offset = input.offset ?? 0;
  const searched: ObjectSearched = { query: input.query, filters };
  const answer = await traced(client, trace, { query: input.query, rows: limit, start: offset, fields: HIT_FIELDS, ...(filters.length > 0 ? { filters } : {}) });
  const total = answer.response.numFound;
  const objects = answer.response.docs.map(hitOf);
  const notes = filterNotes(input);
  const result: ObjectSearch = { status: objects.length > 0 ? "ok" : "empty", searched, total, offset, objects, notes };
  if (offset + objects.length < total && objects.length > 0) result.nextOffset = offset + objects.length;
  if (objects.length === 0) {
    result.reason =
      total > 0
        ? `${total} objects match; offset ${offset} is past the end.`
        : "No object matches the query with these filters. Try fewer filters or other words; place, provider and object type need the index's exact spelling (countObjects lists the values).";
  }
  return trace.done(result);
}

// ---- counts and distributions ----------------------------------------------------------------

/** Default and largest number of values per facet in {@link countObjects}. */
export const DEFAULT_FACET_VALUES = 10;
export const MAX_FACET_VALUES = 100;

/** One value of a facet with its count; a code (media type, sector) with its meaning. */
export interface FacetValue {
  value: string;
  label?: string;
  count: number;
}

/** One facet's distribution: its values by count, zero counts dropped. */
export interface FacetCount {
  name: FacetName;
  field: string;
  values: FacetValue[];
  /** False when the facet may hold more values than listed (the limit was reached). */
  complete: boolean;
}

/** The input of {@link countObjects}. */
export interface CountObjectsInput extends ObjectFilters {
  /** The distributions to count (none: the total only). */
  facets?: FacetName[] | undefined;
  /** Values per facet (1–100, default 10), the largest counts first. */
  limit?: number | undefined;
}

/** The answer of {@link countObjects}. */
export interface ObjectCount {
  status: "ok" | "empty";
  searched: ObjectSearched;
  total: number;
  facets: FacetCount[];
  reason?: string;
  notes: string[];
}

/**
 * How many objects match, and how they spread over facets: Solr's flat `[value, count, …]` arrays
 * as value/count pairs, zero counts dropped (Solr lists them; a padded "top N" can be all zeros),
 * media-type and sector codes with their meaning. No documents are fetched (rows 0).
 */
export async function countObjects(client: DdbClient, input: CountObjectsInput): Promise<ObjectCount> {
  const trace = new Trace();
  const filters = filterQueries(input);
  const names = [...new Set(input.facets ?? [])];
  for (const name of names) {
    if (FACETS[name] === undefined) throw new DdbValidationError(`Invalid facet: ${JSON.stringify(name)}; expected one of ${Object.keys(FACETS).join(", ")}.`);
  }
  const limit = pageSize("limit", input.limit, DEFAULT_FACET_VALUES, MAX_FACET_VALUES);
  const answer = await traced(client, trace, {
    query: input.query,
    rows: 0,
    ...(filters.length > 0 ? { filters } : {}),
    ...(names.length > 0 ? { facetFields: names.map((n) => FACETS[n]), facetLimit: limit } : {}),
  });
  const total = answer.response.numFound;
  const fields = ((answer.facet_counts as JsonObject | undefined)?.["facet_fields"] ?? {}) as JsonObject;
  const facets = names.map((name): FacetCount => {
    const flat = fields[FACETS[name]];
    const pairs = Array.isArray(flat) ? flat : [];
    const listed = Math.floor(pairs.length / 2);
    const values: FacetValue[] = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const value = pairs[i];
      const count = pairs[i + 1];
      if (typeof value !== "string" || typeof count !== "number" || count <= 0) continue;
      const label = codeLabel(value);
      values.push(label === undefined ? { value, count } : { value, label, count });
    }
    return { name, field: FACETS[name], values, complete: listed < limit || values.length < listed };
  });
  const notes = [
    ...filterNotes(input),
    ...(names.length > 0
      ? ["Facet values are as the index holds them: one place can come in several spellings (München, \"München, Oktoberfest\"), and places mix with regions. One object can carry several values, so the counts don't add up to the total."]
      : []),
  ];
  const result: ObjectCount = { status: total > 0 ? "ok" : "empty", searched: { query: input.query, filters }, total, facets, notes };
  if (total === 0) result.reason = "No object matches the query with these filters. Try fewer filters or other words.";
  return trace.done(result);
}

// ---- one object ------------------------------------------------------------------------------

/** Fetch a component, with the request (and an ancestor's, when the API pointed there) kept. */
async function component(client: DdbClient, trace: Trace, id: string, part: ItemPart, query: { lang?: string; rows?: number; offset?: number } = {}): Promise<ItemResult> {
  const q: QueryParams = { lang: query.lang, rows: query.rows, offset: query.offset };
  trace.note(itemComponentPath(id, part), q);
  const result = await client.item(id, part, query);
  if (result.heldBy !== undefined) trace.note(itemComponentPath(result.heldBy, part), q);
  return result;
}

/** True for an HTTP 404 of the API. */
const notFound = (err: unknown): err is DdbApiError => err instanceof DdbApiError && err.status === 404;

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
const text = (value: JsonValue | undefined): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** Where an object's rights are: the view's `rights` is often empty. */
export interface ObjectRights {
  /** The metadata licence (the view's `metdata-rights`, misspelled upstream): CC0 through the API. */
  metadata?: string;
  /** The media licence (`license.resource`): set per object by the holding institution. */
  media?: string;
  /** A rights statement in words, where the institution gave one (`rights`). */
  statement?: string;
}

/** One displayed field of an object: its name and values. */
export interface ObjectField {
  name: string;
  values: string[];
}

/** The input of {@link getObject}. */
export interface GetObjectInput {
  /** The 32-character id, or a link to the object's page. */
  id: string;
  /** Labels in de, en or fr (default the API's). */
  lang?: "de" | "en" | "fr" | undefined;
}

/** An object's view. */
export interface ObjectView {
  id: string;
  page: string;
  title?: string;
  subtitle?: string;
  /** The holding institution's own identifier (inventory number, shelf mark). */
  identifier?: string;
  category?: string;
  /** The kind of media (image, text, …; "unknown" when none). */
  media?: string;
  /** The holding institution. */
  institution?: { id?: string; name?: string; url?: string };
  /** The object's page at the holding institution. */
  sourcePage?: string;
  rights: ObjectRights;
  /** The fields the DDB displays for it, in their order (names as the institution delivered them). */
  fields: ObjectField[];
  /** Viewers the object has (a IIIF or DFG viewer), when any. */
  viewers?: JsonValue;
}

/** The answer of {@link getObject}. */
export type ObjectLookup =
  | ({ status: "ok"; searched: { id: string; lang?: string }; notes: string[] } & ObjectView)
  | { status: "empty"; searched: { id: string; lang?: string }; reason: string; notes: string[] };

/** A view's JSON as an {@link ObjectView}. */
export function viewOf(id: string, json: JsonValue | undefined): ObjectView {
  const item = object(object(json)?.["item"]) ?? {};
  const view: ObjectView = { id, page: objectPage(id), rights: {}, fields: [] };
  const set = <K extends keyof ObjectView>(key: K, value: ObjectView[K] | undefined) => {
    if (value !== undefined) view[key] = value;
  };
  set("title", text(item["title"]) ?? text(item["label"]));
  set("subtitle", text(item["subtitle"]));
  set("identifier", text(item["identifier"]));
  set("category", text(item["category"]));
  set("media", text(item["media"]));
  const inst = object(item["institution"]);
  if (inst !== undefined) {
    const institution: { id?: string; name?: string; url?: string } = {};
    const iid = text(inst["id"]);
    const name = text(inst["name"]);
    const url = text(inst["url"]);
    if (iid !== undefined) institution.id = iid;
    if (name !== undefined) institution.name = name;
    if (url !== undefined) institution.url = url;
    if (Object.keys(institution).length > 0) view.institution = institution;
  }
  set("sourcePage", text(item["origin"]));
  const metadata = text(item["metdata-rights"]) ?? text(item["metadata-rights"]);
  const media = text(object(item["license"])?.["resource"]);
  const statement = text(item["rights"]);
  if (metadata !== undefined) view.rights.metadata = metadata;
  if (media !== undefined) view.rights.media = media;
  if (statement !== undefined) view.rights.statement = statement;
  const groups = Array.isArray(item["fields"]) ? item["fields"] : [];
  for (const group of groups) {
    const g = object(group);
    if (g === undefined || g["usage"] !== "display") continue;
    for (const field of Array.isArray(g["field"]) ? g["field"] : []) {
      const f = object(field);
      const name = text(f?.["name"]);
      const values = (Array.isArray(f?.["value"]) ? (f?.["value"] as JsonValue[]) : []).map((v) => text(object(v)?.["content"])).filter((v): v is string => v !== undefined);
      if (name !== undefined && values.length > 0) view.fields.push({ name, values });
    }
  }
  const viewers = object(item["viewers"])?.["viewer"];
  if (Array.isArray(viewers) ? viewers.length > 0 : viewers !== undefined && viewers !== null) view.viewers = viewers;
  return view;
}

const RIGHTS_NOTE =
  "The metadata are CC0; the media carry their own rights, chosen by the holding institution (rights.media): check them before reusing an image, recording or film.";

/**
 * One object's view: what it is, who holds it, its displayed fields, and its rights where they
 * really are (the media licence in `license.resource`, the metadata licence under the misspelled
 * `metdata-rights`; `rights` is often empty). A view in a language the object has none in is an
 * HTTP 404: the default view is fetched instead, with a note. An unknown id is `empty`.
 */
export async function getObject(client: DdbClient, input: GetObjectInput): Promise<ObjectLookup> {
  const trace = new Trace();
  const id = objectIdFrom(input.id);
  const lang = input.lang === undefined ? undefined : normalizeToken(assertValid("lang", input.lang, langProblem));
  const searched = { id, ...(lang === undefined ? {} : { lang }) };
  const notes: string[] = [];
  let result: ItemResult;
  try {
    result = await component(client, trace, id, "view", lang === undefined ? {} : { lang });
  } catch (err) {
    if (!notFound(err)) throw err;
    if (lang === undefined) {
      return trace.done({ status: "empty", searched, reason: `No DDB object has the id ${id} (HTTP 404 for its view). Take the id from a fresh searchObjects answer.`, notes });
    }
    notes.push(`The object has no view in "${lang}" (HTTP 404): this is its view in the default language.`);
    try {
      result = await component(client, trace, id, "view");
    } catch (again) {
      if (!notFound(again)) throw again;
      return trace.done({ status: "empty", searched, reason: `No DDB object has the id ${id} (HTTP 404 for its view, with and without lang). Take the id from a fresh searchObjects answer.`, notes });
    }
  }
  const view = viewOf(id, result.json);
  notes.push(RIGHTS_NOTE);
  if (view.rights.media === undefined && view.rights.statement === undefined && view.rights.metadata === undefined) {
    notes.push("The view carries no rights statement at all; getObjectMedia lists each file's licence.");
  }
  return trace.done({ status: "ok", searched, ...view, notes });
}

/** One entry of an object's hierarchy. */
export interface HierarchyEntry {
  id: string;
  label?: string;
  /** The level as the API names it (an `htype_…` code of the archive's structure, or `institution`). */
  type?: string;
  /** True for an entry with no children. */
  leaf?: boolean;
  /** Its position among its siblings, as the institution numbered them. */
  position?: string;
}

function entryOf(value: JsonValue): HierarchyEntry | undefined {
  const e = object(value);
  const id = text(e?.["id"]);
  if (e === undefined || id === undefined) return undefined;
  const entry: HierarchyEntry = { id };
  const label = text(e["label"]);
  const type = text(e["type"]);
  const position = text(e["position"]);
  if (label !== undefined) entry.label = label;
  if (type !== undefined) entry.type = type;
  if (typeof e["leaf"] === "boolean") entry.leaf = e["leaf"];
  if (position !== undefined && position !== "-1") entry.position = position;
  return entry;
}

/** The answer of {@link getObjectContext}. */
export interface ObjectContext {
  status: "ok" | "empty";
  searched: { id: string };
  /** The records it is part of, nearest first (a series, a fonds, the archive's structure); none for a single object. */
  partOf: HierarchyEntry[];
  /** The institution that holds it (the last entry of the API's chain): the holder, not a parent record. */
  heldBy?: HierarchyEntry;
  reason?: string;
  notes: string[];
}

/**
 * What an object is part of, and who holds it, from `parents`: the API's chain starts with the
 * object itself (skipped) and ends with the institution (`heldBy`, not a parent record). An empty
 * chain is not "no parent": a section of a digitised book answers none although it is part of
 * the volume, so `empty` says where to look instead.
 */
export async function getObjectContext(client: DdbClient, input: { id: string }): Promise<ObjectContext> {
  const trace = new Trace();
  const id = objectIdFrom(input.id);
  const searched = { id };
  let result: ItemResult;
  try {
    result = await component(client, trace, id, "parents");
  } catch (err) {
    if (!notFound(err)) throw err;
    return trace.done({ status: "empty", searched, partOf: [], reason: `No DDB object has the id ${id} (HTTP 404 for its parents). Take the id from a fresh searchObjects answer.`, notes: [] });
  }
  const entries = (Array.isArray(object(result.json)?.["hierarchy"]) ? (object(result.json)?.["hierarchy"] as JsonValue[]) : []).map(entryOf).filter((e): e is HierarchyEntry => e !== undefined);
  if (entries.length === 0) {
    return trace.done({
      status: "empty",
      searched,
      partOf: [],
      reason:
        "The API lists no hierarchy for this object. That doesn't mean it is part of nothing: a section of a digitised book answers so. Take the holding institution from getObject (institution), and the containing work from getObjectRecord with part source-record, which notes the ancestor the API points to.",
      notes: [],
    });
  }
  const rest = entries[0]?.id === id ? entries.slice(1) : entries;
  const last = rest[rest.length - 1];
  const heldBy = last !== undefined && last.type === "institution" ? last : undefined;
  const partOf = heldBy === undefined ? rest : rest.slice(0, -1);
  const notes = partOf.length === 0 ? ["No record above it: it is a single object, held by the institution."] : [];
  const answer: ObjectContext = { status: "ok", searched, partOf, notes };
  if (heldBy !== undefined) answer.heldBy = heldBy;
  return trace.done(answer);
}

/** Default and largest page of {@link listObjectChildren}. */
export const DEFAULT_CHILDREN = 20;
export const MAX_CHILDREN = 100;

/** The answer of {@link listObjectChildren}. */
export interface ObjectChildren {
  status: "ok" | "empty";
  searched: { id: string };
  /** How many children it has (numberOfResults). */
  total: number;
  offset: number;
  children: HierarchyEntry[];
  nextOffset?: number;
  reason?: string;
  notes: string[];
}

/** An object's direct children (one level down: the units of a series, the parts of a work), a page at a time. */
export async function listObjectChildren(client: DdbClient, input: { id: string; offset?: number | undefined; limit?: number | undefined }): Promise<ObjectChildren> {
  const trace = new Trace();
  const id = objectIdFrom(input.id);
  const limit = pageSize("limit", input.limit, DEFAULT_CHILDREN, MAX_CHILDREN);
  const offset = input.offset ?? 0;
  const searched = { id };
  let result: ItemResult;
  try {
    result = await component(client, trace, id, "children", { rows: limit, offset });
  } catch (err) {
    if (!notFound(err)) throw err;
    return trace.done({ status: "empty", searched, total: 0, offset, children: [], reason: `No DDB object has the id ${id} (HTTP 404 for its children).`, notes: [] });
  }
  const json = object(result.json);
  const children = (Array.isArray(json?.["hierarchy"]) ? (json?.["hierarchy"] as JsonValue[]) : []).map(entryOf).filter((e): e is HierarchyEntry => e !== undefined);
  const count = json?.["numberOfResults"];
  const total = typeof count === "number" ? count : children.length;
  const answer: ObjectChildren = { status: children.length > 0 ? "ok" : "empty", searched, total, offset, children, notes: [] };
  if (children.length > 0 && offset + children.length < total) answer.nextOffset = offset + children.length;
  if (children.length === 0) {
    answer.reason =
      total > 0
        ? `It has ${total} children; offset ${offset} is past the end.`
        : "The API lists no children for it: a single object or the lowest level of its hierarchy. getObjectContext says what it is part of.";
  }
  return trace.done(answer);
}

/** One media file of an object. */
export interface MediaFile {
  name?: string;
  /** The credit line the institution asks for (author, rights holder). */
  credit?: string;
  mimeType?: string;
  /** The object's main file. */
  primary?: boolean;
  url?: string;
  /** The file's licence (a rights URI): it differs per object, and can differ per file. */
  licence?: string;
  /** The DDB's licence group code (`rights_…`). */
  licenceGroup?: string;
}

/** The answer of {@link getObjectMedia}. */
export interface ObjectMedia {
  status: "ok" | "empty";
  searched: { id: string };
  files: MediaFile[];
  reason?: string;
  notes: string[];
}

/** An object's media files (`binaries`): their links, types and each file's licence. Nothing is downloaded. */
export async function getObjectMedia(client: DdbClient, input: { id: string }): Promise<ObjectMedia> {
  const trace = new Trace();
  const id = objectIdFrom(input.id);
  const searched = { id };
  let result: ItemResult;
  try {
    result = await component(client, trace, id, "binaries");
  } catch (err) {
    if (!notFound(err)) throw err;
    return trace.done({ status: "empty", searched, files: [], reason: `No DDB object has the id ${id} (HTTP 404 for its media).`, notes: [] });
  }
  const list = object(result.json)?.["binary"];
  const files: MediaFile[] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const b = object(entry);
    if (b === undefined) continue;
    const file: MediaFile = {};
    const put = <K extends keyof MediaFile>(key: K, value: MediaFile[K] | undefined) => {
      if (value !== undefined) file[key] = value;
    };
    put("name", text(b["name"]));
    put("credit", text(b["name2"]));
    put("mimeType", text(b["mimetype"]));
    if (typeof b["primary"] === "boolean") file.primary = b["primary"];
    put("url", text(b["local_pathname"]));
    put("licence", text(b["kind"]));
    put("licenceGroup", text(b["license_group"]));
    files.push(file);
  }
  if (files.length === 0) {
    return trace.done({ status: "empty", searched, files, reason: "The object lists no media files: it is described by metadata only (getObject has the description).", notes: [] });
  }
  return trace.done({ status: "ok", searched, files, notes: [RIGHTS_NOTE.replace("(rights.media)", "(each file's licence)"), "Only links are given; nothing is downloaded."] });
}

// ---- any other component ---------------------------------------------------------------------

/** The components {@link getObjectRecord} serves (the view, media and hierarchy have their own functions). */
export const RECORD_PARTS = Object.freeze(["edm", "source-record", "aip", "source", "source-description", "iiif", "citation"] as const);
export type RecordPart = (typeof RECORD_PARTS)[number];

/** The longest chunk of a record's text. */
export const RECORD_CHUNK = 1800;
/** Default and largest number of chunks per page. */
export const DEFAULT_RECORD_CHUNKS = 8;
export const MAX_RECORD_CHUNKS = 12;

/** `text` in chunks of at most `size` characters, cut at line ends where it can, never inside a surrogate pair. */
export function chunksOf(text: string, size = RECORD_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = rest.lastIndexOf(">", size - 1) + 1;
    if (cut <= 0) cut = size;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/** The input of {@link getObjectRecord}. */
export interface GetObjectRecordInput {
  id: string;
  part: RecordPart;
  /** Labels in de, en or fr (aip, edm, source, source-description). */
  lang?: "de" | "en" | "fr" | undefined;
  /** The first chunk of the page (default 0). */
  offset?: number | undefined;
  /** Chunks per page (1–12, default 8). */
  limit?: number | undefined;
}

/** The answer of {@link getObjectRecord}. */
export interface ObjectRecord {
  status: "ok" | "empty";
  searched: { id: string; part: RecordPart; lang?: string };
  /** json (the JSON, indented), xml (edm, source-record) or text (citation). */
  format?: "json" | "xml" | "text";
  contentType?: string;
  /** The ancestor whose record this is, when the object has none of its own. */
  heldBy?: string;
  /** How many chunks the whole record has. */
  totalChunks: number;
  offset: number;
  /** A page of the record's text, in order. */
  chunks: string[];
  nextOffset?: number;
  reason?: string;
  notes: string[];
}

/**
 * Any other component of an object, as text in chunks a page at a time: EDM (RDF/XML), the
 * provider's own record (METS/MODS, LIDO, MARCXML), the archive information package, the ingest
 * source, the IIIF manifest, a newspaper citation. A component a section has only through its
 * ancestor (source-record) is the ancestor's whole record: `heldBy` and a note say so. A 404 for
 * iiif or citation means the object has none of that component, not a bad id.
 */
export async function getObjectRecord(client: DdbClient, input: GetObjectRecordInput): Promise<ObjectRecord> {
  const trace = new Trace();
  const id = objectIdFrom(input.id);
  const part = normalizeToken(String(input.part)) as RecordPart;
  if (!RECORD_PARTS.includes(part)) throw new DdbValidationError(`Invalid part: expected one of ${RECORD_PARTS.join(", ")}.`);
  const lang = input.lang === undefined ? undefined : normalizeToken(assertValid("lang", input.lang, langProblem));
  const limit = pageSize("limit", input.limit, DEFAULT_RECORD_CHUNKS, MAX_RECORD_CHUNKS);
  const offset = input.offset ?? 0;
  const searched = { id, part, ...(lang === undefined ? {} : { lang }) };
  let result: ItemResult;
  try {
    result = await component(client, trace, id, part, lang === undefined ? {} : { lang });
  } catch (err) {
    if (!notFound(err)) throw err;
    const reason =
      part === "iiif" || part === "citation"
        ? `The object has no ${part === "iiif" ? "IIIF manifest" : "citation file"} (HTTP 404): only some objects have one. That says nothing about the id; getObject checks it.`
        : lang !== undefined
          ? `No ${part} in "${lang}" for ${id} (HTTP 404): call again without lang; if that is a 404 too, the id is unknown.`
          : `No ${part} for ${id} (HTTP 404): the id is unknown or the object has no such component. getObject checks the id.`;
    return trace.done({ status: "empty", searched, totalChunks: 0, offset, chunks: [], reason, notes: [] });
  }
  const json = result.json !== undefined;
  const body = json ? JSON.stringify(result.json, null, 1) : (result.text ?? "");
  const all = chunksOf(body);
  const chunks = all.slice(offset, offset + limit);
  const format = json ? "json" : /xml/i.test(result.contentType) || /^\s*</.test(body) ? "xml" : "text";
  const notes: string[] = [];
  if (result.heldBy !== undefined) {
    notes.push(`The object has no ${part} of its own: this is the whole ${part} of its ancestor ${result.heldBy} (e.g. the volume's METS for a section of a book), not one for the object.`);
  }
  if (result.replaced !== undefined) notes.push(`${result.replaced} characters were not valid in the record's charset and were replaced.`);
  const answer: ObjectRecord = { status: chunks.length > 0 ? "ok" : "empty", searched, format, contentType: result.contentType, totalChunks: all.length, offset, chunks, notes };
  if (result.heldBy !== undefined) answer.heldBy = result.heldBy;
  if (offset + chunks.length < all.length && chunks.length > 0) answer.nextOffset = offset + chunks.length;
  if (chunks.length === 0) answer.reason = all.length > 0 ? `The record has ${all.length} chunks; offset ${offset} is past the end.` : `The ${part} is empty.`;
  return trace.done(answer);
}
