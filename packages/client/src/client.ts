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

import { RequestEngine, bigIntegerKeysOption, decodeBody, sanitizeServerText, type EngineOptions, type RawResponse } from "./engine.js";
import { DdbApiError, DdbParseError, DdbValidationError, MAX_QUOTED_LENGTH, cutForMessage, quoteValue } from "./errors.js";
import type { QueryParams } from "./query.js";
import {
  assertValid,
  facetFieldProblem,
  fieldsProblem,
  itemPartProblem,
  langProblem,
  normalizeFields,
  normalizeItemId,
  normalizeText,
  normalizeToken,
  pathNameProblem,
  sortProblem,
  textProblem,
} from "./validate.js";
import {
  ITEM_LANG_PARTS,
  ITEM_TEXT_PARTS,
  SOLR_MAX_INT,
  type ItemOptions,
  type ItemPart,
  type ItemResult,
  type JsonValue,
  type SearchParams,
  type SolrResponse,
} from "./types.js";

const enc = encodeURIComponent;

/** Options for the DDB client. v2 read routes need no auth, so this is just the engine options. */
export type DdbClientOptions = EngineOptions;

/**
 * The member names the client always declares as big integers (`EngineOptions.bigIntegerKeys`):
 * Solr's `_version_`, a 64-bit document version (about 1.85e18 on the live index, past 2^53),
 * which every search document carries. It is delivered as a decimal string.
 */
const DDB_BIG_INTEGER_KEYS = ["_version_"] as const;

/**
 * Map an item part to its `/items/{id}` path suffix (`aip` is the bare endpoint).
 * Typed by `ItemPart`, which derives from `ITEM_PARTS`, so a part added there
 * without a suffix here fails to compile.
 */
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

/**
 * Check which item options apply to `part`, before any request: `lang` only to the
 * parts in {@link ITEM_LANG_PARTS}, `rows`/`offset` only to `children`. The API
 * ignores them elsewhere, so a caller asking for English labels on `iiif` or a
 * page of 5 on `view` would get default data with no sign the option was dropped.
 * Throws a DdbValidationError (`Invalid <option>: applies only to part …`).
 */
export function validateItemOptions(part: ItemPart, opts: ItemOptions): ItemOptions {
  if (opts.lang !== undefined && !ITEM_LANG_PARTS.includes(part)) {
    throw new DdbValidationError(
      `Invalid lang: applies only to part ${ITEM_LANG_PARTS.join(", ")} (got ${part}).`,
    );
  }
  for (const key of ["rows", "offset"] as const) {
    if (opts[key] !== undefined && part !== "children") {
      throw new DdbValidationError(`Invalid ${key}: applies only to part children (got ${part}).`);
    }
  }
  return opts;
}

/** A non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(name: string, expected: string, value: unknown): DdbValidationError {
  // A string is quoted visibly (cut at 50 characters), a number shown, anything else named by type.
  const shown =
    typeof value === "string"
      ? quoteValue(value, 50)
      : typeof value === "number"
        ? String(value)
        : value === null
          ? "null"
          : Array.isArray(value)
            ? "an array"
            : `a ${typeof value}`;
  return new DdbValidationError(`Invalid ${name}: expected ${expected}, got ${shown}.`);
}

/** Throw unless `value` is a string with non-whitespace content. */
function assertText(name: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(name, "a non-empty string", value);
  }
}

/** {@link assertText}, then the text-filter rules (`textProblem`: no invisible, control or half character). */
function assertTextFilter(name: string, value: unknown): void {
  assertText(name, value);
  assertValid(name, value, textProblem);
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
/**
 * `err` (an error for an ancestor's component) restated for the item the caller asked
 * for: same status (a 404 still exits 4: the component doesn't exist for this item), with
 * the redirect chain in the message, so "not found" is never reported for another id
 * without saying why.
 */
function withAncestry(err: DdbApiError, id: string, part: ItemPart, ancestors: string[]): DdbApiError {
  const chain = [id, ...ancestors].join(" → ");
  const note =
    err.status === 404
      ? `item ${id} has no ${part} of its own; the API points to its ancestor${ancestors.length > 1 ? "s" : ""} (${chain}), and the last has none either`
      : `item ${id} has no ${part} of its own; the API points to its ancestor${ancestors.length > 1 ? "s" : ""} (${chain}), and fetching that failed`;
  return new DdbApiError({
    status: err.status,
    url: err.url,
    method: err.method,
    body: err.body,
    detail: err.detail === undefined ? note : `${err.detail}; ${note}`,
    ...(err.apiName !== undefined ? { apiName: err.apiName } : {}),
    ...(err.location !== undefined ? { location: err.location } : {}),
  });
}

/** The keys `search()` takes; anything else would be dropped without a word. */
export const SEARCH_PARAM_KEYS = Object.freeze([
  "query",
  "rows",
  "start",
  "sort",
  "fields",
  "filters",
  "facetFields",
  "facetLimit",
  "collection",
  "requestHandler",
] as const satisfies readonly (keyof SearchParams)[]);

/** The keys `item()`'s options take. */
export const ITEM_OPTION_KEYS = Object.freeze(["lang", "rows", "offset"] as const satisfies readonly (keyof ItemOptions)[]);

/**
 * Throw a DdbValidationError for any own key of `value` outside `allowed`: a misspelled
 * key (`filter` for `filters`), a wrong case or a `__proto__`/`constructor` key from
 * parsed JSON would otherwise be ignored, and the API answer the whole unfiltered set.
 */
function assertKnownKeys(name: string, value: object, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const shown = quoteValue(key, 50);
      throw new DdbValidationError(`Invalid ${name}: unknown key ${shown}; expected one of ${allowed.join(", ")}.`);
    }
  }
}

function assertSearchParams(params: SearchParams): void {
  if (!isObject(params)) throw invalid("params", "an object such as { query: \"Goethe\" }", params);
  assertKnownKeys("search params", params, SEARCH_PARAM_KEYS);
  assertTextFilter("query", params.query);
  assertInt("rows", params.rows);
  assertInt("start", params.start);
  // facet.limit -1 is Solr's "no limit".
  assertInt("facetLimit", params.facetLimit, -1);
  if (params.sort !== undefined) {
    assertText("sort", params.sort);
    assertValid("sort", params.sort, sortProblem);
  }
  if (params.fields !== undefined) {
    assertText("fields", params.fields);
    assertValid("fields", params.fields, fieldsProblem);
  }
  for (const key of ["collection", "requestHandler"] as const) {
    if (params[key] !== undefined) assertValid(key, params[key], pathNameProblem);
  }
  for (const key of ["filters", "facetFields"] as const) {
    const list: unknown = params[key];
    // A string here would be read character by character; an object not at all.
    if (list !== undefined && !Array.isArray(list)) throw invalid(key, "an array of strings", list);
    for (const value of params[key] ?? []) {
      if (key === "filters") assertTextFilter(`${key} entry`, value);
      else {
        // A facet field is a token: compared exactly, sent trimmed.
        assertText(`${key} entry`, value);
        assertValid(`${key} entry`, value, facetFieldProblem);
      }
    }
  }
  if (params.facetLimit !== undefined && (params.facetFields ?? []).length === 0) {
    throw new DdbValidationError("Invalid facetLimit: it needs facetFields (it caps the values returned per facet field).");
  }
}

/** A 2xx answer without the documented shape; `request` names it (`GET <url>`). */
function shapeError(request: string, expected: string): DdbParseError {
  return new DdbParseError(`${request}: unexpected response shape: expected ${expected}.`);
}

/** `text` cleaned of control characters, on one line, cut at MAX_QUOTED_LENGTH (200) characters (never inside a surrogate pair). */
function quoted(text: string): string {
  return cutForMessage(sanitizeServerText(text).replace(/\s+/g, " ").trim(), MAX_QUOTED_LENGTH);
}

/**
 * The message of an error document sent with a 2xx status, or undefined for any other
 * body: Solr's `{ error: { msg } }` (or a bare `error` string) and the DDB envelope
 * `{ name: "…Exception", message, stacktrace }`.
 */
function errorEnvelope(body: Record<string, unknown>): string | undefined {
  const error = body["error"];
  if (typeof error === "string") return error;
  if (isObject(error)) return typeof error["msg"] === "string" ? error["msg"] : "(no message)";
  const name = body["name"];
  if ((typeof name === "string" && /Exception$/.test(name)) || body["stacktrace"] !== undefined) {
    const message = body["message"];
    return `${typeof name === "string" ? `${name}: ` : ""}${typeof message === "string" ? message : "(no message)"}`;
  }
  return undefined;
}

/**
 * The shape error of a search answer: {@link shapeError} plus the rule it breaks, naming
 * the request handler — only handlers that return Solr's standard `response` envelope are
 * supported (`select`, the default, does; a real-time `get`, for one, answers differently).
 */
function searchShapeError(request: string, handler: string, expected: string): DdbParseError {
  return new DdbParseError(
    `${request}: unexpected response shape: expected ${expected}. Only request handlers that ` +
      `return Solr's standard response envelope (a "response" object with "numFound" and "docs") ` +
      `are supported; handler "${cutForMessage(handler)}" did not.`,
  );
}

/**
 * Check a search answer against the documented Solr shape (`SolrResponse`): a JSON object
 * with a `response` object holding an integer `numFound` and a `docs` array. An error
 * document, `null`, `{}`, an array or a scalar is a DdbParseError, never data: printed as
 * a result it read as "nothing found" or as hits. A shape error names `handler` and the
 * rule (only handlers returning that envelope are supported); there is no fallback for
 * other shapes.
 */
function assertSolrResponse(request: string, handler: string, body: unknown): asserts body is SolrResponse {
  if (!isObject(body)) throw searchShapeError(request, handler, "a JSON object");
  const error = errorEnvelope(body);
  if (error !== undefined) {
    throw new DdbParseError(`${request}: an error document with a success status: ${quoted(error)}`);
  }
  const response = body["response"];
  if (!isObject(response)) throw searchShapeError(request, handler, "a response object");
  const numFound = response["numFound"];
  if (typeof numFound !== "number" || !Number.isSafeInteger(numFound) || numFound < 0) {
    throw searchShapeError(request, handler, "an integer response.numFound");
  }
  if (!Array.isArray(response["docs"])) throw searchShapeError(request, handler, "a response.docs array");
}

/**
 * A backend version as `/version` sends it: one short token of letters, digits, `.`, `_`,
 * `+` and `-` ("7.5"). An HTML page (a captive portal, a proxy login, a wrong --base-url),
 * a JSON document or anything long is not a version.
 */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/** The item id in an `/items/{id}…` URL path, with the rest of the path, or undefined. */
function itemPath(url: URL | string): { id: string; rest: string } | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const match = /\/items\/([A-Z0-9]{32})(\/.*)?$/.exec(path);
  return match ? { id: match[1]!, rest: match[2] ?? "" } : undefined;
}

export class DdbClient {
  private readonly engine: RequestEngine;
  /** How many ancestors `item()` follows when the API points a component at one. */
  private readonly maxAncestors: number;

  constructor(options: DdbClientOptions = {}) {
    // Solr's `_version_` is always declared; a caller's own names are added to it.
    this.engine = new RequestEngine({
      ...options,
      bigIntegerKeys: new Set([...DDB_BIG_INTEGER_KEYS, ...bigIntegerKeysOption(options?.bigIntegerKeys)]),
    });
    // The engine has validated maxRedirects (0..20); its limit bounds the ancestor walk too.
    this.maxAncestors = options?.maxRedirects ?? 5;
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
   * body without the documented shape — not a JSON object, an error document, no
   * `response` object with an integer `numFound` and a `docs` array — raises
   * DdbParseError. Only request handlers that return Solr's standard `response`
   * envelope (such as the default `select`) are supported; for any other the
   * DdbParseError names the handler and that rule (there is no fallback).
   */
  async search(params: SearchParams): Promise<SolrResponse> {
    assertSearchParams(params);
    const collection = normalizeToken(params.collection ?? "search");
    const handler = normalizeToken(params.requestHandler ?? "select");
    // The index matches composed text only: `München` with U+0308 (as pasted from a macOS file
    // name) found 231 documents instead of 2.77 million, and as a facet filter none; a trailing
    // no-break space made another facet value. The query and the filters go out trimmed and in
    // NFC (normalizeText).
    const query: QueryParams = { q: normalizeText(params.query), wt: "json" };
    query["rows"] = params.rows ?? DEFAULT_SEARCH_ROWS;
    if (params.start !== undefined) query["start"] = params.start;
    // Field names, the sort and the facet fields are tokens: trimmed and in NFC (normalizeToken);
    // a padded facet field was an HTTP 500 ("undefined field").
    if (params.sort !== undefined) query["sort"] = normalizeToken(params.sort);
    if (params.fields !== undefined) query["fl"] = normalizeFields(params.fields);
    if (params.filters !== undefined && params.filters.length > 0) query["fq"] = params.filters.map(normalizeText);
    if (params.facetFields !== undefined && params.facetFields.length > 0) {
      query["facet"] = "true";
      query["facet.field"] = params.facetFields.map(normalizeToken);
      if (params.facetLimit !== undefined) query["facet.limit"] = params.facetLimit;
      // Solr sorts facet values by count, except when facet.limit is -1 ("no limit"): then
      // its facet.sort default flips to index (alphabetical) order, and "the top of the
      // array" became the alphabetically first value. Keep count order for -1 explicitly.
      if (params.facetLimit === -1) query["facet.sort"] = "count";
    }
    const path = `/search/index/${enc(collection)}/${enc(handler)}`;
    const body = await this.engine.getJson<unknown>(path, query);
    assertSolrResponse(`GET ${this.engine.describeUrl(path, query)}`, handler, body);
    return body;
  }

  /**
   * Fetch one component of an item by its 32-character id (defaults to `view`).
   * Decodes by Content-Type: JSON components are parsed into `json`, while the
   * XML / file components (edm, source-record, citation) are returned as `text`
   * (plus the exact `bytes`). The id is trimmed and must then be exactly 32
   * upper-case letters and digits (`normalizeItemId`); anything else rejects with
   * a DdbValidationError without a request. A part outside {@link ITEM_PARTS}
   * (`itemPartProblem`) rejects with a DdbValidationError, a blank `lang` or a
   * non-integer / negative `rows`/`offset` throws DdbError, both without a request, and
   * `lang` outside {@link ITEM_LANG_PARTS} or `rows`/`offset` for any part but
   * `children` rejects with a DdbValidationError (`validateItemOptions`). A JSON part whose
   * body is not an object or array (`null`, empty, a scalar) or is an error document is a
   * DdbParseError.
   */
  async item(rawId: string, rawPart: ItemPart = "view", opts: ItemOptions = {}): Promise<ItemResult> {
    // A JavaScript caller may pass null for "no options".
    opts = opts ?? {};
    if (typeof opts !== "object" || Array.isArray(opts)) throw invalid("options", "an object", opts);
    assertKnownKeys("item options", opts, ITEM_OPTION_KEYS);
    const id = normalizeItemId(rawId);
    assertValid("part", rawPart, itemPartProblem);
    const part = normalizeToken(rawPart) as ItemPart;
    if (opts.lang !== undefined) {
      assertText("lang", opts.lang);
      assertValid("lang", opts.lang, langProblem);
    }
    assertInt("rows", opts.rows);
    assertInt("offset", opts.offset);
    validateItemOptions(part, opts);
    const query: QueryParams = {};
    if (opts.lang !== undefined) query["lang"] = normalizeToken(opts.lang);
    if (opts.rows !== undefined) query["rows"] = opts.rows;
    if (opts.offset !== undefined) query["offset"] = opts.offset;
    const suffix = PART_SUFFIX[part];
    // A component held by an ancestor (a section of a digitised book, a unit of an archive
    // finding aid) answers 303 with a Location naming the ancestor's same component — and
    // without the API's /2 prefix, so following it as sent ends in a 404 for another id
    // (result 01, bug 1). The engine is told not to follow a redirect that names another
    // item; the client requests that item's component through the base URL instead, up to
    // maxRedirects ancestors, and says so in `heldBy` (or in the error).
    const ancestors: string[] = [];
    let current = id;
    let res: RawResponse;
    let path: string;
    for (;;) {
      path = `/items/${enc(current)}${suffix}`;
      try {
        res = await this.engine.getRaw(
          path,
          "application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5",
          query,
          (target) => {
            const named = itemPath(target);
            return named === undefined || named.id === current;
          },
        );
        break;
      } catch (err) {
        const named =
          err instanceof DdbApiError && err.status >= 300 && err.status < 400 && err.location !== undefined
            ? itemPath(err.location)
            : undefined;
        if (
          named !== undefined &&
          named.rest === suffix &&
          named.id !== id &&
          !ancestors.includes(named.id) &&
          ancestors.length < this.maxAncestors
        ) {
          ancestors.push(named.id);
          current = named.id;
          continue;
        }
        if (ancestors.length > 0 && err instanceof DdbApiError) throw withAncestry(err, id, part, ancestors);
        throw err;
      }
    }
    const heldBy = ancestors.length > 0 ? { heldBy: current } : {};
    // Whether the answer is JSON is the part's, not the Content-Type's: an HTML page in place of
    // `view` (a captive portal, a proxy login, a wrong --base-url) was returned as text and
    // printed as data, exit 0 (Bug 04-1 of the 2026-10-21 round).
    const jsonPart = !ITEM_TEXT_PARTS.includes(part);
    // Every error about the answer names the request (the ancestor's, when the API pointed there).
    const request = `GET ${this.engine.describeUrl(path, query)}`;
    if (jsonPart) {
      // Declared big integers (`_version_`) are quoted first, as in search.
      const json = this.engine.parseJson<unknown>(res, request);
      // Every JSON part is an object or an array; `null` or a scalar is not data, and neither
      // is an error document sent with a 2xx status.
      if (typeof json !== "object" || json === null) throw shapeError(request, "a JSON object or array");
      const error = isObject(json) ? errorEnvelope(json) : undefined;
      if (error !== undefined) {
        throw new DdbParseError(`${request}: an error document with a success status: ${quoted(error)}`);
      }
      return { part, contentType: res.contentType, json: json as JsonValue, ...heldBy };
    }
    // The raw XML/file parts keep their exact `bytes`; `text` falls back to UTF-8 for a charset
    // label Node doesn't know.
    // They are delivered as their exact bytes; `text` says how many characters it replaced.
    const { text, replaced } = decodeBody(res.data, res.contentType, request, "lenient");
    return { part, contentType: res.contentType, text, bytes: res.data, ...(replaced > 0 ? { replaced } : {}), ...heldBy };
  }

  /**
   * The version string of the DDB backend, with surrounding whitespace (the body's
   * trailing newline, CRs) trimmed. Public — works without a key. A 2xx body that is not
   * one short version token ("7.5": letters, digits, `.`, `_`, `+`, `-`) — an HTML page,
   * JSON, an empty body — is a DdbParseError, so the call works as a connectivity check.
   */
  async version(): Promise<string> {
    const version = (await this.engine.getText("/version")).trim();
    if (!VERSION_PATTERN.test(version)) {
      throw new DdbParseError(
        `GET ${this.engine.describeUrl("/version")}: expected a version string such as "7.5", got ${
          version === "" ? "an empty body" : `"${quoted(version)}"`
        }.`,
      );
    }
    return version;
  }
}
