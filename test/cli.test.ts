import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DdbClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
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
  assert.match(cli.err.join("\n"), /^Note: 99215 documents match; 3 shown \(21–23\)\. /);
});

test("the paging note ignores a non-numeric start", async () => {
  const odd = { response: { numFound: 10, start: "-5", docs: [{ id: "a" }, { id: "b" }] } };
  const cli = makeCli(() => jsonResponse(odd));
  await run(["search", "x"], cli.deps);
  assert.match(cli.err.join("\n"), /^Note: 10 documents match; 2 shown\. /);
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
  assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from \/search\/index\/search\/select: expected a JSON object\.$/);
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
  assert.match(cli.err[0]!, /^Error: HTTP 500 for GET \S+: undefined field: "time_fct"$/);
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
  assert.deepEqual(cli.err, [`Wrote ${latin1.length} bytes to l1.xml`]);
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
    [["--part", "parents", "--lang", "de"], /--lang applies only to --part view, aip, edm, binaries, source, source-description\./],
    [["--part", "edm", "--rows", "5"], /--rows applies only to --part children\./],
    [["--offset", "3"], /--offset applies only to --part children\./],
  ];
  for (const [args, message] of cases) {
    const cli = makeCli(() => jsonResponse(fx.itemView));
    const code = await run(["item", ID, ...args], cli.deps);
    assert.equal(code, 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  const ok = makeCli(() => jsonResponse(fx.itemView));
  assert.equal(await run(["item", ID, "--part", "children", "--rows", "5", "--offset", "3"], ok.deps), 0);
  assert.equal(await run(["item", ID, "--part", "edm", "--lang", "de"], ok.deps), 0);
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

test("version to the terminal is stripped of control bytes (DDB-01)", async () => {
  const cli = makeCli(() => rawResponse(`7.5${ESC}]0;pwned${BEL}\n`, "text/plain"));
  const code = await run(["version"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join("\n"), "7.5]0;pwned");
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
