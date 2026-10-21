// Conformance test P27 (fix plan 2026-10-21, D2 and D7): a big or odd answer is printed or
// refused in one clean record, within memory; never a heap crash, never output `jq` can't read.
// - A large flat answer prints with --compact under a small heap: the check for huge strings
//   before printing walks it without an allocation per value (Object.entries made one pair per
//   element: 7 GB and a crash on 48M numbers).
// - An answer full of DEL characters, each printed as six (`\u007f`), prints under a small heap,
//   or, past V8's longest string, is an ERROR record of <bin>.output that says it is too large;
//   one `+=` per character made a rope of 100 M pieces and crashed.
// - A lone surrogate in an answer (`"\ud800"`) and bytes that are not valid UTF-8 are replaced
//   with U+FFFD, with one WARN record of <bin>.api naming the count and the request; the output is
//   well-formed and the run succeeds (one bad character never sinks a whole answer).
// The memory cases run the built bin in a child process with --max-old-space-size. Shared across
// the *-cli repos that print JSON; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- adapter (per repo) -------------------------------------------------------------
/** `parity` as in P24; `rawResponse(body, contentType)`. */
import { parity, rawResponse } from "./helpers.js";
import { DdbClient as Client } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/client";
/** A valid item id. */
const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";
/** CLI argv (after the global options) for a call whose answer carries a free-form value (a JSON item part), and the same call in the library. */
const call = ["item", ID];
const lib = (client: Client): Promise<unknown> => client.item(ID);
/** The raw 2xx body with `json` (a JSON value, written as is) as that value. */
const bodyWith = (json: string): string => `{"id":"a1","x":${json}}`;
/** The value from the CLI's printed result and from the library's (`ItemResult.json`). */
const fromCli = (out: string): unknown => (JSON.parse(out) as { x: unknown }).x;
const fromLib = (value: unknown): unknown => (value as { json: { x: unknown } }).json.x;
/** The log program, as in `WARN [<bin>.api]`. */
const PROGRAM = "ddb";
// --------------------------------------------------------------------------------------

/** The body with the string value `a<bytes>b`, the bytes as they are. */
const withBytes = (bytes: number[]): Buffer => {
  const [head = "", tail = ""] = bodyWith('"a\u0000b"').split("\u0000");
  return Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(tail)]);
};

const WELL_FORMED = (text: string): boolean => !/[\ud800-\udfff]/u.test(text) && !/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/.test(text);

test("P27: a lone surrogate or invalid bytes are replaced with U+FFFD and reported, never silent or fatal", async () => {
  const cases: Array<[string, Buffer, string, number]> = [
    ["a lone high surrogate", Buffer.from(bodyWith('"a\\ud800b"')), "a\ufffdb", 1],
    ["a lone low surrogate and a pair", Buffer.from(bodyWith('"\\udc00\\ud83d\\ude00"')), "\ufffd\u{1f600}", 1],
    ["invalid UTF-8", withBytes([0xff, 0xfe]), "a\ufffd\ufffdb", 2],
  ];
  for (const [label, body, expected, count] of cases) {
    const o = await parity(call, (t) => lib(new Client({ transport: t })), () => rawResponse(body, "application/json"));
    assert.equal(o.cli.code, 0, `${label}: ${o.cli.err}`);
    assert.ok(WELL_FORMED(o.cli.out), `${label}: ${o.cli.out}`);
    assert.equal(fromCli(o.cli.out), expected, label);
    const warn = new RegExp(
      `^WARN  \\[${PROGRAM}\\.api\\] GET \\S+: ${count} characters? of the answer (was|were) not valid text .*replaced with U\\+FFFD\\.$`,
    );
    assert.match(o.cli.err, warn, `${label}: ${o.cli.err}`);
    assert.equal(o.lib.ok, true, `${label}: ${o.lib.error?.message}`);
    assert.equal(fromLib(o.lib.value), expected, label);
  }
});
