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
import { ITEM_LANG_PARTS } from "../../client/client.js";
import { action, parseNonEmpty, parseSolrInt, renderJson } from "../shared.js";

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
    .option("--rows <n>", "page size for --part children", parseSolrInt)
    .option("--offset <n>", "offset for --part children", parseSolrInt)
    .action(
      action(deps, async ({ client, global, opts }, [id]) => {
        // DDB item ids are exactly 32 upper-case letters and digits. A wrong id
        // would hit a 404 (or the collection endpoint); reject it up front with a
        // clear message so a truncated/typo'd id is obvious. Ids are case
        // sensitive upstream, so a lower-cased paste gets the upper-case form.
        const trimmed = (id ?? "").trim();
        if (trimmed.length !== 32) {
          throw new DdbUsageError(
            `Item id must be exactly 32 characters (got ${trimmed.length}). ` +
              "Copy the `id` from a search result.",
          );
        }
        if (!/^[A-Z0-9]{32}$/.test(trimmed)) {
          throw new DdbUsageError(
            /^[A-Za-z0-9]{32}$/.test(trimmed)
              ? `Item ids are upper case: try "${trimmed.toUpperCase()}".`
              : "Item id must be 32 upper-case letters and digits (A-Z, 0-9). " +
                  "Copy the `id` from a search result.",
          );
        }
        const part = opts["part"] as ItemPart;
        // The API ignores these where they don't apply; say so instead of
        // silently dropping them.
        if (opts["lang"] !== undefined && !ITEM_LANG_PARTS.includes(part)) {
          throw new DdbUsageError(`--lang applies only to --part ${ITEM_LANG_PARTS.join(", ")}.`);
        }
        for (const name of ["rows", "offset"]) {
          if (opts[name] !== undefined && part !== "children") {
            throw new DdbUsageError(`--${name} applies only to --part children.`);
          }
        }        const itemOpts: ItemOptions = {};
        if (typeof opts["lang"] === "string") itemOpts.lang = opts["lang"];
        if (typeof opts["rows"] === "number") itemOpts.rows = opts["rows"];
        if (typeof opts["offset"] === "number") itemOpts.offset = opts["offset"];

        const result = await client.item(trimmed, part, itemOpts);
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
    deps.io.err(`Wrote ${bytes.length} bytes to ${output}`);
  } else if (deps.io.isTerminal?.() === false) {
    deps.io.outBinary(bytes);
  } else {
    deps.io.out(sanitizeServerText(text).replace(/\n$/, ""));
  }
}
