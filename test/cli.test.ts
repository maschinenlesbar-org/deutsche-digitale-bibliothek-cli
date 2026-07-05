import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DdbClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

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

test("search renders the response and hits /search", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["search", "Goethe", "--api-key", "K"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/search");
  assert.equal(queryOf(cli.mt.last()).get("query"), "Goethe");
  assert.equal(JSON.parse(cli.out.join("\n")).numberOfResults, 12345);
});

test("search defaults to rows=10 (never the API's 1000 default)", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  await run(["search", "Goethe"], cli.deps);
  assert.equal(queryOf(cli.mt.last()).get("rows"), "10");
});

test("search forwards --rows, --sort, repeated --facet and repeated --filter", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  await run(
    [
      "search", "Goethe",
      "--rows", "5",
      "--sort", "alpha_asc",
      "--facet", "type_fct", "--facet", "place_fct",
      "--filter", "place_fct=Berlin", "--filter", "place_fct=München",
    ],
    cli.deps,
  );
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("rows"), "5");
  assert.equal(q.get("sort"), "ALPHA_ASC"); // normalised to upper-case
  assert.deepEqual(q.getAll("facet"), ["type_fct", "place_fct"]);
  assert.deepEqual(q.getAll("place_fct"), ["Berlin", "München"]);
});

test("an empty search query is a usage error (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["search", "   "], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /query is required/);
});

test("an invalid --sort is rejected at parse time (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["search", "x", "--sort", "sideways"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a malformed --filter (no '=') is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["search", "x", "--filter", "nope"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--rows above the max is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  assert.equal(await run(["search", "x", "--rows", "1001"], cli.deps), 2);
});

test("item defaults to the view component", async () => {
  const cli = makeCli(() => jsonResponse(fx.itemView));
  const code = await run(["item", "OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "--api-key", "K"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/items/OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF/view");
});

test("item --part edm targets the edm sub-endpoint", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["item", "OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "--part", "edm"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/items/OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF/edm");
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
  const code = await run(["item", "OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "--part", "bogus"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("facets with no name lists the facet fields", async () => {
  const cli = makeCli(() => jsonResponse(fx.facetsList));
  const code = await run(["facets"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/search/facets");
});

test("facets <name> lists that facet's values", async () => {
  const cli = makeCli(() => jsonResponse(fx.facetValues));
  await run(["facets", "place_fct", "--query", "Goethe"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, "/search/facets/place_fct");
  assert.equal(queryOf(cli.mt.last()).get("query"), "Goethe");
});

test("institutions forwards --sector and --has-items", async () => {
  const cli = makeCli(() => jsonResponse(fx.institutions));
  const code = await run(["institutions", "--sector", "sec_06", "--has-items"], cli.deps);
  assert.equal(code, 0);
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("sector"), "sec_06");
  assert.equal(q.get("hasItems"), "true");
});

test("an invalid --sector is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.institutions));
  assert.equal(await run(["institutions", "--sector", "sec_99"], cli.deps), 2);
});

test("version prints the plain-text backend version", async () => {
  const cli = makeCli(() => rawResponse("5.6.7\n", "text/plain"));
  const code = await run(["version", "--api-key", "K"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/version");
  assert.equal(cli.out.join("\n"), "5.6.7");
});

test("the API key is read from DDB_API_KEY when --api-key is absent", async () => {
  const cli = makeCli(() => jsonResponse(fx.search), { DDB_API_KEY: "ENVKEY" });
  await run(["search", "x"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], 'OAuth oauth_consumer_key="ENVKEY"');
});

test("--api-key overrides DDB_API_KEY", async () => {
  const cli = makeCli(() => jsonResponse(fx.search), { DDB_API_KEY: "ENVKEY" });
  await run(["search", "x", "--api-key", "FLAGKEY"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], 'OAuth oauth_consumer_key="FLAGKEY"');
});

test("a 403 error envelope exits 1 and prints an API-key hint", async () => {
  const cli = makeCli(() => jsonResponse(fx.notAuthorized, 403));
  const code = await run(["search", "x"], cli.deps);
  assert.equal(code, 1);
  const stderr = cli.err.join("\n");
  assert.match(stderr, /security level does not allow/);
  assert.match(stderr, /requires an API key/);
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => jsonResponse(fx.notFound, 404));
  const code = await run(["item", "OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "--api-key", "K"], cli.deps);
  assert.equal(code, 4);
});

test("a control character in --user-agent is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["search", "x", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("an empty --base-url is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  const code = await run(["--base-url", "", "search", "x"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
  assert.equal(await run(["--base-url", "ftp://x/y", "search", "x"], cli.deps), 2);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.search));
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
  const cli = makeCli(() => jsonResponse(fx.search));
  await run(["search", "x", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});
