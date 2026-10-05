// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DdbClient as Client } from "../src/client/client.js";
import { DdbValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.search(query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { query: "Goethe", filters: ["sector_fct:sec_01", "type_fct:mediatype_002"] } };
const GOOD_SENT = "sector_fct:sec_01 | type_fct:mediatype_002";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).searchParams.getAll("fq").join(" | ");
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { query: "Goethe", fq: ["sector_fct:sec_01"] }],
  ["misspelled key", { query: "Goethe", filter: ["sector_fct:sec_01"] }],
  ["wrong-case key", { query: "Goethe", Filters: ["sector_fct:sec_01"] }],
  ["__proto__ key", JSON.parse('{"query": "Goethe", "__proto__": {"filters": ["sector_fct:sec_01"]}}') as Record<string, unknown>],
  ["constructor key", JSON.parse('{"query": "Goethe", "constructor": {"filters": ["sector_fct:sec_01"]}}') as Record<string, unknown>],
];
/**
 * Queries whose filter names the API doesn't have. None for ddb: filters are Solr syntax
 * passed through, and Solr itself rejects an unknown field (HTTP 400 "undefined field",
 * exit 1; result 01 note 9) rather than ignoring it, so there is no name list to check.
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array query", { query: ["Goethe", "Schiller"] }],
  ["string filters", { query: "Goethe", filters: "sector_fct:sec_01" }],
  ["object filters", { query: "Goethe", filters: { sector_fct: "sec_01" } }],
  ["array sort", { query: "Goethe", sort: ["id asc"] }],
  ["NaN rows", { query: "Goethe", rows: Number.NaN }],
  ["array start", { query: "Goethe", start: [1, 2] }],
  ["NaN facetLimit", { query: "Goethe", facetFields: ["type_fct"], facetLimit: Number.NaN }],
];
/**
 * Queries that differ from GOOD only in how a filter name is spelled. None for ddb: a
 * filter is free Solr syntax, which Solr parses itself (whitespace included); field names
 * are ASCII and case-sensitive, and an unknown one is an HTTP 400 (see BAD_FILTER_NAMES).
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (the two halves of GOOD), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["search", "Goethe", "--filter", "sector_fct:sec_01", "--filter", "type_fct:mediatype_002"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["search", "Goethe", "--sort", "score desc", "--sort", "id asc"];
const USAGE_EXIT = 2;
/** The register's filter columns for the category (unused by ddb: no column list). */
const COLUMNS: unknown[] = [];
/** True for a request that fetches data (every ddb request does). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify(COLUMNS.length === 0 ? { response: { numFound: 1, start: 0, docs: [] } } : COLUMNS)),
});
/** CliDeps for this repo (its io also writes files and raw bytes). */
const makeDeps = (io: Pick<CliDeps["io"], "out" | "err">, transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io: { ...io, writeFile: () => {}, outBinary: () => {} },
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
