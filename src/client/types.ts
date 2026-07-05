// Response interfaces for the DDB API. The DDB serves opaque JSON objects for
// most details (item AIP components, views, EDM), so those are typed as
// `JsonObject`. The search response has a stable, documented top-level shape,
// typed here; individual result documents carry a curated set of known fields
// plus an index signature for everything else the Solr index returns.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** One value of a facet with the number of matching documents. */
export interface FacetValue {
  value: string;
  count: number;
  [key: string]: JsonValue;
}

/** A facet returned alongside search results or by the facets endpoints. */
export interface Facet {
  /** The facet field, e.g. `type_fct`, `place_fct`, `provider_fct`. */
  field: string;
  /** Number of distinct facet values found (capped by `facet.limit`). */
  numberOfFacets: number;
  facetValues: FacetValue[];
  [key: string]: JsonValue;
}

/** A single result document from the search index (curated known fields). */
export interface SearchDoc {
  /** The 32-character item id, usable with the `item` command / `/items/{id}`. */
  id: string;
  /** Display title. */
  label?: string;
  /** Secondary line (e.g. institution, date). */
  subtitle?: string;
  /** Object type (Bild, Buch, ...). */
  type?: string;
  /** Broad category / cultural sector. */
  category?: string;
  /** Media types present (mime categories). */
  media?: string[];
  [key: string]: JsonValue | string[] | undefined;
}

/** A group of result documents within a search response. */
export interface SearchResultGroup {
  docs: SearchDoc[];
  numberOfDocs?: number;
  [key: string]: JsonValue | SearchDoc[] | undefined;
}

/** The top-level DDB search response. */
export interface SearchResponse {
  /** Total number of hits, independent of the `rows` returned. */
  numberOfResults: number;
  results: SearchResultGroup[];
  /** Facets whose `displayType` is SEARCH are always returned. */
  facets?: Facet[];
  /** Terms to highlight in the preview / detail view. */
  highlightedTerms?: string[];
  /** Seed to reuse for a stable RANDOM sort on subsequent requests. */
  randomSeed?: string;
  /** A spelling-corrected query when the original looked mistyped. */
  correctedQuery?: string;
  [key: string]: JsonValue | Facet[] | SearchResultGroup[] | string[] | undefined;
}

/** An institution registered at the DDB (may nest child institutions). */
export interface Institution {
  id: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  sector?: string;
  children?: Institution[];
  [key: string]: JsonValue | Institution[] | undefined;
}

/** The AIP components of an item that return JSON, selectable via `--part`. */
export type ItemPart =
  | "view"
  | "aip"
  | "edm"
  | "binaries"
  | "children"
  | "parents"
  | "indexing-profile";

/** A cultural-sector code accepted by the institutions endpoint. */
export type Sector = "sec_01" | "sec_02" | "sec_03" | "sec_04" | "sec_05" | "sec_06" | "sec_07";

/** Options for a search request. */
export interface SearchParams {
  /** Query term(s), Solr syntax. Use `*` to match everything. */
  query: string;
  /** Rows to return (0..1000). */
  rows?: number;
  /** Offset of the first returned row (for paging). */
  offset?: number;
  /** Sort order: RELEVANCE, ALPHA_ASC, ALPHA_DESC, or RANDOM[_<seed>]. */
  sort?: string;
  /** Facet fields to compute counts for (repeatable). */
  facet?: string[];
  /** Cap the number of values returned per facet. */
  facetLimit?: number;
  /**
   * Facet-value filters, keyed by facet field, e.g. `{ place_fct: ["Berlin"] }`.
   * Each becomes a query parameter; repeated values narrow the result set.
   */
  filters?: Record<string, string[]>;
}
