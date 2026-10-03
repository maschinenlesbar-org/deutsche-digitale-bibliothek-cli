// Supporting command: `version` — the DDB backend version, a quick keyless
// connectivity check. Faceting lives in `search --facet` (the search index has no
// separate facets endpoint), so this file holds only `version`.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { sanitizeServerText } from "../../client/engine.js";
import { action } from "../shared.js";

export function registerCatalogCommands(program: Command, deps: CliDeps): void {
  program
    .command("version")
    .description("Print the DDB backend version — a quick connectivity check (no key needed)")
    .action(
      action(deps, async ({ client, global }) => {
        // The library returns the version trimmed.
        const version = await client.version();
        if (global.output) {
          // File output is not sanitised (a file is not a terminal); it gets the
          // version plus a trailing newline.
          const data = Buffer.from(version + "\n", "utf8");
          deps.io.writeFile(global.output, data, global.force);
          deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
        } else {
          // The version string is attacker-controlled under a hostile --base-url;
          // strip control bytes before it reaches the terminal (DDB-01).
          deps.io.out(sanitizeServerText(version));
        }
      }),
    );
}
