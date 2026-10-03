// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes, on one recording mock transport, must give the same outcome
// (both reject before any request, or both send the identical request).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DdbClient } from "../src/client/client.js";
import { DdbValidationError } from "../src/client/errors.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { parity, jsonResponse, requestLines, type ParityResult } from "./helpers.js";
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
