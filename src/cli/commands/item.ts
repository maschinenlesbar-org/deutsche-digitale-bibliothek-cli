// The `item` command: fetch one AIP component of a DDB item by its 32-character
// id. Wraps GET /items/{id} and its JSON sub-components.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { ItemPart } from "../../client/types.js";
import { DdbUsageError } from "../../client/errors.js";
import { action, renderJson } from "../shared.js";

const PARTS: readonly ItemPart[] = [
  "view",
  "aip",
  "edm",
  "binaries",
  "children",
  "parents",
  "indexing-profile",
];

/** commander value-parser for --part: one of the JSON-returning AIP components. */
function parsePart(value: string): ItemPart {
  if ((PARTS as readonly string[]).includes(value)) return value as ItemPart;
  throw new InvalidArgumentError(`Expected one of: ${PARTS.join(", ")}.`);
}

export function registerItemCommand(program: Command, deps: CliDeps): void {
  program
    .command("item")
    .description("Fetch one item by its 32-character id (GET /items/{id})")
    .argument("<id>", "the 32-character DDB item id (from a search result's `id`)")
    .option(
      "--part <component>",
      `AIP component to fetch: ${PARTS.join(" | ")} (default view)`,
      parsePart,
      "view",
    )
    .action(
      action(deps, async ({ client, global, opts }, [id]) => {
        // DDB item ids are exactly 32 characters. A wrong-length id would hit a
        // 404 (or the collection endpoint); reject it up front with a clear
        // message so a truncated/typo'd id is obvious.
        const trimmed = (id ?? "").trim();
        if (trimmed.length !== 32) {
          throw new DdbUsageError(
            `Item id must be exactly 32 characters (got ${trimmed.length}). ` +
              "Copy the `id` from a search result.",
          );
        }
        const part = opts["part"] as ItemPart;
        renderJson(deps, global, await client.item(trimmed, part));
      }),
    );
}
