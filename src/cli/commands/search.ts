// The `search` command: full-text / faceted search over the DDB object index.
// v2 is a raw Apache Solr passthrough, so options map onto Solr query params
// (q, rows, start, sort, fq, fl, facet.field) and the output is native Solr JSON.
// Wraps GET /2/search/index/{collection}/{requestHandler}.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { SearchParams } from "../../client/types.js";
import { DdbUsageError } from "../../client/errors.js";
import { action, parseIntArg, parseNonEmpty, renderJson } from "../shared.js";

/** commander accumulator for repeatable string options. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

/**
 * commander value-parser for a URL path segment (Solr collection / request
 * handler). These are interpolated into the request path, so restrict them to a
 * safe character set — a `/` or `?` would otherwise let a value escape the
 * intended `/search/index/{collection}/{requestHandler}` route.
 */
function parsePathSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new InvalidArgumentError("Expected letters, digits, '.', '_' or '-' only.");
  }
  return value;
}

export function registerSearchCommand(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search cultural-heritage objects via the v2 Solr index (returns native Solr JSON)")
    .argument("<query>", "Solr query (q); use '*:*' to match everything")
    .option("--rows <n>", "number of documents to return (Solr rows)", parseIntArg, 10)
    .option("--offset <n>", "offset of the first document (Solr start), for paging", parseIntArg)
    .option("--sort <spec>", "Solr sort, e.g. \"score desc\" or \"id asc\"", parseNonEmpty)
    .option("--fields <list>", "comma-separated fields to return (Solr fl), e.g. id,title", parseNonEmpty)
    .option(
      "--filter <fq>",
      "Solr filter query (fq), repeatable, e.g. type_fct:mediatype_002",
      collect,
    )
    .option("--facet <field>", "compute counts for this facet field (repeatable), e.g. type_fct", collect)
    .option("--facet-limit <n>", "cap the number of values returned per facet", parseIntArg)
    .option("--collection <name>", "Solr collection to query", parsePathSegment, "search")
    .option("--handler <name>", "Solr request handler", parsePathSegment, "select")
    .action(
      action(deps, async ({ client, global, opts }, [query]) => {
        // An empty/whitespace-only query would hit Solr with `q=` and 400 (or
        // silently match nothing); reject it with a clear message up front.
        if (query === undefined || query.trim().length === 0) {
          throw new DdbUsageError(
            "A query is required, e.g. `search Goethe` (or `search '*:*'` for all).",
          );
        }
        const params: SearchParams = { query };
        if (typeof opts["rows"] === "number") params.rows = opts["rows"];
        if (typeof opts["offset"] === "number") params.start = opts["offset"];
        if (typeof opts["sort"] === "string") params.sort = opts["sort"];
        if (typeof opts["fields"] === "string") params.fields = opts["fields"];
        if (typeof opts["facetLimit"] === "number") params.facetLimit = opts["facetLimit"];
        if (typeof opts["collection"] === "string") params.collection = opts["collection"];
        if (typeof opts["handler"] === "string") params.requestHandler = opts["handler"];
        const filters = opts["filter"] as string[] | undefined;
        if (filters && filters.length > 0) params.filters = filters;
        const facets = opts["facet"] as string[] | undefined;
        if (facets && facets.length > 0) params.facetFields = facets;

        const result = await client.search(params);

        // Nudge toward paging when more documents match than were returned, so a
        // capped first page isn't mistaken for the whole result set. `--rows 0`
        // asks for counts/facets only, so paging advice doesn't apply there.
        const body = result.response;
        if (params.rows !== 0 && body && typeof body.numFound === "number") {
          const shown = (body.start ?? 0) + (Array.isArray(body.docs) ? body.docs.length : 0);
          if (body.numFound > shown) {
            deps.io.err(
              `Note: ${body.numFound} documents match; ${shown} shown. ` +
                "Page with --offset (Solr start), or narrow with --filter.",
            );
          }
        }
        renderJson(deps, global, result);
      }),
    );
}
