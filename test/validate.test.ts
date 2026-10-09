import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHeaderValue,
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  itemIdProblem,
  itemPartProblem,
  normalizeItemId,
  pathNameProblem,
  type Problem,
} from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { ITEM_PARTS } from "../src/client/types.js";
import { DdbError, DdbUsageError, DdbValidationError } from "../src/client/errors.js";
import { DdbClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse, requestLines, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("query", "Goethe", nonBlank), "Goethe");
});

test("assertValid throws DdbValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("query", "  ", nonBlank),
    (err: unknown) =>
      err instanceof DdbValidationError &&
      err instanceof DdbUsageError &&
      err instanceof DdbError &&
      err.name === "DdbValidationError" &&
      err.message === "Invalid query: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.DdbValidationError, DdbValidationError);
});

test("run() maps a DdbValidationError raised in an action to exit 2 and an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: () => {
      throw new DdbValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["version"], deps), 2);
  assert.deepEqual(err.map(untimed), ["ERROR [ddb.cli] Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "search", "Goethe", "--rows", "10"],
    (transport) => new DdbClient({ transport }).search({ query: "Goethe", rows: 10 }),
    () => jsonResponse(fx.solrExact),
  );
  assert.equal(cli.code, 0);
  assert.equal(l.ok, true);
  assert.deepEqual(requestLines(cli.requests), requestLines(l.requests));
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});

test("itemIdProblem: 32 upper-case letters and digits, with a hint for lower case", () => {
  const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";
  assert.equal(itemIdProblem(ID), undefined);
  assert.equal(itemIdProblem("ABC"), "Expected exactly 32 characters (got 3). Copy the `id` from a search result.");
  assert.equal(itemIdProblem(""), "Expected exactly 32 characters (got 0). Copy the `id` from a search result.");
  assert.equal(itemIdProblem(ID.toLowerCase()), `Item ids are upper case: try "${ID}".`);
  for (const bad of [`${ID.slice(0, 31)}!`, ".".repeat(32), "/".repeat(32), ` ${ID.slice(1)}`]) {
    assert.equal(
      itemIdProblem(bad),
      "Expected 32 upper-case letters and digits (A-Z, 0-9). Copy the `id` from a search result.",
      bad,
    );
  }
  assert.equal(itemIdProblem(42), "Expected a string.");
});

test("normalizeItemId trims, validates and is idempotent", () => {
  const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";
  assert.equal(normalizeItemId(` ${ID}\n`), ID);
  assert.equal(normalizeItemId(normalizeItemId(ID)), ID);
  assert.throws(
    () => normalizeItemId("abc"),
    (err: unknown) =>
      err instanceof DdbValidationError &&
      err.message === "Invalid id: Expected exactly 32 characters (got 3). Copy the `id` from a search result.",
  );
  assert.equal(lib.normalizeItemId, normalizeItemId);
  assert.equal(lib.itemIdProblem, itemIdProblem);
});

test("pathNameProblem: letters, digits, '.', '_' and '-', but not '.' or '..'", () => {
  for (const ok of ["search", "select", "news_paper-1.0", "a..b"]) assert.equal(pathNameProblem(ok), undefined, ok);
  for (const bad of ["", " search ", "a/b", "ü", "%2e", "select?x=1"]) {
    assert.equal(pathNameProblem(bad), "Expected letters, digits, '.', '_' or '-' only.", bad);
  }
  for (const dots of [".", ".."]) {
    assert.equal(pathNameProblem(dots), '"." and ".." are path navigation, not a name.', dots);
  }
  assert.equal(pathNameProblem(7), "Expected a string.");
  assert.equal(lib.pathNameProblem, pathNameProblem);
});

test("headerValueProblem: non-blank, no control characters, Latin-1 only; tab is allowed", () => {
  const ctl = (c: number) => `a${String.fromCharCode(c)}b`;
  assert.equal(headerValueProblem("müller-bot/1.0\t(test)"), undefined);
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem(" \t "), "Expected a non-empty value.");
  for (const c of [0x00, 0x0a, 0x0d, 0x1b, 0x7f]) {
    assert.equal(headerValueProblem(ctl(c)), "Value contains control characters.", String(c));
  }
  assert.equal(headerValueProblem("bot \u20ac"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(1), "Expected a string.");
});

test("headerNameProblem: an HTTP token", () => {
  assert.equal(headerNameProblem("X-Api-Key"), undefined);
  for (const bad of ["", "X Foo", "X:Foo", "Ü"]) {
    assert.equal(headerNameProblem(bad), "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).", bad);
  }
});

test("assertHeaderValue returns the value or throws DdbValidationError naming the header", () => {
  assert.equal(assertHeaderValue("User-Agent", "bot/1"), "bot/1");
  assert.throws(
    () => assertHeaderValue("User-Agent", ""),
    (err: unknown) => err instanceof DdbValidationError && err.message === "Invalid User-Agent: Expected a non-empty value.",
  );
  assert.equal(lib.assertHeaderValue, assertHeaderValue);
  assert.equal(lib.headerValueProblem, headerValueProblem);
});

test("the client checks userAgent and defaultHeaders at construction", () => {
  const LF = String.fromCharCode(0x0a);
  assert.throws(() => new DdbClient({ userAgent: "" }), /^DdbValidationError: Invalid userAgent: Expected a non-empty value\.$/);
  assert.throws(
    () => new DdbClient({ defaultHeaders: { "X-Foo": `a${LF}b` } }),
    (err: unknown) =>
      err instanceof DdbValidationError && err.message === 'Invalid defaultHeaders["X-Foo"]: Value contains control characters.',
  );
  assert.throws(
    () => new DdbClient({ defaultHeaders: { "X Foo": "a" } }),
    (err: unknown) => err instanceof DdbValidationError && err.message.startsWith('Invalid defaultHeaders name "X Foo": '),
  );
  assert.doesNotThrow(() => new DdbClient({ userAgent: "bot/1", defaultHeaders: { Authorization: "Bearer x" } }));
});

test("baseUrlProblem: the CLI's --base-url reasons", () => {
  assert.equal(baseUrlProblem("https://api.deutsche-digitale-bibliothek.de/2"), undefined);
  assert.equal(baseUrlProblem("http://user:pw@127.0.0.1:8080/2/"), undefined);
  assert.equal(baseUrlProblem(""), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem(" \t"), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem(" https://h.example/2"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("not a url"), "Expected a valid URL.");
  assert.equal(baseUrlProblem("ftp://h.example"), "Only http: and https: base URLs are supported.");
  assert.equal(baseUrlProblem("https://h.example/2#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(3), "Expected a string.");
  assert.equal(lib.baseUrlProblem, baseUrlProblem);
});

test("itemPartProblem: one of ITEM_PARTS, nothing inherited", () => {
  for (const part of ITEM_PARTS) assert.equal(itemPartProblem(part), undefined, part);
  const reason = `Expected one of: ${ITEM_PARTS.join(", ")}.`;
  for (const bad of ["bogus", "", "View", "toString", "__proto__", 1]) assert.equal(itemPartProblem(bad), reason, String(bad));
  assert.equal(lib.itemPartProblem, itemPartProblem);
});

test("the item part lists and the Solr int bound are exported from the package root", () => {
  assert.deepEqual(
    [...lib.ITEM_PARTS],
    ["view", "aip", "edm", "binaries", "children", "parents", "source", "source-description", "source-record", "iiif", "citation"],
  );
  assert.deepEqual([...lib.ITEM_LANG_PARTS], ["view", "aip", "edm", "binaries", "source", "source-description"]);
  for (const part of lib.ITEM_LANG_PARTS) assert.ok(lib.ITEM_PARTS.includes(part), part);
  assert.equal(lib.SOLR_MAX_INT, 2_147_483_647);
  assert.ok(Object.isFrozen(lib.ITEM_PARTS) && Object.isFrozen(lib.ITEM_LANG_PARTS));
});
