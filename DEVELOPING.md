# Developing & integrating

This document covers `deutsche-digitale-bibliothek-cli` as a **TypeScript
library**, plus its architecture, testing and release setup. If you just want to
use the command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`ddb`) and a typed API client (`DdbClient`) for the
[Deutsche Digitale Bibliothek API](https://api.deutsche-digitale-bibliothek.de)
(`api.deutsche-digitale-bibliothek.de`), central access to digitised
cultural-heritage objects from German archives, libraries and museums.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https`
  (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — a typed search envelope; item details and views exposed as
  faithful `JsonObject`s (the DDB serves those as opaque JSON).
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

const client = new DdbClient({ apiKey: process.env.DDB_API_KEY });

const result = await client.search({ query: "Goethe", rows: 10, facet: ["type_fct"] });
console.log(result.numberOfResults, result.results[0]?.docs.length);

const item = await client.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF");        // view component
const edm = await client.item("OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", "edm");  // Europeana Data Model

try {
  await client.search({ query: "*" });
} catch (err) {
  if (err instanceof DdbApiError) console.error(err.status, err.apiName, err.detail);
}
```

### Client options

```ts
new DdbClient({
  apiKey: process.env.DDB_API_KEY, // Authorization: OAuth oauth_consumer_key="<key>"
  baseUrl: "https://api.deutsche-digitale-bibliothek.de",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

### Methods

- `search(params)` → the search envelope (`GET /search`).
- `item(id, part?)` → one AIP component (`view` default, else `aip`, `edm`,
  `binaries`, `children`, `parents`, `indexing-profile`).
- `facets()` → the available facet fields (`GET /search/facets`).
- `facetValues(name, { query? })` → values + counts for one facet.
- `institutions({ hasItems?, sector? })` → the registered institutions.
- `version()` → the backend version string (**public — no key needed**).

## Authentication internals

Every DDB endpoint **except `/version`** requires an API key. The client sends it
as `Authorization: OAuth oauth_consumer_key="<key>"` (the DDB's header-based
OAuth-1.0a scheme; the consumer key alone suffices — no signing). The key is
**not bundled** — it must be supplied via `apiKey` (library), `--api-key` (CLI),
or the `DDB_API_KEY` env var, else the header is omitted and the API returns
`403 NotAuthorizedException`. Precedence is **`--api-key` > `DDB_API_KEY` > none**.

> **Getting a key.** A key is free but requires a personal account: register for
> "Mein DDB" at https://www.deutsche-digitale-bibliothek.de, then generate your
> API key in the account settings. There is **no** publicly-scrapable shared key
> (unlike some sibling CLIs), so this repo intentionally ships **no**
> `fetch-api-key.mjs` — supply your own key for any live run.

The DDB also supports passing the key as an `oauth_consumer_key` **query
parameter**; this client uses the **header** form instead, because it is a
credential header and is therefore stripped on cross-origin redirects (below) and
kept out of URLs/logs.

**Redirect safety.** When the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port), the client **strips credential
headers** (`Authorization`, `X-API-Key`, `Cookie`) before following it, so your
API key is never sent to a host other than the one you targeted. Same-origin
redirects keep it.

## Notes on the live API (verify-first findings)

The upstream docs are partly stale; these were confirmed against the live service:

- **`/version` is public.** The OpenAPI spec marks it as requiring a key
  (`403` otherwise), but the live endpoint returns the version string
  anonymously. The CLI exposes it as `ddb version`, a no-key connectivity check.
- **`/search/suggest` "does not work at the public API"** (per the spec) — so it
  is deliberately **not** exposed by this CLI.
- **Errors come back as a JSON envelope** `{ name, message, stacktrace }` with a
  proper HTTP status (`403` NotAuthorizedException, `404` ItemNotFoundException,
  …). `DdbApiError` surfaces `name` as `apiName` and `message` as `detail`.
- **Item ids are exactly 32 characters.** The `item` command validates this up
  front so a truncated id fails fast with exit 2 instead of a bare 404.

## Architecture

```
src/
  client/
    types.ts     # SearchResponse envelope; item details/views as JsonObject
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # DdbError / DdbApiError / DdbNetworkError / DdbParseError / DdbUsageError
    client.ts    # DdbClient — search / item / facets / institutions / version (injects Authorization)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver (incl. --api-key), JSON renderer
    commands/    # search, item, catalog (facets/institutions/version)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The engine accepts `defaultHeaders` merged into every request — the seam used
  to inject `Authorization: OAuth oauth_consumer_key="<key>"`. The CLI surfaces it
  as `--api-key` (or `DDB_API_KEY`).
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

### Library / technical terms

**API client.** [`DdbClient`](src/client/client.ts) — the typed wrapper over the
API, usable as a library independently of the CLI.

**SearchResponse.** The search envelope returned by `search`: `{ numberOfResults,
results: [{ docs, numberOfDocs }], facets?, correctedQuery?, randomSeed?,
highlightedTerms? }` ([`types.ts`](src/client/types.ts)). Result documents carry
a curated set of known fields (`id`, `label`, `type`, …) plus an index signature.

**JsonObject.** An item's `view`/`aip`/`edm`/… component, typed as a faithful raw
`JsonObject` — the DDB serves those as opaque JSON.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON/raw
responses and maps errors.

**Retry / backoff.** Transient `429` and `503` responses are retried
automatically with backoff, up to `--max-retries`. `DdbApiError` exposes
`isRetryable` (true for `429`/`503`).

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary, the engine strips credential headers
(`Authorization`, `X-API-Key`, `Cookie`) before following it.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

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
- **`client.test.ts`** — the `Authorization` header, per-method paths, search
  params, facet-value filters, filter/core-key collision — mocked transport.
- **`cli.test.ts`** — command parsing, `--api-key`/`DDB_API_KEY`,
  `--facet`/`--filter`/`--sort`, id validation, and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*`
  tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
