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

`timeoutMs` and `maxResponseBytes` hold for every transport, a custom one included: the
engine races each transport call against the deadline (and passes an `AbortSignal` as
`HttpRequest.signal`, which a fetch transport hands on: `fetch(url, { signal })`), and
checks the size of the body it gets back. A custom transport may return the body as a
`Buffer`, any `ArrayBuffer` view (`Uint8Array`) or an `ArrayBuffer`, and the headers as a
plain object in any case, a `Headers` object or a `Map`. It must not follow redirects
(`redirect: "manual"`, below). Whatever it throws, and a malformed response, becomes a
`DdbNetworkError`. A minimal fetch transport:

```ts
const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal, redirect: req.redirect });
  return { status: r.status, headers: r.headers as never, body: new Uint8Array(await r.arrayBuffer()) as Buffer, url: r.url };
};
```

`DdbClientOptions` is just the engine options — there is no `apiKey` field, since
the read routes are unauthenticated. (If you ever need to reach an authenticated
endpoint, inject an `Authorization` header via the engine's `defaultHeaders`; it
is stripped on cross-origin redirects, see below.)

The base URL is checked raw by the exported `validateBaseUrl` before the
trailing-slash strip: a blank value, surrounding whitespace, a URL that does not
parse, a scheme other than `http:`/`https:` and a query or fragment make the
constructor throw a `DdbValidationError` (`Invalid baseUrl: …`; userinfo is
allowed). It is a configuration error, not a `DdbNetworkError`: that class is kept
for the default transport's per-hop scheme check and real transport failures.

Userinfo is never printed. Messages show URLs through `redactUrl` (`https://***@host/…`),
which also cuts the userinfo out of a value that doesn't parse. The CLI goes further:
`withRedactedOutput` in `run.ts` collects the exact userinfo of every argument (and of
the value part of `--opt=value`) with the exported `credentialsIn` and redacts it from
every line it prints with `redactCredentials` — commander's usage errors, which echo a
rejected value as typed, and the unknown-command message for a URL typed where a
command goes, included. Exact strings, not a pattern, so a password with spaces,
quotes, `#`, `?` or `/` is covered too (`test/conformance-p1-cli-redaction.test.ts`).

The library keeps them out of logged objects too: the engine holds the base URL and
`defaultHeaders` in real `#private` fields, so `console.log(client)`,
`util.inspect` and `JSON.stringify` never show them, and it scrubs the base URL's
userinfo (raw and percent-decoded) from error bodies and details, redirect targets,
transport error text and the `cause` chain. Whatever a custom transport throws reaches
the caller as a `DdbNetworkError` (`GET <url> failed: <reason>`, the original as
`cause`), never as a raw `TypeError` (`test/conformance-p2-library-redaction.test.ts`).

The numeric options must be integers in range — `timeoutMs` 0..2^31−1, `maxRetries`
0..`MAX_RETRIES` (10), `retryDelayMs` 0..30 000, `maxRedirects` 0..20,
`maxResponseBytes` 0..`Number.MAX_SAFE_INTEGER` — or the constructor throws a
`DdbValidationError` naming the option; so does a `transport`, `sleep` or `warn` that
is not a function and a `defaultHeaders` that is not an object. The client also checks
its own parameters before any request: a `params`/`opts` that is not an object, a blank
or non-string `query`/`lang`/`sort`/filter, a non-integer
or negative `rows`/`start`/`offset` (at most `SOLR_MAX_INT`, 2^31−1), a `facetLimit` below −1 or
without `facetFields` throw a `DdbValidationError` (`Invalid <name>: expected …, got …`;
a value is quoted only when it is a short string, anything else is named by type).
No rejected input ever surfaces as a raw `TypeError`
(`test/conformance-p8-p9-p13-responses-and-errors.test.ts`).

Server text in a message is cleaned of control characters and cut at 500 characters,
and a request URL at 300 (`messageUrl`, ending in "… (N characters)"); `DdbApiError.url`
and `.body` keep them whole. An HTTP `414` adds that the URL is too long and to shorten
the query or the `--filter` list.

### Library input validation

The library owns every rule about what a request may contain; the CLI only turns
argv strings into typed values and calls the same rules. The rules are pure,
exported functions in `src/client` (`…Problem(value)` returns the reason a value is
invalid, or `undefined`). The client enforces them before any request through
`assertValid(name, value, problem)` from `src/client/validate.ts`, which throws
**`DdbValidationError`** (`Invalid <name>: <reason>`); a client method rejects its
promise, a constructor throws. `DdbValidationError` extends `DdbUsageError`, so
`run.ts` maps it to exit 2 and prints `Error: <message>`. The CLI's commander
parsers call the same functions and turn a reason into commander's
`InvalidArgumentError` (exit 2 too).

What the library rejects with `DdbValidationError` (every rejected input, the checks
above included):

- **Item ids** (`item(id)`): the id is trimmed (`normalizeItemId`) and must then
  be exactly 32 upper-case letters and digits (`itemIdProblem`); a lower-case id
  gets the upper-case form as a hint (`Invalid id: Item ids are upper case: try
  "…".`).
- **Solr collection and request handler** (`search({ collection, requestHandler })`):
  letters, digits, `.`, `_` and `-` only, and not `.` or `..` (`pathNameProblem`).
  The CLI's `--collection`/`--handler` parsers use the same rule. The engine's
  dot-segment guard in `buildUrl` stays as a backstop for any other path.
- **Base URL** (`baseUrl`), at construction (`validateBaseUrl`, `baseUrlProblem`):
  blank, surrounding whitespace, unparseable, not `http:`/`https:`, with a
  query or fragment, or with a `%` in the user name or password that doesn't start
  an escape (write a literal `%` as `%25`). `--base-url` uses the same rule, so its messages match.
- **Header values** (`userAgent`, `defaultHeaders`), at construction: a blank
  value, a C0 control character other than tab, DEL or anything above U+00FF
  (`headerValueProblem`, `assertHeaderValue`), and a `defaultHeaders` name that is
  not an HTTP token (`headerNameProblem`). Only an omitted `userAgent` selects the
  default; `--user-agent` uses the same rule.
- **Item options for a part that ignores them** (`item(id, part, opts)`,
  `validateItemOptions`): `lang` outside `ITEM_LANG_PARTS` and `rows`/`offset` for
  any part but `children` (`Invalid lang: applies only to part …`). The API would
  silently ignore them.
- **Item part** (`item(id, part)`): one of `ITEM_PARTS` (`itemPartProblem`,
  `Invalid part: Expected one of: view, aip, …`); an inherited name such as
  `toString` is rejected too. `--part` uses the same rule.

The domain constants behind these rules are exported from the package entry
(`src/client/types.ts`), so callers can offer valid values and the CLI builds its
parsers and help text from them instead of keeping copies: `ITEM_PARTS` (every
item component, frozen; `ItemPart` derives from it), `ITEM_LANG_PARTS` (the parts
that take `lang`) and `SOLR_MAX_INT` (2^31−1, the largest Solr int).

### Methods

- `search(params)` → a `SolrResponse` (`GET /2/search/index/{collection}/{requestHandler}`,
  default `search`/`select`). Params map to Solr: `query`→`q`, `rows` (default
  `DEFAULT_SEARCH_ROWS`, 10, sent explicitly), `start`,
  `sort`, `fields`→`fl`, `filters`→`fq` (repeatable), `facetFields`→`facet.field`
  (sets `facet=true`), `facetLimit`→`facet.limit`. `wt=json` is forced. A
  `facetLimit` of `-1` ("no limit") also sends `facet.sort=count`: Solr would otherwise
  switch to index (alphabetical) order for it, and the top of the facet array would no
  longer be the most frequent value. A key outside `SEARCH_PARAM_KEYS` (a misspelled
  `filter`, `__proto__`) and a `filters`/`facetFields` that is not an array are a
  `DdbValidationError`, and so is an `item()` option outside `ITEM_OPTION_KEYS`: the API
  would ignore them and answer the unfiltered set (`test/conformance-p10-strict-filters.test.ts`).
- `item(id, part?, opts?)` → an `ItemResult` (`GET /2/items/{id}...`). `part`
  defaults to `view`; others (`ITEM_PARTS`): `aip`, `edm`, `binaries`, `children`, `parents`,
  `source`, `source-description`, `source-record`, `iiif`, `citation`. The result
  has `json` (for JSON components) **or** `text` (for `edm`/`source-record`/
  `citation`, which the API serves as XML or a file), plus the `contentType`.
  `opts`: `lang` (localised labels), and `rows`/`offset` for `part: "children"`;
  passed for any other part they reject (`validateItemOptions`).
- `version()` → the backend version string (`GET /2/version`), trimmed of
  surrounding whitespace (the body ends in a newline). A body that is not one short
  version token (letters, digits, `.`, `_`, `+`, `-`; an HTML page, JSON, an empty
  body) is a `DdbParseError`. The CLI prints it as is.

**2xx bodies are checked, never printed as data when they aren't** (`DdbParseError`,
exit 1): `search` needs the documented Solr shape — a JSON object with a `response`
object holding an integer `numFound` and a `docs` array; a JSON item part must be an
object or an array (not `null`, an empty body or a scalar); and an error document sent
with a 2xx status (Solr's `{ error: { msg } }`, the DDB `{ name: "…Exception", message }`
envelope) is reported with its message.

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

**Redirect safety.** Before following a redirect that crosses an origin boundary the
engine drops every caller-supplied header (`Authorization`, `Proxy-Authorization`,
`X-API-Key`, `Cookie`, any token header) and a base URL's credentials; only its own
`Accept` and `User-Agent` go along. A custom transport must not follow redirects itself
(see "Transports must not follow redirects" below).
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
- **Item ids are exactly 32 upper-case letters and digits.** The client
  (`normalizeItemId`) trims the id and rejects any other one before a request, so
  a truncated or lower-cased id fails fast (`DdbValidationError`; exit 2 in the
  CLI) instead of a bare 404.

## Architecture

```
src/
  client/
    types.ts     # SolrResponse/SolrDoc; ItemPart/ItemResult; SearchParams
    validate.ts  # the Problem type + assertValid (throws DdbValidationError)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building (base incl. /2), retry/backoff, redirects, decoding, errors
    errors.ts    # DdbError / DdbApiError / DdbNetworkError / DdbParseError / DdbUsageError / DdbValidationError
    client.ts    # DdbClient — search (Solr) / item (content-type aware) / version
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # search, item, catalog (version)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
                 # (io.ts handleOutputErrors: EPIPE on stdout exits 0 quietly; on
                 #  stderr it is ignored so the run keeps its code)
    index.ts     # #! bin shim
```

**Design notes**

- `search()` builds the Solr passthrough path and forces `wt=json`, and checks the
  top-level shape only: a 2xx body that is not a JSON object (empty, `null`, an
  array) or whose `response` is not an object raises `DdbParseError`
  (`Unexpected response shape from <path>: expected …`, exit 1). The CLI's
  `--filter`/`--facet`/`--sort`/`--fields` map straight onto `fq`/`facet.field`/
  `sort`/`fl`.
- `item()` fetches raw via the engine and **branches on Content-Type**: JSON is
  parsed into `ItemResult.json`; anything else (RDF/XML, XML, BIB) is returned as
  `ItemResult.text` (decoded by the Content-Type's charset, UTF-8 when none is given or
  the label is unknown) plus the exact upstream `ItemResult.bytes`. Every JSON body —
  search, JSON item parts, `version` — is decoded by its declared charset too
  (`decodeBody`, a leading BOM dropped); an unknown charset label there is a
  `DdbParseError` naming it.
  The CLI writes those bytes unchanged with `-o` and to a non-terminal stdout
  (`CliIO.isTerminal()` false → `outBinary`); only a terminal gets the decoded text
  with control characters stripped.
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
Solr `error.msg`). A failing Solr request comes back as HTTP 500 with the Solr error
document as a *string* in the envelope's `message`; the engine unwraps it to that
document's `error.msg`. Every `detail` is stripped of control characters, folded to one
line and capped at 500 characters (`…`); the full body stays on `DdbApiError.body`.

**Retry / backoff.** Transient `429` and `503` responses are retried
automatically, up to `--max-retries`. Each retry waits `retryDelayMs * attempt` (200 ms,
400 ms, …), or longer when the response's `Retry-After` asks for it (delay-seconds or an
IMF-fixdate, parsed strictly by the exported `parseRetryAfter`); `Retry-After: 0` or a
date in the past never makes a zero-delay burst. A `Retry-After` above
`MAX_RETRY_AFTER_MS` (30 s) is not retried at all: the error surfaces at once and names
the requested wait ("the server asked to wait 31 s (Retry-After), longer than the 30 s
the client waits; retrying sooner won't help"; `test/conformance-p6-retry-policy.test.ts`). `DdbApiError` exposes
`isRetryable` (true for `429`/`503`). A connection reset mid-request (`ECONNRESET`,
`EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain) is
retried the same way for a GET, whichever transport reported it
(`isTransientNetworkError`); a refused connection, a DNS failure or a timeout is not.

**Redirects.** Only `301`/`302`/`303`/`307`/`308` with a parseable `Location` are
followed, up to `maxRedirects` (5). Any other 3xx, a missing or malformed
`Location` and a hop past the limit surface as a `DdbApiError` (exit 1) whose
`location` field and message name the target: `redirect to <url> not followed`
(resolved, userinfo redacted, sanitised) or `redirect not followed (no Location
header)`.

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary (scheme, host **or** port), the engine keeps only its own
`Accept` and `User-Agent` and drops every header passed in `defaultHeaders` (so
`Proxy-Authorization` or a custom token header too) before following it — this
includes a same-host `https:`->`http:` downgrade. A followed `https:`->`http:`
downgrade additionally emits a one-line warning through the `warn` hook (wired to
stderr by the CLI), because the remaining hops travel in cleartext. A redirect to the
same origin keeps every header, whether its `Location` is relative or absolute.

**Base-URL credentials per hop.** The userinfo of a base URL (`https://user:pw@mirror/2`,
for a proxy or mirror behind a login) never reaches a transport inside the URL: the
engine sends it as an `Authorization: Basic` header (unless `defaultHeaders` sets its own
`Authorization`), so the cross-origin rule above applies to it too. Userinfo in a
`Location` is never used. When a cross-origin hop dropped credentials and the target then
answers `401`/`403`, the error says so ("the server redirected http→https, which dropped
the base URL's credentials; use an https base URL").

**Transports must not follow redirects.** The engine passes `redirect: "manual"`
(`HttpRequest.redirect`) and follows redirects itself, because only it can drop headers
per hop; `fetch` follows by default and strips only `Authorization`, not `X-Auth-Token`
or `X-API-Key`. A fetch transport passes it on (`fetch(url, { redirect: req.redirect })`)
and reports `HttpResponse.url = response.url`; a response whose `url` lies on another
origin than the request is rejected as a `DdbNetworkError` ("the transport followed a
redirect to another origin"). Checked by `test/conformance-p3-redirect-credentials.test.ts`.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses. The built-in transport aborts
as soon as it is passed; for any transport the engine checks the body it gets back, and
the message names both the option and the flag (`sizeLimitMessage`).

**Timeout (`--timeout`).** Enforced two ways so a hostile/slow server cannot hang
the CLI: an idle-socket timeout (no bytes for `timeoutMs`) **and** a total
wall-clock deadline for the whole exchange. Without the latter a server that
drips one byte per interval — below both the idle timeout and `maxResponseBytes` —
could keep the request alive indefinitely. A breach of either surfaces as a
`DdbNetworkError`. Both timers are capped at `MAX_TIMEOUT_MS` (2^31 - 1 ms, the
longest delay Node's timers support; a longer one would fire after 1 ms), and the
CLI rejects a larger `--timeout` as a usage error. The engine enforces the deadline
itself too, for every transport (`test/conformance-p5-transport-contract.test.ts`).

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `DdbApiError` (non-2xx,
carries `status`/`apiName`/`detail`/`url`/`method`/`body`, with `isRetryable`),
`DdbNetworkError` (transport failure/timeout), `DdbParseError` (bad JSON),
`DdbUsageError` (a usage error such as `--force` without `--output` — no request
made) and `DdbValidationError` (the library rejected an input before any request;
it extends `DdbUsageError`), all extending `DdbError`.

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
- **`validate.test.ts`** — `assertValid`, the `DdbValidationError` → exit 2
  mapping and the `parity()` helper (`test/helpers.ts`), which sends one input
  through `run()` and through the library on one recording mock transport.
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
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German intro
and the access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/deutsche-digitale-bibliothek-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
