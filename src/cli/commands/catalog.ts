// Supporting commands: `facets` (explore the facet fields and their values),
// `institutions` (the registered archives/libraries/museums), and `version`
// (the DDB backend version, also a quick API-key smoke test).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { Sector } from "../../client/types.js";
import { action, parseNonEmpty, renderJson } from "../shared.js";

const SECTORS: Record<Sector, string> = {
  sec_01: "Archive",
  sec_02: "Library",
  sec_03: "Monument protection",
  sec_04: "Research",
  sec_05: "Media",
  sec_06: "Museum",
  sec_07: "Other",
};

/** commander value-parser for --sector: one of the DDB cultural-sector codes. */
function parseSector(value: string): Sector {
  if (value in SECTORS) return value as Sector;
  const list = Object.entries(SECTORS)
    .map(([code, name]) => `${code} (${name})`)
    .join(", ");
  throw new InvalidArgumentError(`Expected one of: ${list}.`);
}

export function registerCatalogCommands(program: Command, deps: CliDeps): void {
  program
    .command("facets")
    .description("List the available facet fields, or the values of one facet")
    .argument("[name]", "a facet field (e.g. place_fct, type_fct); omit to list all facets")
    .option("--query <q>", "scope the facet counts to this search query", parseNonEmpty)
    .action(
      action(deps, async ({ client, global, opts }, [name]) => {
        if (name === undefined || name.trim().length === 0) {
          renderJson(deps, global, await client.facets());
          return;
        }
        const query = typeof opts["query"] === "string" ? { query: opts["query"] } : {};
        renderJson(deps, global, await client.facetValues(name, query));
      }),
    );

  program
    .command("institutions")
    .description("List the archives, libraries and museums registered at the DDB")
    .option("--sector <code>", "filter by cultural sector (sec_01..sec_07)", parseSector)
    .option("--has-items", "only institutions that have items in the DDB")
    .action(
      action(deps, async ({ client, global, opts }) => {
        const params: { hasItems?: boolean; sector?: Sector } = {};
        if (opts["hasItems"] === true) params.hasItems = true;
        if (typeof opts["sector"] === "string") params.sector = opts["sector"] as Sector;
        renderJson(deps, global, await client.institutions(params));
      }),
    );

  program
    .command("version")
    .description("Print the DDB backend version — works without a key (a quick connectivity check)")
    .action(
      action(deps, async ({ client, global }) => {
        const version = (await client.version()).trim();
        if (global.output) {
          const data = Buffer.from(version + "\n", "utf8");
          deps.io.writeFile(global.output, data);
          deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
        } else {
          deps.io.out(version);
        }
      }),
    );
}
