# Developing & integrating

This document covers `deutsche-digitale-bibliothek-cli` as a **TypeScript
library**, plus its architecture, testing and release setup. If you just want to
use the command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`ddb`) and a typed API client (`DdbClient`) for the
**v2** [Deutsche Digitale Bibliothek API](https://api.deutsche-digitale-bibliothek.de/2)
(`api.deutsche-digitale-bibliothek.de/2`), central access to digitised
cultural-heritage objects from German archives, libraries and museums. It targets
the **public read routes** — search, item, version — which need **no API key**.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https`
  (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Faithful shapes** — search returns a native **Solr** response typed as
  `SolrResponse`; item components are returned as parsed JSON or raw text
  (`ItemResult`) depending on the response Content-Type.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`),
  every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
ddb --help
```

## Library usage

```ts
import { DdbClient, DdbApiError } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-cli";

const client = new DdbClient();   // no API key needed for the read routes

// Search — a native Solr response
const result = await client.search({ query: "Goethe", rows: 10, facetFields: ["type_fct"] });
console.log(result.response.numFound, result.response.docs.length);
console.log(result.facet_counts?.facet_fields);

// Item components — ItemResult carries `json` (JSON parts) or `text` (XML/BIB parts)
const view = await client.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK");           // JSON → view.json
const edm = await client.item("TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", "edm");     // RDF/XML → edm.text

try {
  await client.search({ query: "*:*" });
} catch (err) {
  if (err instanceof DdbApiError) console.error(err.status, err.apiName, err.detail);
}
```

### Client options

```ts
new DdbClient({
  baseUrl: "https://api.deutsche-digitale-bibliothek.de/2",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

`DdbClientOptions` is just the engine options — there is no `apiKey` field, since
the read routes are unauthenticated. (If you ever need to reach an authenticated
endpoint, inject an `Authorization` header via the engine's `defaultHeaders`; it
is stripped on cross-origin redirects, see below.)

### Methods

- `search(params)` → a `SolrResponse` (`GET /2/search/index/{collection}/{requestHandler}`,
  default `search`/`select`). Params map to Solr: `query`→`q`, `rows`, `start`,
  `sort`, `fields`→`fl`, `filters`→`fq` (repeatable), `facetFields`→`facet.field`
  (sets `facet=true`), `facetLimit`→`facet.limit`. `wt=json` is forced.
- `item(id, part?, opts?)` → an `ItemResult` (`GET /2/items/{id}...`). `part`
  defaults to `view`; others: `aip`, `edm`, `binaries`, `children`, `parents`,
  `source`, `source-description`, `source-record`, `iiif`, `citation`. The result
  has `json` (for JSON components) **or** `text` (for `edm`/`source-record`/
  `citation`, which the API serves as XML or a file), plus the `contentType`.
  `opts`: `lang` (localised labels), and `rows`/`offset` for `part: "children"`.
- `version()` → the backend version string (`GET /2/version`).

## No authentication

The read routes (`/2/search/...`, `/2/items/...`, `/2/version`) are **public** —
this client sends no credentials and has no auth options to configure. A `403` is
therefore unexpected on these routes and means a custom `--base-url` was pointed at
an authenticated endpoint (favourites, user, saved-searches), or the specific item
component is access-restricted.

> The OpenAPI spec **over-declares** security: it lists an HTTP-bearer
> `SecurityScheme` on nearly every path, including search and items — yet the live
> server serves the read routes anonymously. This was confirmed against the live
> API (below); trust the live behaviour, not the spec's `security` blocks.

**Redirect safety.** The engine strips credential headers (`Authorization`,
`X-API-Key`, `Cookie`) before following a redirect that crosses an origin boundary.
Nothing carries credentials by default, but this keeps the seam safe if a caller
injects one via `defaultHeaders`.

## Notes on the live API (verify-first findings)

The upstream docs are partly stale; these were confirmed against the live v2
service:

- **The read routes are keyless.** `GET /2/version`, `GET /2/search/index/...`,
  `GET /2/items/{id}...` and `GET /2/institutions` all return `200` with no
  credentials. Authenticated endpoints (`/2/version/test-auth`, user/favourites)
  correctly return `401`/`403`, so the anonymous access is a real policy, not a
  disabled check.
- **Search is a raw Solr passthrough.** The path is
  `/2/search/index/{collection}/{requestHandler}` and the query string is native
  Solr (`q`, `rows`, `start`, `fq`, `fl`, `sort`, `facet*`). The response is native
  Solr JSON (`responseHeader` / `response` / `facet_counts`).
- **Some item components are XML.** `edm` is `application/rdf+xml` and
  `source-record` is `application/xml`; the client returns those as `text`. `iiif`
  and `citation` exist only for some objects (a `404` otherwise). The bare
  `/2/items/{id}` and `view`/`binaries`/`parents`/`source` are JSON.
- **Errors** come back either as Solr's `{ error: { msg, code } }` (bad query) or
  the DDB envelope `{ name, message, stacktrace }` (item endpoints), with a proper
  HTTP status. `DdbApiError` surfaces the human-readable message as `detail` and
  any `name` as `apiName`.
- **Item ids are exactly 32 characters.** The `item` command validates this up
  front so a truncated id fails fast with exit 2 instead of a bare 404.

## Architecture

```
src/
  client/
    types.ts     # SolrResponse/SolrDoc; ItemPart/ItemResult; SearchParams
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building (base incl. /2), retry/backoff, redirects, decoding, errors
    errors.ts    # DdbError / DdbApiError / DdbNetworkError / DdbParseError / DdbUsageError
    client.ts    # DdbClient — search (Solr) / item (content-type aware) / version
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # search, item, catalog (version)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- `search()` builds the Solr passthrough path and forces `wt=json`; the CLI's
  `--filter`/`--facet`/`--sort`/`--fields` map straight onto `fq`/`facet.field`/
  `sort`/`fl`.
- `item()` fetches raw via the engine and **branches on Content-Type**: JSON is
  parsed into `ItemResult.json`; anything else (RDF/XML, XML, BIB) is returned as
  `ItemResult.text` and the CLI prints it raw.
- The engine accepts `defaultHeaders` merged into every request — the read routes
  need none; it's the injection seam for a caller that reaches an authed endpoint.
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

### Library / technical terms

**API client.** [`DdbClient`](src/client/client.ts) — the typed wrapper over the
API, usable as a library independently of the CLI.

**SolrResponse.** The native Solr response returned by `search`: `{ responseHeader?,
response: { numFound, start, docs[] }, facet_counts? }`
([`types.ts`](src/client/types.ts)). Each `SolrDoc` has a guaranteed `id` plus an
open index signature for the Solr fields.

**ItemResult.** The decoded body of an item component
([`types.ts`](src/client/types.ts)): `{ part, contentType, json? , text? }` —
exactly one of `json`/`text` is set, chosen by Content-Type.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs (base URL
includes the `/2` version prefix), serialises queries, applies retry/backoff,
follows redirects, decodes JSON/raw responses and maps errors (DDB envelope **and**
Solr `error.msg`).

**Retry / backoff.** Transient `429` and `503` responses are retried
automatically with backoff, up to `--max-retries`. `DdbApiError` exposes
`isRetryable` (true for `429`/`503`).

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary (scheme, host **or** port), the engine strips credential
headers (`Authorization`, `X-API-Key`, `Cookie`) before following it — this
includes a same-host `https:`->`http:` downgrade. A followed `https:`->`http:`
downgrade additionally emits a one-line warning through the `warn` hook (wired to
stderr by the CLI), because the remaining hops travel in cleartext.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**Timeout (`--timeout`).** Enforced two ways so a hostile/slow server cannot hang
the CLI: an idle-socket timeout (no bytes for `timeoutMs`) **and** a total
wall-clock deadline for the whole exchange. Without the latter a server that
drips one byte per interval — below both the idle timeout and `maxResponseBytes` —
could keep the request alive indefinitely. A breach of either surfaces as a
`DdbNetworkError`. Both timers are capped at `MAX_TIMEOUT_MS` (2^31 - 1 ms, the
longest delay Node's timers support; a longer one would fire after 1 ms), and the
CLI rejects a larger `--timeout` as a usage error.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `DdbApiError` (non-2xx,
carries `status`/`apiName`/`detail`/`url`/`method`/`body`, with `isRetryable`),
`DdbNetworkError` (transport failure/timeout), `DdbParseError` (bad JSON), and
`DdbUsageError` (a CLI usage error such as a wrong-length item id — no request
made), all extending `DdbError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback
  `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error-envelope mapping,
  `429`/`503` retry, redirect following, cross-origin credential stripping,
  `getText`.
- **`client.test.ts`** — the Solr passthrough path and params, `fq`/`facet.field`
  forwarding, content-type-aware `item` decoding (JSON vs XML), the item sub-paths,
  and that no `Authorization` header is sent — mocked transport.
- **`cli.test.ts`** — command parsing, `--filter`/`--facet`/`--sort`/`--fields`,
  the paging note, raw-XML item output, id validation, and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*`
  tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/deutsche-digitale-bibliothek-cli/>
in English and <https://maschinenlesbar-org.github.io/deutsche-digitale-bibliothek-cli/de/> in
German — is built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md`, the skills, and the skill
examples in `EXAMPLE.md` (German: `EXAMPLE.de.md`). The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/deutsche-digitale-bibliothek-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
