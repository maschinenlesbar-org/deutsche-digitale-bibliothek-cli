import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DdbClient } from "../src/client/client.js";
import { credentialsIn } from "../src/client/errors.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO, type CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";

// Control chars via char codes so no raw control byte appears in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function makeCli(responder: (req: HttpRequest) => HttpResponse, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files: { path: string; data: Buffer; force?: boolean }[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (path, data, force) => files.push({ path, data, force }),
      outBinary: () => {},
    },
    createClient: (opts) => new DdbClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, files, mt };
}

test("search renders the response and hits the Solr passthrough path", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "Goethe"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/2/search/index/search/select");
  assert.equal(queryOf(cli.mt.last()).get("q"), "Goethe");
  assert.equal(JSON.parse(cli.out.join("\n")).response.numFound, 99866);
});

test("search defaults to rows=10 (never the Solr default)", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  await run(["search", "Goethe"], cli.deps);
  assert.equal(queryOf(cli.mt.last()).get("rows"), "10");
});

test("search forwards --rows, --sort, --fields, repeated --facet and repeated --filter", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  await run(
    [
      "search", "Goethe",
      "--rows", "5",
      "--sort", "id asc",
      "--fields", "id,title",
      "--facet", "type_fct", "--facet", "place_fct",
      "--filter", "type_fct:mediatype_002", "--filter", 'place_fct:"Berlin"',
    ],
    cli.deps,
  );
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("rows"), "5");
  assert.equal(q.get("sort"), "id asc");
  assert.equal(q.get("fl"), "id,title");
  assert.deepEqual(q.getAll("facet.field"), ["type_fct", "place_fct"]);
  assert.deepEqual(q.getAll("fq"), ["type_fct:mediatype_002", 'place_fct:"Berlin"']);
});

test("search maps --offset to Solr start", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  await run(["search", "x", "--offset", "40"], cli.deps);
  assert.equal(queryOf(cli.mt.last()).get("start"), "40");
});

test("search prints a paging note to stderr when more match than returned", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  await run(["search", "Goethe"], cli.deps);
  assert.match(cli.err.join("\n"), /99866 documents match; 2 shown/);
});

test("the paging note counts only this page's documents and names their positions", async () => {
  const page = { response: { numFound: 99215, start: 20, docs: [{ id: "a" }, { id: "b" }, { id: "c" }] } };
  const cli = makeCli(() => jsonResponse(page));
  await run(["search", "Goethe", "--rows", "3", "--offset", "20"], cli.deps);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[ddb\.api\] 99215 documents match; 3 shown \(21–23\)\. /);
});

test("the paging note ignores a non-numeric start", async () => {
  const odd = { response: { numFound: 10, start: "-5", docs: [{ id: "a" }, { id: "b" }] } };
  const cli = makeCli(() => jsonResponse(odd));
  await run(["search", "x"], cli.deps);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[ddb\.api\] 10 documents match; 2 shown\. /);
});

test("--handler whose answer is not Solr's response envelope fails naming the handler and the rule", async () => {
  // e.g. a real-time-get style answer: { doc: … } with no `response` object.
  const cli = makeCli(() => jsonResponse({ responseHeader: { status: 0 }, doc: { id: "a" } }));
  const code = await run(["search", "x", "--handler", "get"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/2/search/index/search/get");
  assert.equal(
    untimed(cli.err.join("\n")),
    "ERROR [ddb.cli] Unexpected response shape from /search/index/search/get: expected a response object. " +
      "Only request handlers that return Solr's standard response envelope " +
      '(a "response" object with "numFound" and "docs") are supported; handler "get" did not.',
  );
});

test("search --help says which handlers are supported", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "--help"], cli.deps), 0);
  assert.match(cli.out.join("\n").replace(/\s+/g, " "), /only handlers returning Solr's standard response envelope/);
});

test("paging past the end prints a note naming the total and the requested offset", async () => {
  const past = { response: { numFound: 754, start: 100000, docs: [] } };
  const cli = makeCli(() => jsonResponse(past));
  const code = await run(["search", "x", "--offset", "100000"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), past);
  assert.equal(untimed(cli.err.join("\n")), "INFO  [ddb.api] 754 documents match; --offset 100000 is past the end, so none are shown.");
});

test("the past-the-end note covers an offset equal to the total, and one match", async () => {
  const cli = makeCli(() => jsonResponse({ response: { numFound: 1, start: 1, docs: [] } }));
  await run(["search", "x", "--offset", "1"], cli.deps);
  assert.equal(untimed(cli.err.join("\n")), "INFO  [ddb.api] 1 document matches; --offset 1 is past the end, so none are shown.");
});

test("no past-the-end note without --offset, with --rows 0, or when the page has documents", async () => {
  for (const [args, body] of [
    [["search", "x"], { response: { numFound: 0, start: 0, docs: [] } }],
    [["search", "x", "--rows", "0", "--offset", "50"], { response: { numFound: 10, start: 50, docs: [] } }],
    [["search", "x", "--offset", "8"], { response: { numFound: 10, start: 8, docs: [{ id: "a" }, { id: "b" }] } }],
  ] as const) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run([...args], cli.deps), 0);
    assert.equal(cli.err.join("\n"), "", args.join(" "));
  }
});

test("--facet-limit without --facet is a usage error, before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "Goethe", "--rows", "0", "--facet-limit", "3"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--facet-limit needs --facet/);
});

test("an empty 200 body from search is a clean parse error (exit 1), not a TypeError", async () => {
  const cli = makeCli(() => rawResponse("", "application/json"));
  const code = await run(["search", "x"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(
    untimed(cli.err.join("\n")),
    /^ERROR \[ddb\.cli\] Unexpected response shape from \/search\/index\/search\/select: expected a JSON object\. Only request handlers that return Solr's standard response envelope .* are supported; handler "select" did not\.$/,
  );
});

test("search prints no paging note when the whole result set is returned", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  await run(["search", "Goethe"], cli.deps);
  assert.equal(cli.err.join("\n"), "");
});

test("search prints no paging note for a --rows 0 facet-only query", async () => {
  const facetOnly = {
    response: { numFound: 1614, start: 0, docs: [] },
    facet_counts: { facet_fields: { type_fct: ["mediatype_007", 1029, "mediatype_002", 477] } },
  };
  const cli = makeCli(() => jsonResponse(facetOnly));
  const code = await run(["search", "Oktoberfest", "--rows", "0", "--facet", "type_fct"], cli.deps);
  assert.equal(code, 0);
  assert.equal(queryOf(cli.mt.last()).get("rows"), "0");
  assert.equal(cli.err.join("\n"), "");
  assert.equal(JSON.parse(cli.out.join("\n")).response.numFound, 1614);
});

test("an empty search query is a usage error (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "   "], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /query is required/);
});

for (const [label, argv] of [
  ["--filter \"\"", ["search", "x", "--filter", ""]],
  ["--filter whitespace", ["search", "x", "--filter", "   "]],
  ["--filter blank after a valid one", ["search", "x", "--filter", "type_fct:a", "--filter", ""]],
  ["--facet \"\"", ["search", "x", "--facet", ""]],
  ["--facet whitespace", ["search", "x", "--facet", " \t "]],
  ["--facet blank after a valid one", ["search", "x", "--facet", "type_fct", "--facet", ""]],
] as const) {
  test(`a blank ${label} is rejected at parse time (exit 2), no request`, async () => {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run([...argv], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(code, 2);
    assert.equal(cli.mt.calls.length, 0);
  });
}

test("a non-integer --rows is rejected at parse time (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "x", "--rows", "lots"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a --collection with an illegal path character is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "x", "--collection", "a/b"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--collection / --handler of . or .. is a usage error, before any request", async () => {
  for (const [opt, value] of [["--collection", ".."], ["--handler", ".."], ["--collection", "."], ["--handler", "."]]) {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run(["search", "x", opt!, value!], cli.deps);
    assert.equal(code, 2, `${opt} ${value}`);
    assert.equal(cli.mt.calls.length, 0);
  }
  // A name that merely contains dots is still fine.
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "x", "--collection", "a.b", "--handler", "..."], cli.deps), 0);
});

test("a Solr 400 error surfaces its msg and exits 1", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrError, 400));
  const code = await run(["search", "bogus_fct:x"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /undefined field bogus_fct/);
});

test("a DDB-wrapped Solr error (HTTP 500, Solr JSON as a string) prints only error.msg", async () => {
  // The live shape: the Solr error document, pretty-printed, as the envelope's message.
  const solrDoc =
    '{\n  "responseHeader":{\n    "zkConnected":true,\n    "status":400,\n    "QTime":1},\n' +
    '  "error":{\n    "metadata":["error-class","org.apache.solr.common.SolrException"],\n' +
    '    "msg":"undefined field: \\"time_fct\\"",\n    "code":400}}\n';
  const cli = makeCli(() => jsonResponse({ message: solrDoc }, 500));
  const code = await run(["search", "Goethe", "--rows", "0", "--facet", "time_fct"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.length, 1);
  assert.match(untimed(cli.err[0]!), /^ERROR \[ddb\.api\] HTTP 500 for GET \S+: undefined field: "time_fct"$/);
});

test("an oversized or multi-line error message is folded to one line and capped", async () => {
  const cli = makeCli(() => jsonResponse({ message: `line one\nline two\n${"x".repeat(200_000)}` }, 500));
  const code = await run(["search", "x"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.length, 1);
  assert.ok(!cli.err[0]!.includes("\n"));
  assert.match(cli.err[0]!, /: line one line two x+…$/);
  assert.ok(cli.err[0]!.length < 1000, `stderr line is ${cli.err[0]!.length} chars`);
});

test("item defaults to the view component", async () => {
  const cli = makeCli(() => jsonResponse(fx.itemView));
  const code = await run(["item", ID], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `/2/items/${ID}/view`);
  assert.equal(JSON.parse(cli.out.join("\n")).institution.name, "Klassik Stiftung Weimar");
});

test("item --part edm targets the edm sub-endpoint and prints raw XML", async () => {
  const cli = makeCli(() => rawResponse(fx.edmXml, "application/rdf+xml;charset=utf-8"));
  const code = await run(["item", ID, "--part", "edm"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `/2/items/${ID}/edm`);
  // Raw, not JSON-quoted.
  assert.equal(cli.out.join("\n"), fx.edmXml);
});

test("item raw text to the terminal is stripped of control bytes (DDB-01)", async () => {
  const evil = `<edm>${ESC}]0;pwned${BEL}<title>ok</title></edm>`;
  const cli = makeCli(() => rawResponse(evil, "application/rdf+xml"));
  const code = await run(["item", ID, "--part", "edm"], cli.deps);
  assert.equal(code, 0);
  // Control bytes gone; XML structure otherwise intact.
  assert.equal(cli.out.join("\n"), "<edm>]0;pwned<title>ok</title></edm>");
});

test("item raw text to -o keeps the bytes verbatim (DDB-01)", async () => {
  const evil = `<edm>${ESC}]0;raw${BEL}</edm>`;
  const cli = makeCli(() => rawResponse(evil, "application/rdf+xml"));
  const code = await run(["item", ID, "--part", "edm", "-o", "out.xml"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.length, 0);
  // File output is not a terminal: the exact upstream bytes (incl. ESC/BEL) survive.
  assert.equal(cli.files.length, 1);
  assert.equal(cli.files[0]!.data.toString("utf8"), evil);
});

test("item raw XML keeps non-UTF-8 bytes and CRs byte-exact with -o", async () => {
  // "<t>Müller</t>" in Latin-1 (0xFC), CRLF line ends, no trailing newline.
  const latin1 = Buffer.from([0x3c, 0x74, 0x3e, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x0d, 0x0a, 0x3c, 0x2f, 0x74, 0x3e]);
  const cli = makeCli(() => rawResponse(latin1, "application/xml"));
  const code = await run(["item", ID, "--part", "source-record", "-o", "l1.xml"], cli.deps);
  assert.equal(code, 0);
  assert.ok(cli.files[0]!.data.equals(latin1));
  assert.deepEqual(cli.err.map(untimed), [`INFO  [ddb.output] Wrote ${latin1.length} bytes to l1.xml`]);
});

test("item raw XML to a non-terminal stdout is written byte-exact", async () => {
  const body = Buffer.concat([
    Buffer.from(`<a>\r\n<b>x${String.fromCharCode(0x0c)}y</b>\r\n</a>`, "latin1"),
    Buffer.from([0xfc]),
  ]);
  const cli = makeCli(() => rawResponse(body, "application/xml"));
  const binary: Buffer[] = [];
  cli.deps.io.outBinary = (data) => binary.push(data);
  cli.deps.io.isTerminal = () => false;
  const code = await run(["item", ID, "--part", "edm"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.length, 0);
  assert.equal(binary.length, 1);
  assert.ok(binary[0]!.equals(body));
});

test("item --lang / --rows / --offset for a part that ignores them is a usage error", async () => {
  const cases: [string[], RegExp][] = [
    [["--part", "parents", "--lang", "de"], /^ERROR \[ddb\.cli\] Invalid lang: applies only to part view, aip, edm, binaries, source, source-description \(got parents\)\.$/],
    [["--part", "edm", "--rows", "5"], /^ERROR \[ddb\.cli\] Invalid rows: applies only to part children \(got edm\)\.$/],
    [["--offset", "3"], /^ERROR \[ddb\.cli\] Invalid offset: applies only to part children \(got view\)\.$/],
  ];
  for (const [args, message] of cases) {
    const cli = makeCli(() => jsonResponse(fx.itemView));
    const code = await run(["item", ID, ...args], cli.deps);
    assert.equal(code, 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(untimed(cli.err.join("\n")), message);
  }
  const ok = makeCli(() => jsonResponse(fx.itemView));
  assert.equal(await run(["item", ID, "--part", "children", "--rows", "5", "--offset", "3"], ok.deps), 0);
  assert.equal(await run(["item", ID, "--part", "edm", "--lang", "de"], ok.deps), 0);
});

test("a blank -o path is a usage error, before any request", async () => {
  for (const path of ["", "   "]) {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run(["search", "x", "-o", path], cli.deps);
    assert.equal(code, 2, JSON.stringify(path));
    assert.equal(cli.mt.calls.length, 0);
    assert.equal(cli.files.length, 0);
    assert.match(cli.err.join("\n"), /Expected a non-empty value\./);
  }
});

test("-o - writes to stdout, not to a file named -", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  const code = await run(["--compact", "-o", "-", "search", "x"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.files.length, 0);
  assert.equal(JSON.parse(cli.out.join("\n")).response.numFound, 2);
  assert.ok(!cli.err.some((line) => line.startsWith("Wrote")));
});

test("an existing -o file or a directory is refused before any request, for every command, as an ERROR of ddb.output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ddb-cli-o-"));
  try {
    const existing = join(dir, "exists.json");
    writeFileSync(existing, "original");
    const cases: [string[], string][] = [
      [["search", "x", "-o", existing], `ERROR [ddb.output] Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["item", ID, "-o", existing], `ERROR [ddb.output] Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["version", "-o", existing], `ERROR [ddb.output] Refusing to overwrite existing file "${existing}"; pass --force to overwrite.`],
      [["search", "x", "-o", dir], `ERROR [ddb.output] "${dir}" is a directory; give a file path to --output.`],
      [["search", "x", "-o", dir, "--force"], `ERROR [ddb.output] "${dir}" is a directory; give a file path to --output.`],
    ];
    for (const [args, message] of cases) {
      const cli = makeCli(() => jsonResponse(fx.solr));
      cli.deps.io.checkOutput = defaultIO.checkOutput;
      assert.equal(await run(args, cli.deps), 1, args.join(" "));
      assert.equal(cli.mt.calls.length, 0, args.join(" "));
      assert.equal(cli.files.length, 0);
      assert.deepEqual(cli.out, []);
      assert.equal(untimed(cli.err.join("\n")), message);
    }
    assert.equal(readFileSync(existing, "utf8"), "original");

    // --force lets the request go ahead; a new path is fine without it.
    for (const args of [["search", "x", "-o", existing, "--force"], ["search", "x", "-o", join(dir, "new.json")]]) {
      const cli = makeCli(() => jsonResponse(fx.solr));
      cli.deps.io.checkOutput = defaultIO.checkOutput;
      assert.equal(await run(args, cli.deps), 0, args.join(" "));
      assert.equal(cli.mt.calls.length, 1);
      assert.equal(cli.files.length, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("-o - skips the existing-file check", async () => {
  const checked: string[] = [];
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  cli.deps.io.checkOutput = (path) => checked.push(path);
  assert.equal(await run(["-o", "-", "search", "x"], cli.deps), 0);
  assert.deepEqual(checked, []);
  assert.equal(cli.mt.calls.length, 1);
});

test("--force without --output is a usage error, before any request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "x", "--force"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--force needs --output/);
});

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const body = '{"a":' + "[".repeat(depth) + "]".repeat(depth) + "}";
  const deep = () => rawResponse(body, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["item", ID], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(untimed(pretty.err.join("\n")), "ERROR [ddb.cli] The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run(["--compact", "item", ID], compact.deps);
  if (code === 0) assert.equal(compact.out.join(""), body);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [ddb.cli] The response is nested too deeply to print.");
});

test("-o does not pass force by default; --force threads through (DDB-02)", async () => {
  const cli = makeCli(() => jsonResponse(fx.itemView));
  await run(["item", ID, "-o", "out.json"], cli.deps);
  assert.equal(cli.files.length, 1);
  assert.equal(cli.files[0]!.force, undefined);

  const cli2 = makeCli(() => jsonResponse(fx.itemView));
  await run(["item", ID, "-o", "out.json", "--force"], cli2.deps);
  assert.equal(cli2.files[0]!.force, true);
});

test("item --lang is forwarded", async () => {
  const cli = makeCli(() => jsonResponse(fx.itemView));
  await run(["item", ID, "--lang", "en"], cli.deps);
  assert.equal(queryOf(cli.mt.last()).get("lang"), "en");
});

test("an item id of the wrong length is a usage error (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["item", "tooshort"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /exactly 32 characters/);
});

test("a 32-character item id with other characters is a usage error (exit 2), no request", async () => {
  const cases: [string, RegExp][] = [
    [ID.toLowerCase(), new RegExp(`Item ids are upper case: try "${ID}"\\.`)],
    ["😀".repeat(16), /32 upper-case letters and digits/],
    [".".repeat(32), /32 upper-case letters and digits/],
    ["/".repeat(32), /32 upper-case letters and digits/],
    [`${ID.slice(0, 31)}-`, /32 upper-case letters and digits/],
  ];
  for (const [id, message] of cases) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["item", id], cli.deps);
    assert.equal(code, 2, id);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
});

test("an unknown item --part is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["item", ID, "--part", "bogus"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("version prints the plain-text backend version", async () => {
  const cli = makeCli(() => rawResponse("7.5\n", "text/plain"));
  const code = await run(["version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/2/version");
  assert.equal(cli.out.join("\n"), "7.5");
});

test("a version with control bytes is rejected, and none reach the terminal (DDB-01)", async () => {
  const cli = makeCli(() => rawResponse(`7.5${ESC}]0;pwned${BEL}\n`, "text/plain"));
  const code = await run(["version"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.ok(!cli.err.join("\n").includes(ESC) && !cli.err.join("\n").includes(BEL), cli.err.join("\n"));
});

test("version fails on a 2xx body that is not a version string (03#6)", async () => {
  for (const [body, type] of [["<html>maintenance</html>", "text/html"], ['{"version":"7.5"}', "application/json"], ["", "text/plain"]] as const) {
    const cli = makeCli(() => rawResponse(body, type));
    const code = await run(["version"], cli.deps);
    assert.equal(code, 1, body);
    assert.deepEqual(cli.out, [], body);
    assert.match(cli.err.join("\n"), /expected a version string such as "7\.5"/, body);
  }
  const ok = makeCli(() => rawResponse("7.5\n", "text/plain"));
  assert.equal(await run(["version"], ok.deps), 0);
  assert.deepEqual(ok.out, ["7.5"]);
});

test("item fails on a JSON part that is null, a scalar or an error document", async () => {
  for (const body of ["null", "5", '{"name":"ItemNotFoundException","message":"gone","stacktrace":[]}']) {
    const cli = makeCli(() => rawResponse(body, "application/json"));
    const code = await run(["item", ID], cli.deps);
    assert.equal(code, 1, body);
    assert.deepEqual(cli.out, [], body);
  }
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound, 404));
  const code = await run(["item", ID], cli.deps);
  assert.equal(code, 4);
});

test("a 403 exits 1 and explains the public read routes", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound, 403));
  const code = await run(["search", "x"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /read routes .* are public/);
});

test("a control character in --user-agent is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "x", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a blank or non-Latin-1 --user-agent is a usage error (exit 2), no request", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["bot 😀", /outside Latin-1 \(above U\+00FF\)/],
    ["bot \u20ac", /outside Latin-1 \(above U\+00FF\)/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run(["--user-agent", ua, "version"], cli.deps);
    assert.equal(code, 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  // Tab and Latin-1 are what HTTP allows, and still pass.
  const ok = makeCli(() => rawResponse("1.0", "text/plain"));
  assert.equal(await run(["--user-agent", "müller-bot/1.0\t(test)", "version"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "müller-bot/1.0\t(test)");
});

test("an empty --base-url is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["--base-url", "", "search", "x"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["--base-url", "ftp://x/y", "search", "x"], cli.deps), 2);
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18109/echo/2?key=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18109/echo/2#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18109?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://api.deutsche-digitale-bibliothek.de/2", /cannot have surrounding whitespace/],
    ["https://api.deutsche-digitale-bibliothek.de/2\t", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run(["--base-url", baseUrl, "version"], cli.deps);
    assert.equal(code, 2, baseUrl);
    assert.equal(cli.mt.calls.length, 0, baseUrl);
    assert.match(cli.err.join("\n"), message, baseUrl);
  }
});

test("a --base-url with a path prefix still works", async () => {
  const cli = makeCli(() => rawResponse("1.0", "text/plain"));
  const code = await run(["--base-url", "https://mirror.example/ddb/2/", "version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.last().url, "https://mirror.example/ddb/2/version");
});

test("credentials in --base-url are redacted from error messages", async () => {
  const cli = makeCli(() => jsonResponse({ message: "nope" }, 403));
  const code = await run(["--base-url", "http://user:s3cret@127.0.0.1:18109/e403/2", "version"], cli.deps);
  assert.equal(code, 1);
  // ...but still sent: as the engine's Authorization header, never inside the URL.
  assert.equal(cli.mt.last().url, "http://127.0.0.1:18109/e403/2/version");
  assert.equal(cli.mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:s3cret").toString("base64")}`);
  assert.equal(untimed(cli.err[0] ?? ""), "ERROR [ddb.api] HTTP 403 for GET http://127.0.0.1:18109/e403/2/version: nope");
  assert.ok(!cli.err.join("\n").includes("s3cret"));
});

test("--rows / --offset above Solr's int maximum are usage errors, before any request", async () => {
  for (const args of [["--rows", "2147483648"], ["--offset", "99999999999999999999"]]) {
    const cli = makeCli(() => jsonResponse(fx.solr));
    const code = await run(["search", "x", ...args], cli.deps);
    assert.equal(code, 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Must be <= 2147483647\./);
  }
  const ok = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "x", "--rows", "2147483647"], ok.deps), 0);
});

test("--facet-limit -1 asks Solr for every facet value; other negatives are rejected", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "x", "--facet", "type_fct", "--facet-limit", "-1"], cli.deps), 0);
  assert.equal(queryOf(cli.mt.last()).get("facet.limit"), "-1");
  // -1 keeps Solr's count order: without facet.sort, Solr switches to index order (01#2).
  assert.equal(queryOf(cli.mt.last()).get("facet.sort"), "count");
  const capped = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "x", "--facet", "type_fct", "--facet-limit", "3"], capped.deps), 0);
  assert.equal(queryOf(capped.mt.last()).get("facet.sort"), null, "a positive limit is count-sorted already");
  const bad = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search", "x", "--facet", "type_fct", "--facet-limit", "-2"], bad.deps), 2);
  assert.equal(bad.mt.calls.length, 0);
});

test("an oversized number says it is too large, not that it is no integer", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["--max-response-bytes", "99999999999999999999", "version"], cli.deps), 2);
  assert.match(cli.err.join("\n"), /Must be <= 9007199254740991\./);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["--max-retries", "1000", "search", "x"], cli.deps), 2);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  assert.equal(await run(["--timeout", "2147483647", "search", "x"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.solrExact));
  assert.equal(await run(["--timeout", "2147483648", "search", "x"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: ddb/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    response: { numFound: 1, start: 0, docs: [{ id: ID, title: `Faust${controls}`, label: `${ESC}[31m` }] },
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "search", "Goethe"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Faust\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  await run(["search", "x", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("an HTTP 414 prints a bounded line that says the URL is too long (01#3)", async () => {
  const cli = makeCli(() => jsonResponse({}, 414));
  const query = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" OR ");
  const code = await run(["search", query], cli.deps);
  assert.equal(code, 1);
  const text = cli.err.join("\n");
  assert.ok(text.length < 1000, `stderr is ${text.length} characters`);
  assert.match(text, /HTTP 414 for GET https:\/\/api\.deutsche-digitale-bibliothek\.de\/2\/search\/index\/search\/select\?.*… \(\d+ characters\)/);
  assert.match(text, /request URL is too long .*--filter/);
});

test("item prints an ancestor's component with a note naming it, exit 0 (01#1)", async () => {
  const VOLUME = "JY7HJBJAUBYMG437RSIFJNUPMMSAHT26";
  const cli = makeCli((req) =>
    req.url.includes(VOLUME)
      ? rawResponse("<mets/>", "application/xml")
      : { status: 303, headers: { location: `https://api.deutsche-digitale-bibliothek.de/items/${VOLUME}/source/record` }, body: Buffer.alloc(0) },
  );
  const code = await run(["item", ID, "--part", "source-record"], cli.deps);
  assert.equal(code, 0, cli.err.join("\n"));
  assert.equal(cli.out.join("\n"), "<mets/>");
  assert.equal(untimed(cli.err.join("\n")), `INFO  [ddb.api] item ${ID} has no source-record of its own; this is the source-record of its ancestor ${VOLUME}, which the API points to.`);
});

test("an https->http redirect downgrade is a WARN record of ddb.http, without a second 'Warning:' prefix", async () => {
  const cli = makeCli((req) =>
    req.url.startsWith("https:")
      ? { status: 302, headers: { location: "http://mirror.example/2/version" }, body: Buffer.alloc(0) }
      : rawResponse("7.5", "text/plain"),
  );
  assert.equal(await run(["--base-url", "https://mirror.example/2", "version"], cli.deps), 0, cli.err.join("\n"));
  assert.deepEqual(cli.err.map(untimed), [
    "WARN  [ddb.http] following an https->http redirect downgrade to http://mirror.example " +
      "(subsequent traffic is unencrypted; credentials were stripped).",
  ]);
  assert.deepEqual(cli.out, ["7.5"]);
});

test("a line break, ESC or bidi control in a typed value never forges a record (-o, --part, an unknown command)", async () => {
  const forged = "x\n2026-10-09T00:00:00.000Z INFO  [ddb.api] forged\u001b]0;title\u0007\u202e\u2028";
  const record = /^\S+Z (ERROR|WARN |INFO ) \[ddb\.[a-z-]+\] /;
  const raw = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/;
  const output = makeCli(() => rawResponse("7.5", "text/plain"));
  assert.equal(await run(["-o", forged, "version"], output.deps), 0);
  const part = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["item", ID, "--part", forged], part.deps), 2);
  const command = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run([forged], command.deps), 2);
  for (const err of [output.err, part.err, command.err]) {
    assert.ok(err.length > 0);
    for (const line of err) {
      assert.match(line, record, JSON.stringify(line));
      assert.doesNotMatch(line, raw, JSON.stringify(line));
    }
  }
});

test("jsonl never prints a rejected base URL's password with DEL or C1 plus a space (results/03)", async () => {
  for (const password of ["Hu nt\u007fer", "Hu nt\u0085er"]) {
    for (const argv of [["--base-url", `http://alice:${password}@127.0.0.1:18431/2?x`], [`--base-url=http://alice:${password}@127.0.0.1:18431/2?x`], ["--timeout", `http://alice:${password}@127.0.0.1:18431/2`]]) {
      const cli = makeCli(() => rawResponse("7.5", "text/plain"));
      const code = await run(["--log-format", "jsonl", ...argv, "version"], cli.deps);
      assert.equal(code, 2);
      const all = cli.err.join("\n");
      assert.ok(!all.includes("er@") && !all.includes("alice:Hu"), all);
      assert.match(all, /http:\/\/\*\*\*@127\.0\.0\.1:18431\/2/);
    }
  }
});

test("a server echoing the Authorization header never puts the credentials into the record (results/03)", async () => {
  // The report's run: a 401 body reflecting the Basic value and the decoded user:password.
  const basic = Buffer.from("alice:S3cr@t", "utf8").toString("base64");
  for (const format of ["text", "jsonl"]) {
    const cli = makeCli(() => jsonResponse({ message: `Unauthorized for Basic ${basic} decoded=alice:S3cr@t` }, 401));
    const code = await run(["--log-format", format, "--base-url", "http://alice:S3cr%40t@127.0.0.1:18431/2", "version"], cli.deps);
    assert.equal(code, 1);
    const all = cli.err.join("\n");
    assert.match(all, /Unauthorized for Basic \*\*\* decoded=\*\*\*/, all);
    assert.ok(!all.includes(basic) && !all.includes("S3cr@t"), all);
  }
});

test("an a:b@c argument (a query, an -o path) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const body = { responseHeader: { status: 0 }, response: { numFound: 1, start: 0, docs: [{ id: "1", label: "run:2026-10-09@x" }] } };
  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["search", "run:2026-10-09@x"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"label": "run:2026-10-09@x"/);
  const file = makeCli(() => jsonResponse(body));
  assert.equal(await run(["-o", "run:2026-10-09@x.json", "search", "x"], file.deps), 0);
  assert.match(untimed(file.err.join("\n")), /INFO  \[ddb\.output\] Wrote \d+ bytes to run:2026-10-09@x\.json/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("commander's output is one record per line, and a run without a command has an ERROR (L5, results/01)", async () => {
  // Options but no command: commander shows the help as an error.
  for (const argv of [["--compact"], ["--log-format", "jsonl"], ["--base-url", "http://127.0.0.1:18431/2"]]) {
    const none = makeCli(() => jsonResponse(fx.solr));
    assert.equal(await run(argv, none.deps), 2);
    if (argv[0] === "--log-format") {
      const records = none.err.map((line) => JSON.parse(line) as { level: string; msg: string });
      assert.deepEqual([records[0]?.level, records[0]?.msg], ["ERROR", "missing command: `ddb <subcommand>`"]);
      assert.ok(records.slice(1).every((r) => r.level === "INFO" && !r.msg.includes("\n")), none.err.join("\n"));
      continue;
    }
    const text = none.err.map(untimed);
    assert.equal(text[0], "ERROR [ddb.cli] missing command: `ddb <subcommand>`");
    assert.ok(text.slice(1).every((line) => line.startsWith("INFO  [ddb.cli] ") && !line.includes("\\n")), text.join("\n"));
    assert.ok(text.some((line) => line === "INFO  [ddb.cli] Usage: ddb [options] [command]"), text.join("\n"));
  }

  // A command typo: the suggestion is part of the ERROR, the help one INFO record per line.
  const typo = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["serch"], typo.deps), 2);
  const typoLines = typo.err.map(untimed);
  assert.equal(typoLines[0], "ERROR [ddb.cli] unknown command 'serch' (Did you mean search?)");
  assert.ok(typoLines.slice(1).every((line) => line.startsWith("INFO  [ddb.cli] ") && !line.includes("\\n")), typoLines.join("\n"));

  // A missing argument: commander's error, then the subcommand's help, one record per line.
  const missing = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["search"], missing.deps), 2);
  const missingLines = missing.err.map(untimed);
  assert.equal(missingLines[0], "ERROR [ddb.cli] missing required argument 'query'");
  assert.ok(missingLines.some((line) => line === "INFO  [ddb.cli] Usage: ddb search [options] <query>"), missingLines.join("\n"));

  // An unknown help topic is an ERROR too.
  const help = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["help", "nope"], help.deps), 2);
  assert.match(untimed(help.err[0] ?? ""), /^ERROR \[ddb\.cli\] /);
});

test("the log format is the one commander parsed, where an option's value looks like --log-format (L6, results/01)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  const notFound = () => jsonResponse({ name: "ItemNotFoundException", message: "Not Found" }, 404);
  // commander takes "--log-format=jsonl" as the User-Agent: the record is text.
  const ua = makeCli(notFound);
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "version"], ua.deps), 4);
  assert.ok(ua.err.length === 1 && !isJsonl(ua.err[0] as string), ua.err.join("\n"));
  // commander takes "--" as the User-Agent, then parses --log-format jsonl: jsonl.
  const dashes = makeCli(notFound);
  assert.equal(await run(["--user-agent", "--", "--log-format", "jsonl", "version"], dashes.deps), 4);
  assert.ok(dashes.err.length === 1 && isJsonl(dashes.err[0] as string), dashes.err.join("\n"));
  // jsonl asked for, then "--log-format" as the value of --user-agent and of -o: jsonl.
  const back = makeCli(notFound);
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "version"], back.deps), 4);
  assert.ok(back.err.length === 1 && isJsonl(back.err[0] as string), back.err.join("\n"));
  const output = makeCli(() => rawResponse("7.5", "text/plain"));
  assert.equal(await run(["--log-format", "jsonl", "-o", "--log-format", "version"], output.deps), 0);
  assert.ok(output.err.length === 1 && isJsonl(output.err[0] as string), output.err.join("\n"));
  // A parse error after such a value is logged in the format commander would have used:
  // -o takes --log-format as its path, so jsonl is the unknown command (text record).
  const parse = makeCli(() => rawResponse("7.5", "text/plain"));
  assert.equal(await run(["-o", "--log-format", "jsonl", "version"], parse.deps), 2);
  assert.ok(parse.err.length > 0 && !parse.err.some(isJsonl), parse.err.join("\n"));
  assert.match(untimed(parse.err[0] ?? ""), /^ERROR \[ddb\.cli\] unknown command 'jsonl'/);
});

test("every -o failure is an ERROR record of ddb.output, exit 1 (L8, results/01 and 04)", async () => {
  // The refusals and the write errors of the real CliIO, and a CliIO that throws a plain Error.
  const dir = mkdtempSync(join(tmpdir(), "ddb-cli-o8-"));
  try {
    for (const [args, writer] of [
      [["search", "x", "-o", join(dir, "missing", "x.json")], defaultIO.writeFile],
      [["version", "-o", join(dir, "missing", "x.txt")], defaultIO.writeFile],
      [["item", ID, "--part", "edm", "-o", join(dir, "missing", "x.xml")], defaultIO.writeFile],
      [["search", "x", "-o", "out.json"], () => { throw new Error("EACCES: permission denied, open 'out.json'"); }],
    ] as [string[], CliDeps["io"]["writeFile"]][]) {
      const cli = makeCli((req) => (req.url.endsWith("/version") ? rawResponse("7.5", "text/plain") : req.url.includes("/edm") ? rawResponse("<rdf/>", "application/rdf+xml") : jsonResponse(fx.solr)));
      cli.deps.io.writeFile = writer;
      assert.equal(await run(args, cli.deps), 1, args.join(" "));
      assert.match(untimed(cli.err.join("\n")), /(^|\n)ERROR \[ddb\.output\] (Could not write to|EACCES)/, args.join(" "));
      assert.doesNotMatch(cli.err.join("\n"), /Unexpected error|\[ddb\.cli\]/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
