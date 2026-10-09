// The `item` command: fetch one component of a DDB item by its 32-character id.
// Wraps GET /2/items/{id} and its sub-components. JSON components print as JSON;
// the components the API serves as XML / a file (edm, source-record, citation)
// print raw so `> file.xml` / piping keeps them intact.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "../io.js";
import {
  ITEM_LANG_PARTS,
  ITEM_PARTS,
  itemPartProblem,
  type ItemOptions,
  type ItemPart,
} from "../../client/index.js";
import { sanitizeServerText } from "../../client/engine.js";
import { action, parseNonEmpty, parseSolrInt, renderJson } from "../shared.js";

/** commander value-parser for --part: the library's rule (itemPartProblem). */
function parsePart(value: string): ItemPart {
  const problem = itemPartProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value as ItemPart;
}

export function registerItemCommand(program: Command, deps: CliDeps): void {
  program
    .command("item")
    .description("Fetch one item component by its 32-character id (GET /2/items/{id})")
    .argument("<id>", "the 32-character DDB item id (from a search result's `id`)")
    .option(
      "--part <component>",
      `component to fetch: ${ITEM_PARTS.join(" | ")} (default view)`,
      parsePart,
      "view",
    )
    .option("--lang <code>", `preferred language for labels (${ITEM_LANG_PARTS.join("/")})`, parseNonEmpty)
    .option("--rows <n>", "page size for --part children", parseSolrInt)
    .option("--offset <n>", "offset for --part children", parseSolrInt)
    .action(
      action(deps, async ({ client, global, opts }, [id]) => {
        const part = opts["part"] as ItemPart;
        const itemOpts: ItemOptions = {};
        if (typeof opts["lang"] === "string") itemOpts.lang = opts["lang"];
        if (typeof opts["rows"] === "number") itemOpts.rows = opts["rows"];
        if (typeof opts["offset"] === "number") itemOpts.offset = opts["offset"];

        // The library trims the id and rejects a malformed one (normalizeItemId),
        // and --lang/--rows/--offset for a part that ignores them
        // (validateItemOptions), before any request; run.ts maps that to exit 2.
        const result = await client.item(id ?? "", part, itemOpts);
        if (result.heldBy !== undefined) {
          // The API pointed the component at an ancestor (a book section's or an archive
          // unit's source record); say whose it is, so the whole parent record isn't
          // mistaken for one of the requested item.
          logOf(deps).info(
            "api",
            `item ${(id ?? "").trim()} has no ${part} of its own; this is the ${part} of its ancestor ` +
              `${result.heldBy}, which the API points to.`,
          );
        }
        if (result.text !== undefined) {
          // XML / BIB file component: emit the raw body (no JSON quoting).
          const bytes = result.bytes ?? Buffer.from(result.text, "utf8");
          writeRaw(deps, global.output, result.text, bytes, global.force);
        } else {
          renderJson(deps, global, result.json);
        }
      }),
    );
}

/**
 * Write a raw XML/file body to --output (with a stderr note) or to stdout.
 *
 * `-o` and a non-terminal stdout (`> file.xml`, a pipe) get the exact upstream
 * bytes: any charset, CRs and control bytes intact, nothing appended.
 *
 * The body is attacker-controlled (a hostile `--base-url` or a MITM'd upstream).
 * Only when stdout is a terminal is it decoded and stripped of C0/C1 control bytes
 * (keeping tab/newline) so it can't drive ANSI/OSC escape sequences into the
 * user's shell (DDB-01). The XML structure is not altered.
 */
function writeRaw(
  deps: CliDeps,
  output: string | undefined,
  text: string,
  bytes: Buffer,
  force: boolean | undefined,
): void {
  if (output) {
    deps.io.writeFile(output, bytes, force);
    logOf(deps).info("output", `Wrote ${bytes.length} bytes to ${output}`);
  } else if (deps.io.isTerminal?.() === false) {
    deps.io.outBinary(bytes);
  } else {
    deps.io.out(sanitizeServerText(text).replace(/\n$/, ""));
  }
}
