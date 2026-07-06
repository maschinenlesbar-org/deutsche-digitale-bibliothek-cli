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
import { DdbParseError } from "./errors.js";
import type { QueryParams } from "./query.js";
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

/** Item parts that accept a `lang` query parameter for localised labels. */
const LANG_PARTS = new Set<ItemPart>([
  "view",
  "aip",
  "edm",
  "binaries",
  "source",
  "source-description",
]);

export class DdbClient {
  private readonly engine: RequestEngine;

  constructor(options: DdbClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Search the DDB object index via the v2 Solr passthrough
   * (`GET /2/search/index/{collection}/{requestHandler}`). Values use Solr
   * syntax; the response is native Solr JSON. `wt=json` is always forced.
   */
  search(params: SearchParams): Promise<SolrResponse> {
    const collection = params.collection ?? "search";
    const handler = params.requestHandler ?? "select";
    const query: QueryParams = { q: params.query, wt: "json" };
    if (params.rows !== undefined) query["rows"] = params.rows;
    if (params.start !== undefined) query["start"] = params.start;
    if (params.sort !== undefined) query["sort"] = params.sort;
    if (params.fields !== undefined) query["fl"] = params.fields;
    if (params.filters !== undefined && params.filters.length > 0) query["fq"] = params.filters;
    if (params.facetFields !== undefined && params.facetFields.length > 0) {
      query["facet"] = "true";
      query["facet.field"] = params.facetFields;
      if (params.facetLimit !== undefined) query["facet.limit"] = params.facetLimit;
    }
    return this.engine.getJson<SolrResponse>(
      `/search/index/${enc(collection)}/${enc(handler)}`,
      query,
    );
  }

  /**
   * Fetch one component of an item by its 32-character id (defaults to `view`).
   * Decodes by Content-Type: JSON components are parsed into `json`, while the
   * XML / file components (edm, source-record, citation) are returned as `text`.
   */
  async item(id: string, part: ItemPart = "view", opts: ItemOptions = {}): Promise<ItemResult> {
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
    return { part, contentType: res.contentType, text };
  }

  /** The version string of the DDB backend. Public — works without a key. */
  version(): Promise<string> {
    return this.engine.getText("/version");
  }
}
