// DdbClient — a typed client over the Deutsche Digitale Bibliothek (DDB) **v2**
// API (https://api.deutsche-digitale-bibliothek.de/2), central access to
// digitised cultural-heritage objects from German archives, libraries and
// museums.
//
// Scope: the public **read** routes, which need **no API key**:
//   - search — a raw Apache Solr passthrough over the object index
//   - items  — one item's components (view, aip, edm, binaries, ...)
//   - version — the backend version string (a quick connectivity check)
//
//   client.search({ query: "Goethe", rows: 10 })
//   client.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK")           // view (JSON)
//   client.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "edm")    // RDF/XML (text)

import { RequestEngine, type EngineOptions } from "./engine.js";
import { DdbError, DdbParseError } from "./errors.js";
import type { QueryParams } from "./query.js";
import { assertValid, normalizeItemId, pathNameProblem } from "./validate.js";
import type {
  ItemOptions,
  ItemPart,
  ItemResult,
  SearchParams,
  SolrResponse,
} from "./types.js";

const enc = encodeURIComponent;

/** Options for the DDB client. v2 read routes need no auth, so this is just the engine options. */
export type DdbClientOptions = EngineOptions;

/** Map an item part to its `/items/{id}` path suffix (`aip` is the bare endpoint). */
const PART_SUFFIX: Record<ItemPart, string> = {
  view: "/view",
  aip: "",
  edm: "/edm",
  binaries: "/binaries",
  children: "/children",
  parents: "/parents",
  source: "/source",
  "source-description": "/source/description",
  "source-record": "/source/record",
  iiif: "/iiif",
  // NB: the upstream path is misspelled "citiation"; we expose the correct name.
  citation: "/citiation",
};

/**
 * The page size `search()` asks for when the caller gives no `rows`: Solr's
 * stock default, sent explicitly so a collection or handler with another
 * configured default returns the same page.
 */
export const DEFAULT_SEARCH_ROWS = 10;

/** Item parts that accept a `lang` query parameter for localised labels. */
export const ITEM_LANG_PARTS: readonly ItemPart[] = [
  "view",
  "aip",
  "edm",
  "binaries",
  "source",
  "source-description",
];
const LANG_PARTS = new Set<ItemPart>(ITEM_LANG_PARTS);

/** A non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The largest value Solr accepts for an int parameter (Java's Integer.MAX_VALUE). */
const SOLR_MAX_INT = 2_147_483_647;

function invalid(name: string, expected: string, value: unknown): DdbError {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return new DdbError(`Invalid ${name}: expected ${expected}, got ${shown}.`);
}

/** Throw unless `value` is a string with non-whitespace content. */
function assertText(name: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(name, "a non-empty string", value);
  }
}

/** Throw unless `value` is undefined or an integer in [min, SOLR_MAX_INT]. */
function assertInt(name: string, value: number | undefined, min = 0): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min || value > SOLR_MAX_INT) {
    throw invalid(name, `an integer from ${min} to ${SOLR_MAX_INT}`, value);
  }
}

/**
 * Validate search parameters before any request: the API reads a blank `q`/`fq` as
 * no filter, and a NaN or negative number would be sent as is.
 */
function assertSearchParams(params: SearchParams): void {
  assertText("query", params.query);
  assertInt("rows", params.rows);
  assertInt("start", params.start);
  // facet.limit -1 is Solr's "no limit".
  assertInt("facetLimit", params.facetLimit, -1);
  for (const key of ["sort", "fields"] as const) {
    if (params[key] !== undefined) assertText(key, params[key]);
  }
  for (const key of ["collection", "requestHandler"] as const) {
    if (params[key] !== undefined) assertValid(key, params[key], pathNameProblem);
  }
  for (const key of ["filters", "facetFields"] as const) {
    for (const value of params[key] ?? []) assertText(`${key} entry`, value);
  }
  if (params.facetLimit !== undefined && (params.facetFields ?? []).length === 0) {
    throw new DdbError("Invalid facetLimit: it needs facetFields (it caps the values returned per facet field).");
  }
}

function shapeError(path: string, expected: string): DdbParseError {
  return new DdbParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

export class DdbClient {
  private readonly engine: RequestEngine;

  constructor(options: DdbClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Search the DDB object index via the v2 Solr passthrough
   * (`GET /2/search/index/{collection}/{requestHandler}`). Values use Solr
   * syntax; the response is native Solr JSON. `wt=json` is always forced, and
   * `rows` defaults to `DEFAULT_SEARCH_ROWS` (10). The
   * parameters are checked first (non-blank query and strings, integers from 0 to
   * 2^31 - 1, `facetLimit` -1 or more and only with `facetFields`); a bad one
   * throws DdbError without a request. `collection` and `requestHandler` must be
   * letters, digits, `.`, `_` and `-` (not "." or ".."; `pathNameProblem`), or the
   * call rejects with a DdbValidationError without a request. A 2xx
   * body that is not a JSON object (empty, `null`, an array, a scalar) or whose
   * `response` is not an object raises DdbParseError.
   */
  async search(params: SearchParams): Promise<SolrResponse> {
    assertSearchParams(params);
    const collection = params.collection ?? "search";
    const handler = params.requestHandler ?? "select";
    const query: QueryParams = { q: params.query, wt: "json" };
    query["rows"] = params.rows ?? DEFAULT_SEARCH_ROWS;
    if (params.start !== undefined) query["start"] = params.start;
    if (params.sort !== undefined) query["sort"] = params.sort;
    if (params.fields !== undefined) query["fl"] = params.fields;
    if (params.filters !== undefined && params.filters.length > 0) query["fq"] = params.filters;
    if (params.facetFields !== undefined && params.facetFields.length > 0) {
      query["facet"] = "true";
      query["facet.field"] = params.facetFields;
      if (params.facetLimit !== undefined) query["facet.limit"] = params.facetLimit;
    }
    const path = `/search/index/${enc(collection)}/${enc(handler)}`;
    const body = await this.engine.getJson<unknown>(path, query);
    if (!isObject(body)) throw shapeError(path, "a JSON object");
    if (body["response"] !== undefined && !isObject(body["response"])) {
      throw shapeError(path, "a response object");
    }
    return body as SolrResponse;
  }

  /**
   * Fetch one component of an item by its 32-character id (defaults to `view`).
   * Decodes by Content-Type: JSON components are parsed into `json`, while the
   * XML / file components (edm, source-record, citation) are returned as `text`
   * (plus the exact `bytes`). The id is trimmed and must then be exactly 32
   * upper-case letters and digits (`normalizeItemId`); anything else rejects with
   * a DdbValidationError without a request. An unknown part, a blank `lang` or a
   * non-integer / negative `rows`/`offset` throws DdbError without a request.
   */
  async item(rawId: string, part: ItemPart = "view", opts: ItemOptions = {}): Promise<ItemResult> {
    const id = normalizeItemId(rawId);
    if (!Object.hasOwn(PART_SUFFIX, part)) {
      throw invalid("part", `one of ${Object.keys(PART_SUFFIX).join(", ")}`, part);
    }
    if (opts.lang !== undefined) assertText("lang", opts.lang);
    assertInt("rows", opts.rows);
    assertInt("offset", opts.offset);
    const query: QueryParams = {};
    if (opts.lang !== undefined && LANG_PARTS.has(part)) query["lang"] = opts.lang;
    if (part === "children") {
      if (opts.rows !== undefined) query["rows"] = opts.rows;
      if (opts.offset !== undefined) query["offset"] = opts.offset;
    }
    const res = await this.engine.getRaw(
      `/items/${enc(id)}${PART_SUFFIX[part]}`,
      "application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5",
      query,
    );
    const text = res.data.toString("utf8");
    if (/\bjson\b/i.test(res.contentType)) {
      if (text.trim().length === 0) return { part, contentType: res.contentType, json: null };
      try {
        return { part, contentType: res.contentType, json: JSON.parse(text) };
      } catch (cause) {
        throw new DdbParseError(`Failed to parse JSON for item ${id} (${part})`, { cause });
      }
    }
    return { part, contentType: res.contentType, text, bytes: res.data };
  }

  /** The version string of the DDB backend. Public — works without a key. */
  version(): Promise<string> {
    return this.engine.getText("/version");
  }
}
