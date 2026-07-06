import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DdbClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

const ID = "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK";

function makeCli(responder: (req: HttpRequest) => HttpResponse, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {},
      outBinary: () => {},
    },
    createClient: (opts) => new DdbClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, mt };
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

test("search prints no paging note when the whole result set is returned", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  await run(["search", "Goethe"], cli.deps);
  assert.equal(cli.err.join("\n"), "");
});

test("an empty search query is a usage error (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  const code = await run(["search", "   "], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /query is required/);
});

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

test("a Solr 400 error surfaces its msg and exits 1", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrError, 400));
  const code = await run(["search", "bogus_fct:x"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /undefined field bogus_fct/);
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

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.solr));
  assert.equal(await run(["--max-retries", "1000", "search", "x"], cli.deps), 2);
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

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.solrExact));
  await run(["search", "x", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});
