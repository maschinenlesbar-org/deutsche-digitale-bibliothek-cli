// The `item` command: fetch one component of a DDB item by its 32-character id.
// Wraps GET /2/items/{id} and its sub-components. JSON components print as JSON;
// the components the API serves as XML / a file (edm, source-record, citation)
// print raw so `> file.xml` / piping keeps them intact.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { ItemOptions, ItemPart } from "../../client/types.js";
import { DdbUsageError } from "../../client/errors.js";
import { sanitizeServerText } from "../../client/engine.js";
import { action, parseIntArg, parseNonEmpty, renderJson } from "../shared.js";

const PARTS: readonly ItemPart[] = [
  "view",
  "aip",
  "edm",
  "binaries",
  "children",
  "parents",
  "source",
  "source-description",
  "source-record",
  "iiif",
  "citation",
];

/** commander value-parser for --part: one of the item components. */
function parsePart(value: string): ItemPart {
  if ((PARTS as readonly string[]).includes(value)) return value as ItemPart;
  throw new InvalidArgumentError(`Expected one of: ${PARTS.join(", ")}.`);
}

export function registerItemCommand(program: Command, deps: CliDeps): void {
  program
    .command("item")
    .description("Fetch one item component by its 32-character id (GET /2/items/{id})")
    .argument("<id>", "the 32-character DDB item id (from a search result's `id`)")
    .option(
      "--part <component>",
      `component to fetch: ${PARTS.join(" | ")} (default view)`,
      parsePart,
      "view",
    )
    .option("--lang <code>", "preferred language for labels (view/aip/edm/binaries/source*)", parseNonEmpty)
    .option("--rows <n>", "page size for --part children", parseIntArg)
    .option("--offset <n>", "offset for --part children", parseIntArg)
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
        const itemOpts: ItemOptions = {};
        if (typeof opts["lang"] === "string") itemOpts.lang = opts["lang"];
        if (typeof opts["rows"] === "number") itemOpts.rows = opts["rows"];
        if (typeof opts["offset"] === "number") itemOpts.offset = opts["offset"];

        const result = await client.item(trimmed, part, itemOpts);
        if (result.text !== undefined) {
          // XML / BIB file component: emit the raw body verbatim (no JSON quoting).
          writeText(deps, global.output, result.text, global.force);
        } else {
          renderJson(deps, global, result.json);
        }
      }),
    );
}

/**
 * Write a raw text body to --output (with a stderr note) or to stdout.
 *
 * The XML/edm/citation body is attacker-controlled (a hostile `--base-url` or a
 * MITM'd upstream). When it goes to the terminal we strip C0/C1 control bytes
 * (keeping tab/newline) so it can't drive ANSI/OSC escape sequences into the
 * user's shell (DDB-01). We do NOT alter the XML structure — only control bytes
 * are removed. File output via `-o` keeps the bytes verbatim: the file is not a
 * terminal, and callers piping to `> file.xml` expect the exact upstream bytes.
 */
function writeText(
  deps: CliDeps,
  output: string | undefined,
  text: string,
  force: boolean | undefined,
): void {
  if (output) {
    const data = Buffer.from(text.endsWith("\n") ? text : text + "\n", "utf8");
    deps.io.writeFile(output, data, force);
    deps.io.err(`Wrote ${data.length} bytes to ${output}`);
  } else {
    deps.io.out(sanitizeServerText(text).replace(/\n$/, ""));
  }
}
