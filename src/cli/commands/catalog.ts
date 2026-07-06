// Supporting command: `version` — the DDB backend version, a quick keyless
// connectivity check. Faceting lives in `search --facet` (the search index has no
// separate facets endpoint), so this file holds only `version`.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action } from "../shared.js";

export function registerCatalogCommands(program: Command, deps: CliDeps): void {
  program
    .command("version")
    .description("Print the DDB backend version — a quick connectivity check (no key needed)")
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
