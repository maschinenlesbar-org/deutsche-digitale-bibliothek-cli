// The primary `search` command: full-text / faceted search over the DDB object
// index. Wraps GET /search.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { SearchParams } from "../../client/types.js";
import { DdbUsageError } from "../../client/errors.js";
import { action, parseBoundedInt, parseIntArg, renderJson } from "../shared.js";

/** commander accumulator for repeatable string options. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

type FilterMap = Record<string, string[]>;

/**
 * commander accumulator for repeatable `facet=value` filters.
 *
 * Repeated occurrences of the same facet are accumulated into a list (the DDB
 * supports repeated facet-value keys to narrow a result set) rather than letting
 * the last value silently clobber the earlier ones.
 */
function collectFilter(value: string, previous: FilterMap = {}): FilterMap {
  const eq = value.indexOf("=");
  // Throw commander's InvalidArgumentError (not a bare DdbError) so the usual
  // parse-error path runs and showHelpAfterError() displays the command help,
  // matching how commander reports its own option errors.
  if (eq <= 0) {
    throw new InvalidArgumentError(`Invalid --filter "${value}". Expected facet=value, e.g. place_fct=Berlin.`);
  }
  const key = value.slice(0, eq);
  const val = value.slice(eq + 1);
  return { ...previous, [key]: (previous[key] ?? []).concat([val]) };
}

const SORTS = new Set(["RELEVANCE", "ALPHA_ASC", "ALPHA_DESC"]);

/**
 * commander value-parser for --sort. Accepts RELEVANCE, ALPHA_ASC, ALPHA_DESC or
 * RANDOM (optionally with a `_<seed>` suffix), case-insensitively, and normalises
 * to the upper-case form the API expects.
 */
function parseSort(value: string): string {
  const v = value.toUpperCase();
  if (SORTS.has(v) || v === "RANDOM" || v.startsWith("RANDOM_")) return v;
  throw new InvalidArgumentError(
    "Expected one of RELEVANCE, ALPHA_ASC, ALPHA_DESC, RANDOM (or RANDOM_<seed>).",
  );
}

export function registerSearchCommand(program: Command, deps: CliDeps): void {
  program
    .command("search")
    .description("Search digitised cultural-heritage objects (GET /search)")
    .argument("<query>", "search term(s), Solr syntax; use '*' to match everything")
    .option("--rows <n>", "number of results to return (0..1000)", parseBoundedInt(0, 1000), 10)
    .option("--offset <n>", "offset of the first result (for paging)", parseIntArg)
    .option("--sort <spec>", "RELEVANCE | ALPHA_ASC | ALPHA_DESC | RANDOM[_<seed>]", parseSort)
    .option("--facet <name>", "compute counts for this facet field (repeatable), e.g. type_fct", collect)
    .option("--facet-limit <n>", "cap the number of values returned per facet", parseIntArg)
    .option(
      "--filter <facet=value>",
      "restrict to a facet value (repeatable), e.g. place_fct=Berlin",
      collectFilter,
    )
    .action(
      action(deps, async ({ client, global, opts }, [query]) => {
        // An empty/whitespace-only query would hit the API with `query=` and
        // fall back to matching everything (rows default!) — reject it so the
        // user gets a clear message instead of an accidental match-all dump.
        if (query === undefined || query.trim().length === 0) {
          throw new DdbUsageError("A query is required, e.g. `search Goethe` (or `search '*'` for all).");
        }
        const params: SearchParams = { query };
        if (typeof opts["rows"] === "number") params.rows = opts["rows"];
        if (typeof opts["offset"] === "number") params.offset = opts["offset"];
        if (typeof opts["sort"] === "string") params.sort = opts["sort"];
        if (typeof opts["facetLimit"] === "number") params.facetLimit = opts["facetLimit"];
        const facets = opts["facet"] as string[] | undefined;
        if (facets && facets.length > 0) params.facet = facets;
        const filters = opts["filter"] as FilterMap | undefined;
        if (filters && Object.keys(filters).length > 0) params.filters = filters;
        renderJson(deps, global, await client.search(params));
      }),
    );
}
