import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
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
