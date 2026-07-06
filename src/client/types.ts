// Response interfaces for the DDB **v2** API.
//
// v2 exposes two very different read surfaces:
//   - Search is a raw Apache Solr passthrough (`/2/search/index/{collection}/
//     {requestHandler}`). The response is native Solr JSON, so `SolrResponse`
//     mirrors Solr's `responseHeader` / `response` / `facet_counts` shape rather
//     than a DDB-curated envelope.
//   - Item components (`/2/items/{id}...`) return either JSON (view, aip, edm-as-
//     json, binaries, children, parents, source) or XML/text (edm as RDF/XML,
//     source record XML, citation BIB file). The client decodes by Content-Type
//     and hands back an `ItemResult` carrying whichever it found.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * One document in a Solr search response. Only `id` is guaranteed (it is the
 * 32-character item id usable with the `item` command / `/2/items/{id}`); every
 * other field is a Solr index field and varies by object, so it is left open.
 */
export interface SolrDoc {
  id: string;
  [key: string]: JsonValue | undefined;
}

/** The `response` block of a Solr result: the hit count plus this page of docs. */
export interface SolrResponseBody {
  /** Total number of matching documents, independent of `rows`. */
  numFound: number;
  /** Offset of the first returned document (the `start` you paged to). */
  start: number;
  /** Best relevance score in the page (absent for non-scoring sorts). */
  maxScore?: number;
  /** Whether `numFound` is exact or a lower bound (Solr may approximate). */
  numFoundExact?: boolean;
  docs: SolrDoc[];
}

/** A native Apache Solr response, as returned by the v2 search passthrough. */
export interface SolrResponse {
  /** Echoes the parsed request params and Solr timing/status. */
  responseHeader?: JsonObject;
  response: SolrResponseBody;
  /** Present when faceting was requested (`--facet`): counts per field/query. */
  facet_counts?: JsonObject;
  [key: string]: JsonValue | SolrResponseBody | undefined;
}

/**
 * The item component to fetch, selecting one of the `/2/items/{id}` sub-paths.
 * `aip` is the bare item endpoint; the rest map to a suffix. `source-description`
 * and `source-record` map to `/source/description` and `/source/record`; `citation`
 * maps to the upstream (misspelled) `/citiation` path.
 */
export type ItemPart =
  | "view"
  | "aip"
  | "edm"
  | "binaries"
  | "children"
  | "parents"
  | "source"
  | "source-description"
  | "source-record"
  | "iiif"
  | "citation";

/**
 * The decoded body of an item component. Exactly one of `json` / `text` is set:
 * `json` for JSON components (view, aip, binaries, ...), `text` for the ones the
 * API serves as XML or a plain file (edm RDF/XML, source record XML, citation BIB).
 */
export interface ItemResult {
  part: ItemPart;
  /** The response Content-Type the decoding was based on. */
  contentType: string;
  /** Parsed JSON body, when the component returned JSON. */
  json?: JsonValue;
  /** Raw text body, when the component returned XML / a plain file. */
  text?: string;
}

/** Options for an item-component request. */
export interface ItemOptions {
  /** Preferred language for localised labels (accepted by view/aip/edm/binaries/source*). */
  lang?: string;
  /** For `--part children`: page size. */
  rows?: number;
  /** For `--part children`: offset of the first child. */
  offset?: number;
}

/**
 * Options for a v2 search request. These map onto native Solr query parameters
 * (`q`, `rows`, `start`, `sort`, `fq`, `fl`, `facet*`) — the endpoint is a Solr
 * passthrough, so the values use Solr syntax.
 */
export interface SearchParams {
  /** The Solr query (`q`). Use `*:*` to match everything. */
  query: string;
  /** Number of documents to return (`rows`). */
  rows?: number;
  /** Offset of the first returned document (`start`), for paging. */
  start?: number;
  /** Sort spec in Solr syntax, e.g. `score desc`, `id asc` (`sort`). */
  sort?: string;
  /** Field list to return, e.g. `id,title` (`fl`). */
  fields?: string;
  /** Filter queries in Solr syntax, e.g. `type_fct:mediatype_002` (`fq`, repeatable). */
  filters?: string[];
  /** Facet fields to compute counts for (`facet.field`; enables `facet=true`). */
  facetFields?: string[];
  /** Cap the number of values returned per facet (`facet.limit`). */
  facetLimit?: number;
  /** Solr collection to query. Defaults to `search`. */
  collection?: string;
  /** Solr request handler. Defaults to `select`. */
  requestHandler?: string;
}
