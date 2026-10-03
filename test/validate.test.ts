import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, itemIdProblem, normalizeItemId, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { DdbError, DdbUsageError, DdbValidationError } from "../src/client/errors.js";
import { DdbClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse, requestLines } from "./helpers.js";
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

test("run() maps a DdbValidationError raised in an action to exit 2, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    createClient: () => {
      throw new DdbValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["version"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
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
