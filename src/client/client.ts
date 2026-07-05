// DdbClient — a typed client over the Deutsche Digitale Bibliothek (DDB) API
// (https://api.deutsche-digitale-bibliothek.de), central access to digitised
// cultural-heritage objects from German archives, libraries and museums.
//
// Auth: an API key sent as `Authorization: OAuth oauth_consumer_key="<key>"`.
// No key is bundled — pass it via `apiKey` (CLI: `--api-key` / `DDB_API_KEY`).
// When no key is supplied the header is omitted and the API answers 403. A
// personal key is free with a "Mein DDB" account; see README.md.
//
//   client.search({ query: "Goethe", rows: 10 })
//   client.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF")

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import type {
  Institution,
  ItemPart,
  JsonObject,
  SearchParams,
  SearchResponse,
  Sector,
} from "./types.js";

const enc = encodeURIComponent;

/** Options for the DDB client (engine options plus the API key). */
export interface DdbClientOptions extends EngineOptions {
  /**
   * The DDB API key, sent as `Authorization: OAuth oauth_consumer_key="<key>"`.
   * No key is bundled; when omitted (or blank) the header is not sent and the API
   * answers 403. A free personal key is available from a "Mein DDB" account.
   */
  apiKey?: string;
}

/** Build the DDB search query parameters from a SearchParams object. */
function searchParamsToQuery(params: SearchParams): QueryParams {
  // Spread facet-value filters first so the well-known core parameters below
  // always win if a filter key happens to collide with one of them.
  const query: QueryParams = { ...(params.filters ?? {}) };
  query["query"] = params.query;
  if (params.rows !== undefined) query["rows"] = params.rows;
  if (params.offset !== undefined) query["offset"] = params.offset;
  if (params.sort !== undefined) query["sort"] = params.sort;
  if (params.facet !== undefined && params.facet.length > 0) query["facet"] = params.facet;
  if (params.facetLimit !== undefined) query["facet.limit"] = params.facetLimit;
  return query;
}

export class DdbClient {
  private readonly engine: RequestEngine;

  constructor(options: DdbClientOptions = {}) {
    const { apiKey, ...engineOptions } = options;
    // Only send Authorization when a non-blank key was supplied; never default one.
    const key = apiKey?.trim() ? apiKey.trim() : undefined;
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        ...(key ? { Authorization: `OAuth oauth_consumer_key="${key}"` } : {}),
        ...engineOptions.defaultHeaders,
      },
    });
  }

  /** Full-text / faceted search over the DDB object index. */
  search(params: SearchParams): Promise<SearchResponse> {
    return this.engine.getJson<SearchResponse>("/search", searchParamsToQuery(params));
  }

  /**
   * Fetch one AIP component of an item by its 32-character id. Defaults to the
   * `view` component (the data set a DDB frontend page is built on).
   */
  item(id: string, part: ItemPart = "view"): Promise<JsonObject> {
    const suffix = part === "aip" ? "" : `/${part}`;
    return this.engine.getJson<JsonObject>(`/items/${enc(id)}${suffix}`);
  }

  /** List the available facet fields. */
  facets(): Promise<JsonObject> {
    return this.engine.getJson<JsonObject>("/search/facets");
  }

  /**
   * List the values (with counts) of one facet, optionally scoped to a query.
   * `facetName` is a field such as `place_fct`, `type_fct` or `provider_fct`.
   */
  facetValues(facetName: string, opts: { query?: string } = {}): Promise<JsonObject> {
    const query: QueryParams = {};
    if (opts.query !== undefined) query["query"] = opts.query;
    return this.engine.getJson<JsonObject>(`/search/facets/${enc(facetName)}`, query);
  }

  /** List institutions registered at the DDB (optionally filtered). */
  institutions(opts: { hasItems?: boolean; sector?: Sector } = {}): Promise<Institution[]> {
    const query: QueryParams = {};
    if (opts.hasItems !== undefined) query["hasItems"] = opts.hasItems;
    if (opts.sector !== undefined) query["sector"] = opts.sector;
    return this.engine.getJson<Institution[]>("/institutions", query);
  }

  /** The version string of the DDB backend. Public — works without an API key. */
  version(): Promise<string> {
    return this.engine.getText("/version");
  }
}
