// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes, on one recording mock transport, must give the same outcome
// (both reject before any request, or both send the identical request).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient, DEFAULT_SEARCH_ROWS } from "../src/client/client.js";
import { DdbValidationError } from "../src/client/errors.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import type { ItemOptions, ItemPart } from "../src/client/types.js";
import { parity, jsonResponse, rawResponse, requestLines, type ParityResult } from "./helpers.js";
import * as fx from "./fixtures.js";

const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";

/** Answers only the exact item id; anything else is the DDB 404 envelope. */
const itemResponder = (req: HttpRequest): HttpResponse =>
  new URL(req.url).pathname.startsWith(`/2/items/${ID}`) ? jsonResponse(fx.itemView) : jsonResponse(fx.notFound, 404);

/** Both sides rejected the input as a validation error, and neither sent a request. */
function assertBothRejected(r: ParityResult, label: string): void {
  assert.equal(r.cli.code, 2, `${label}: CLI exit`);
  assert.equal(r.cli.requests.length, 0, `${label}: CLI requests`);
  assert.equal(r.lib.ok, false, `${label}: library resolved`);
  if (!r.lib.ok) assert.ok(r.lib.error instanceof DdbValidationError, `${label}: ${String(r.lib.error)}`);
  assert.equal(r.lib.requests.length, 0, `${label}: library requests`);
  if (!r.lib.ok && r.lib.error instanceof Error) assert.equal(r.cli.err, `Error: ${r.lib.error.message}`, label);
}

/** Both sides succeeded with the identical request(s). */
function assertSameRequests(r: ParityResult, label: string): void {
  assert.equal(r.cli.code, 0, `${label}: CLI exit (${r.cli.err})`);
  assert.equal(r.lib.ok, true, `${label}: library ${r.lib.ok ? "" : String(r.lib.error)}`);
  assert.ok(r.cli.requests.length > 0, `${label}: no request`);
  assert.deepEqual(requestLines(r.cli.requests), requestLines(r.lib.requests), label);
}

test("parity: a padded item id is trimmed on both sides (finding #1)", async () => {
  for (const id of [` ${ID} `, `${ID}\n`, `\t${ID}`]) {
    const r = await parity(["--compact", "item", id], (t) => new DdbClient({ transport: t }).item(id), itemResponder);
    assertSameRequests(r, JSON.stringify(id));
    assert.equal(r.lib.requests[0]!.url, `https://api.deutsche-digitale-bibliothek.de/2/items/${ID}/view`);
  }
  const edm = ` ${ID} `;
  const r = await parity(
    ["--compact", "item", edm, "--part", "edm"],
    (t) => new DdbClient({ transport: t }).item(edm, "edm"),
    itemResponder,
  );
  assertSameRequests(r, "padded id, edm");
});

test("parity: a malformed item id is rejected on both sides before any request (finding #1)", async () => {
  for (const id of ["", "   ", "ABC", "a/b", ID.toLowerCase(), `${ID.slice(0, 31)}!`, ".".repeat(32), "😀".repeat(16)]) {
    const r = await parity(["--compact", "item", id], (t) => new DdbClient({ transport: t }).item(id), itemResponder);
    assertBothRejected(r, JSON.stringify(id));
  }
});

test("parity: search collection and handler names are checked on both sides (finding #5)", async () => {
  const cases: [string, string, Record<string, string>][] = [];
  for (const v of [" search ", "a/b", "ü", "%2e%2e", " .. ", "..", ".", ""]) {
    cases.push(["--collection", v, { collection: v }]);
  }
  for (const v of ["sel/ect", "select?x=1", " select", ".."]) cases.push(["--handler", v, { requestHandler: v }]);
  for (const [flag, value, params] of cases) {
    const r = await parity(
      ["--compact", "search", "Goethe", flag, value, "--rows", "10"],
      (t) => new DdbClient({ transport: t }).search({ query: "Goethe", rows: 10, ...params }),
      () => jsonResponse(fx.solrExact),
    );
    const label = `${flag} ${JSON.stringify(value)}`;
    assert.equal(r.cli.code, 2, label);
    assert.equal(r.cli.requests.length, 0, label);
    assert.equal(r.lib.ok, false, label);
    if (!r.lib.ok) assert.ok(r.lib.error instanceof DdbValidationError, `${label}: ${String(r.lib.error)}`);
    assert.equal(r.lib.requests.length, 0, label);
  }
  const ok = await parity(
    ["--compact", "search", "Goethe", "--collection", "news_paper-1.0", "--handler", "mlt", "--rows", "10"],
    (t) => new DdbClient({ transport: t }).search({ query: "Goethe", rows: 10, collection: "news_paper-1.0", requestHandler: "mlt" }),
    () => jsonResponse(fx.solrExact),
  );
  assertSameRequests(ok, "valid names");
});

test("parity: search sends the same default page size on both sides (finding #6)", async () => {
  const plain = await parity(
    ["--compact", "search", "Goethe"],
    (t) => new DdbClient({ transport: t }).search({ query: "Goethe" }),
    () => jsonResponse(fx.solrExact),
  );
  assertSameRequests(plain, "no rows");
  assert.equal(new URL(plain.lib.requests[0]!.url).searchParams.get("rows"), String(DEFAULT_SEARCH_ROWS));
  const facet = await parity(
    ["--compact", "search", "Goethe", "--facet", "type_fct"],
    (t) => new DdbClient({ transport: t }).search({ query: "Goethe", facetFields: ["type_fct"] }),
    () => jsonResponse(fx.solrExact),
  );
  assertSameRequests(facet, "facet, no rows");
  const zero = await parity(
    ["--compact", "search", "Goethe", "--rows", "0"],
    (t) => new DdbClient({ transport: t }).search({ query: "Goethe", rows: 0 }),
    () => jsonResponse(fx.solrExact),
  );
  assertSameRequests(zero, "rows 0");
  assert.equal(new URL(zero.lib.requests[0]!.url).searchParams.get("rows"), "0");
});

test("parity: item lang/rows/offset for a part that ignores them are rejected on both sides (finding #2)", async () => {
  const cases: [string[], ItemPart | undefined, ItemOptions][] = [
    [["--part", "iiif", "--lang", "en"], "iiif", { lang: "en" }],
    [["--part", "children", "--lang", "en"], "children", { lang: "en" }],
    [["--part", "citation", "--lang", "en"], "citation", { lang: "en" }],
    [["--part", "view", "--rows", "5", "--offset", "3"], "view", { rows: 5, offset: 3 }],
    [["--rows", "5"], undefined, { rows: 5 }],
    [["--part", "parents", "--offset", "5"], "parents", { offset: 5 }],
    [["--part", "aip", "--rows", "5"], "aip", { rows: 5 }],
  ];
  for (const [args, part, opts] of cases) {
    const r = await parity(
      ["--compact", "item", ID, ...args],
      (t) => new DdbClient({ transport: t }).item(ID, part, opts),
      itemResponder,
    );
    assertBothRejected(r, args.join(" "));
  }
  const children = await parity(
    ["--compact", "item", ID, "--part", "children", "--rows", "5", "--offset", "3"],
    (t) => new DdbClient({ transport: t }).item(ID, "children", { rows: 5, offset: 3 }),
    itemResponder,
  );
  assertSameRequests(children, "children rows/offset");
  const edm = await parity(
    ["--compact", "item", ID, "--part", "edm", "--lang", "de"],
    (t) => new DdbClient({ transport: t }).item(ID, "edm", { lang: "de" }),
    itemResponder,
  );
  assertSameRequests(edm, "edm lang");
});

test("parity: a User-Agent the CLI rejects is rejected by the library before any request (finding #4)", async () => {
  const LF = String.fromCharCode(0x0a);
  const CR = String.fromCharCode(0x0d);
  const DEL = String.fromCharCode(0x7f);
  const cases: [string, string][] = [
    ["", "Expected a non-empty value."],
    ["  ", "Expected a non-empty value."],
    [`a${CR}${LF}X-Evil: 1`, "Value contains control characters."],
    [`bot${DEL}`, "Value contains control characters."],
    ["Ω-agent", "Value contains characters outside Latin-1 (above U+00FF)."],
  ];
  for (const [ua, reason] of cases) {
    const r = await parity(
      ["--user-agent", ua, "version"],
      (t) => new DdbClient({ transport: t, userAgent: ua }).version(),
      () => rawResponse("2.3.4", "text/plain"),
    );
    const label = JSON.stringify(ua);
    assert.equal(r.cli.code, 2, label);
    assert.equal(r.cli.requests.length, 0, label);
    assert.match(r.cli.err, new RegExp(reason.replace(/[.()+]/g, "\\$&")), label);
    assert.equal(r.lib.ok, false, label);
    if (!r.lib.ok) {
      assert.ok(r.lib.error instanceof DdbValidationError, `${label}: ${String(r.lib.error)}`);
      assert.equal((r.lib.error as Error).message, `Invalid userAgent: ${reason}`, label);
    }
    assert.equal(r.lib.requests.length, 0, label);
  }
  for (const ua of ["a\tb", "café"]) {
    const r = await parity(
      ["--user-agent", ua, "version"],
      (t) => new DdbClient({ transport: t, userAgent: ua }).version(),
      () => rawResponse("2.3.4", "text/plain"),
    );
    assertSameRequests(r, JSON.stringify(ua));
    assert.equal(r.cli.requests[0]!.headers?.["User-Agent"], ua);
    assert.equal(r.lib.requests[0]!.headers?.["User-Agent"], ua);
  }
});
