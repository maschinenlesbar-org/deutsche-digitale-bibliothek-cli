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
  (`ItemResult`) depending on the part.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`),
  every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
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

Every option, of the client and of `search()`/`item()` (`SearchParams`, `ItemOptions`), may be
omitted or given as `undefined`, which means the same (the default), so
`new DdbClient({ baseUrl: process.env.DDB_BASE_URL })` compiles under
`exactOptionalPropertyTypes` too.

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
`withRedactedOutput` in `run.ts` collects the exact userinfo of every argument that is a
URL with a scheme (and of the value part of `--opt=value`, `redactionFor`; the
`--base-url` value counts with or without its scheme) with the exported `credentialsIn` and
redacts it with `redactCredentials` from every line printed on stdout and from every log
record's *message*. The forms a server echoes a userinfo back in are replaced too: the
`Basic` value and the decoded `user:password` on stdout and stderr, the password alone
(4 characters or more) on stderr only, since it may well occur in the data. The log
replaces them before the record is cut and escaped; the record is then written to
the raw stderr, so its frame (time, level, topic) is never touched and a password with
DEL, C1 or bidi characters is matched in its raw form — commander's usage errors, which echo a
rejected value as typed, and the unknown-command message for a URL typed where a
command goes, included. Exact strings, not a pattern, so a password with spaces,
quotes, `#`, `?` or `/` is covered too (`apps/cli/test/conformance-p1-cli-redaction.test.ts`).
A bare `a:b@c` anywhere else (`-o run:2026-10-09@x.json`, a query, a User-Agent) is no
credential: `credentialsIn` reads userinfo only from a value that starts with a scheme.

The library keeps them out of logged objects too: the engine holds the base URL and
`defaultHeaders` in real `#private` fields, so `console.log(client)`,
`util.inspect` and `JSON.stringify` never show them, and it scrubs the base URL's
userinfo (raw and percent-decoded), and the forms a server echoes it back in (the
`Basic` value, the decoded `user:password`, the password alone from 4 characters:
`echoedCredentialForms`), from error bodies and details, redirect targets,
transport error text and the `cause` chain. Whatever a custom transport throws reaches
the caller as a `DdbNetworkError` (`GET <url> failed: <reason>`, the original as
`cause`), never as a raw `TypeError` (`apps/cli/test/conformance-p2-library-redaction.test.ts`).

The numeric options must be integers in range — `timeoutMs` 0..2^31−1, `maxRetries`
0..`MAX_RETRIES` (10), `retryDelayMs` 0..30 000, `maxRedirects` 0..20,
`maxResponseBytes` 0..`Number.MAX_SAFE_INTEGER` — or the constructor throws a
`DdbValidationError` naming the option; so does a `transport`, `sleep`, `warn`, `onRetry` or `onWarning` that
is not a function, a `defaultHeaders` that is not an object and a `bigIntegerKeys` that is not
a set or list of non-empty strings. The client also checks
its own parameters before any request: a `params`/`opts` that is not an object, a blank
or non-string `query`/`lang`/`sort`/filter, a non-integer
or negative `rows`/`start`/`offset` (at most `SOLR_MAX_INT`, 2^31−1), a `facetLimit` below −1 or
without `facetFields` throw a `DdbValidationError` (`Invalid <name>: expected …, got …`;
a value is quoted only when it is a short string, anything else is named by type).
No rejected input ever surfaces as a raw `TypeError`
(`apps/cli/test/conformance-p8-p9-p13-responses-and-errors.test.ts`).

Server text in a message is cleaned of control characters and cut at 500 characters,
and a request URL at 300 (`messageUrl`, ending in "… (N characters)"); `DdbApiError.url`
and `.body` keep them whole. A cut never lands inside a surrogate pair (`cutText`), so
the message stays well-formed. Any other value an own message quotes from a server
answer or the user's input (a redirect target, a quoted `/version` body or error
document, a request path or handler, a header name) is cut at `MAX_QUOTED_LENGTH` (200,
`cutForMessage`), so `err.message` stays bounded for a library caller. An HTTP `414` adds that the URL is too long and to shorten
the query or the `--filter` list.

### Library input validation

The library owns every rule about what a request may contain; the CLI only turns
argv strings into typed values and calls the same rules. The rules are pure,
exported functions in `packages/client/src` (`…Problem(value)` returns the reason a value is
invalid, or `undefined`). The client enforces them before any request through
`assertValid(name, value, problem)` from `packages/client/src/validate.ts`, which throws
**`DdbValidationError`** (`Invalid <name>: <reason>`); a client method rejects its
promise, a constructor throws. `DdbValidationError` extends `DdbUsageError`, so
`run.ts` maps it to exit 2 and logs it as an `ERROR` record of `ddb.cli`. The CLI's commander
parsers call the same functions and turn a reason into commander's
`InvalidArgumentError` (exit 2 too).

What the library rejects with `DdbValidationError` (every rejected input, the checks
above included):

- **Query and filters** (`search({ query, filters })`): blank (once trimmed, U+00A0 included)
  is rejected; otherwise each goes out through `normalizeText` (exported): surrounding
  whitespace trimmed, a Solr-escaped trailing space (`foo\ `) kept, composed Unicode (NFC).
- **Item ids** (`item(id)`): the id is trimmed (`normalizeItemId`) and must then
  be exactly 32 upper-case letters and digits (`itemIdProblem`); a lower-case id
  gets the upper-case form as a hint (`Invalid id: Item ids are upper case: try
  "…".`).
- **Solr collection and request handler** (`search({ collection, requestHandler })`):
  letters, digits, `.`, `_` and `-` only, and not `.` or `..` (`pathNameProblem`).
  The CLI's `--collection`/`--handler` parsers use the same rule. The engine's
  dot-segment guard in `buildUrl` stays as a backstop for any other path. Only
  handlers that return Solr's standard `response` envelope are supported: the P9
  shape check (`assertSolrResponse`) raises a `DdbParseError` that names the handler
  and that rule (`… are supported; handler "get" did not.`). There is no fallback
  for other shapes — the option is kept for collections whose `select`-style
  handler has another name.
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
(`packages/client/src/types.ts`), so callers can offer valid values and the CLI builds its
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
  would ignore them and answer the unfiltered set (`apps/cli/test/conformance-p10-strict-filters.test.ts`).
- `item(id, part?, opts?)` → an `ItemResult` (`GET /2/items/{id}...`). `part`
  defaults to `view`; others (`ITEM_PARTS`): `aip`, `edm`, `binaries`, `children`, `parents`,
  `source`, `source-description`, `source-record`, `iiif`, `citation`. The result
  has `json` (for JSON components) **or** `text` (for `edm`/`source-record`/
  `citation`, which the API serves as XML or a file), plus the `contentType`.
  `opts`: `lang` (localised labels), and `rows`/`offset` for `part: "children"`;
  passed for any other part they reject (`validateItemOptions`). When the API points
  a component at another item's same component (a `303` for a sub-item's
  `source-record`, whose `Location` lacks the `/2` prefix), the engine is told not to
  follow it (`RequestOptions.followRedirect`) and the client requests that ancestor's
  component through the base URL instead, up to `maxRedirects` ancestors; the result's
  `heldBy` names the item it belongs to (the CLI prints a stderr note), and an error at
  the end of the chain keeps its status and names the chain in its message.
- `version()` → the backend version string (`GET /2/version`), trimmed of
  surrounding whitespace (the body ends in a newline). A body that is not one short
  version token (letters, digits, `.`, `_`, `+`, `-`; an HTML page, JSON, an empty
  body) is a `DdbParseError`. The CLI prints it as is.

**2xx bodies are checked, never printed as data when they aren't** (`DdbParseError`,
exit 1). Every such error names the request, `GET <url>: …` (the absolute URL, userinfo redacted
as `***@`, cut at 300 characters: `RequestEngine.describeUrl`), like a network error: an unknown
charset, an empty body, a body that isn't JSON (naming its Content-Type when that isn't JSON
either: `GET <url>: the answer is not valid JSON (expected JSON, got Content-Type "text/html").`),
a wrong shape, an error document, an inexact number, a `/version` body that is no version, and
an answer too large to read as text at all (512 MB and more, possible with `--max-response-bytes 0`:
V8's longest string is 536 870 888 characters; with an error status the `DdbApiError` stays, its
`body` left empty).
`search` needs the documented Solr shape — a JSON object with a `response`
object holding an integer `numFound` and a `docs` array; a JSON item part must be an
object or an array (not `null`, an empty body or a scalar); and an error document sent
with a 2xx status (Solr's `{ error: { msg } }`, the DDB `{ name: "…Exception", message }`
envelope) is reported with its message. So is a body (search or a JSON item part) holding a
number JSON.parse cannot carry exactly — one out of a double's range (`1e400`, which printed as
`null`), one past 2^53 that it rounds, in any form (`12345678901234567890`,
`12345678901234567890.0`, `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small
for a double (`1e-400`, which became `0`), or a subnormal one (below 2.2250738585072014e-308, where a
double has fewer digits) that does not print as written (`3e-324` became `5e-324`): "the number …
cannot be represented exactly", never a changed value; `5e-324` or `1e-310` print as written and
pass. Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual precision. Past 2^53 the number
as written is compared with the number as printed (`String(value)`): a double a server wrote in its
shortest form (`1E23`, `1.7976931348623157E308`) prints as the same number and passes;
`12345678901234567890`, printed `12345678901234567000`, is refused.

**Text is never changed silently** (engine option `onWarning`). Bytes that are not valid in the
answer's charset (or UTF-8 without one), and a lone surrogate written as a JSON escape
(`"\ud800"`, half a character, which a JSON printer writes back and `jq` refuses with the whole
output), are replaced with U+FFFD, so the result is well-formed, and `onWarning` gets one line:
`GET <url>: 2 characters of the answer were not valid text (invalid bytes or a lone surrogate)
and replaced with U+FFFD.` It is not an error: one bad character never sinks a whole answer.
The CLI logs it as a WARN of `ddb.api` (`warn`, the other hook, is for the connection and goes
to `ddb.http`). It covers search, the JSON item parts and `/version`. A raw XML part is delivered
as its exact `bytes`, so nothing is reported for it; `ItemResult.replaced` says how many
characters its decoded `text` replaced, and the CLI warns when it shows that text on a terminal.

**Known big integers are declared, and delivered as strings** (engine option `bigIntegerKeys`,
a `ReadonlySet<string>` of member names, default none). The value of a declared member is
delivered as its exact literal as written, as a JSON string, whatever its size (`"_version_":5`
becomes `"5"`), so its type never depends on its size; a declared member whose value isn't a
number is left alone, and every undeclared number keeps the rule above. The client always
declares Solr's **`_version_`** (a 64-bit document version, about 1.85e18 on the live index,
which every search document carries) and adds a caller's own names to it; `SolrDoc._version_`
is typed `string`. In 0.8.0 every search with hits failed on it (Bug 05-1 of
`.reviews/2026-10-21-exploratory`). It is done in the same linear scan as the check
(`scanNumbers` in `engine.ts`): it skips strings, compares a member name in place, quotes the
declared values in the text before `JSON.parse` (only a literal the JSON grammar allows, so a
malformed `01` still fails), and copies the text only when it finds one — no reviver over the tree.

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

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/deutsche-digitale-bibliothek-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/deutsche-digitale-bibliothek-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/deutsche-digitale-bibliothek-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers and fixtures
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { DdbClient } from
  "@maschinenlesbar.org/deutsche-digitale-bibliothek-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/deutsche-digitale-bibliothek-client/internal/engine`)
  for what the CLI needs beyond that; `"./test/*"` reaches the client's test helpers and
  fixtures from the CLI's tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # SolrResponse/SolrDoc; ItemPart/ItemResult; SearchParams
    validate.ts  # the Problem type + assertValid (throws DdbValidationError)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building (base incl. /2), retry/backoff, redirects, decoding, errors
    errors.ts    # DdbError / DdbApiError / DdbNetworkError / DdbParseError / DdbUsageError / DdbValidationError
    client.ts    # DdbClient — search (Solr) / item (content-type aware) / version
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
  (`GET <url>: unexpected response shape: expected …`, exit 1). The CLI's
  `--filter`/`--facet`/`--sort`/`--fields` map straight onto `fq`/`facet.field`/
  `sort`/`fl`.
- `item()` fetches raw via the engine and **branches on the part**: the raw parts
  (`ITEM_TEXT_PARTS`: `edm`, `source-record`, `citation`) are returned as text, every other part
  is parsed as JSON whatever its Content-Type says, so an HTML page in its place (a captive
  portal, a proxy login, a wrong base URL) is a `DdbParseError` ("the answer is not valid JSON
  (expected JSON, got Content-Type "text/html")", exit 1), never data. JSON is
  parsed into `ItemResult.json`; the raw parts (RDF/XML, XML, BIB) are returned as
  `ItemResult.text` (decoded by the Content-Type's charset, UTF-8 when none is given or
  the label is unknown) plus the exact upstream `ItemResult.bytes`. Every JSON body —
  search, JSON item parts, `version` — is decoded by its declared charset too
  (`decodeBody`, a leading BOM dropped); an unknown charset label there is a
  `DdbParseError` naming it.
  The CLI writes those bytes unchanged with `-o` and to a non-terminal stdout
  (`CliIO.isTerminal()` false → `outBinary`); only a terminal gets the decoded text
  with control characters stripped.
- JSON output (stdout and the `-o` file) escapes what `JSON.stringify` leaves raw although a
  terminal acts on it: DEL, C1 (U+0080–U+009F) and the bidi controls (`isBidiControl`: U+061C,
  U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) become `\uXXXX`, the same JSON
  (`escapeControlChars`). Each becomes six characters, so the output is measured first: past V8's
  longest string it is an `OutputError` ("The answer is too large to print (N characters once its
  control characters are escaped).", ddb.output, exit 1); otherwise it is built in 64 Ki chunks
  and joined once, within memory on 100 MB of DEL characters.
- JSON output (`renderJson` in `apps/cli/src/cli/shared.ts`) is pretty by default. Printing can
  fail two ways, each an `OutputError` (an ERROR of `ddb.output`, exit 1) that names the cause:
  an answer nested too deeply ("The answer is nested too deeply to pretty-print[; try --compact].")
  and one whose text would pass V8's longest string ("The answer is too large (more than 536870888
  characters of JSON) to pretty-print[; try --compact]."). "try --compact" is added only when the
  compact form of that very answer prints: probed, never assumed from the Node version.
  `--compact` takes V8's fast `JSON.stringify` path, the only one that
  prints very deep nesting on Node 26, unless the answer holds a string or key of 64 Mi
  characters or more (`holdsHugeString`, iterative, linear and without an allocation per value):
  on Node 26 that path aborts the process on a
  ~250 MB string from JSON.parse, so such an answer goes through an empty gap (the same text).
- The engine accepts `defaultHeaders` merged into every request — the read routes
  need none; it's the injection seam for a caller that reaches an authed endpoint.
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

### Library / technical terms

**API client.** [`DdbClient`](packages/client/src/client.ts) — the typed wrapper over the
API, usable as a library independently of the CLI.

**SolrResponse.** The native Solr response returned by `search`: `{ responseHeader?,
response: { numFound, start, docs[] }, facet_counts? }`
([`types.ts`](packages/client/src/types.ts)). Each `SolrDoc` has a guaranteed `id` plus an
open index signature for the Solr fields.

**ItemResult.** The decoded body of an item component
([`types.ts`](packages/client/src/types.ts)): `{ part, contentType, json? , text? }` —
exactly one of `json`/`text` is set, chosen by the part (`ITEM_TEXT_PARTS` are text).

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs (base URL
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
the client waits; retrying sooner won't help"; `apps/cli/test/conformance-p6-retry-policy.test.ts`). `DdbApiError` exposes
`isRetryable` (true for `429`/`503`). A connection reset mid-request (`ECONNRESET`,
`EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain) is
retried the same way for a GET, whichever transport reported it
(`isTransientNetworkError`); a refused connection, a DNS failure or a timeout is not.
Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`ddb.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `packages/client/test/engine.test.ts`, `apps/cli/test/retry-log.test.ts`.

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
downgrade additionally emits a one-line warning through the `warn` hook (logged by the
CLI as a `WARN` record of `ddb.http`, its `Warning: ` prefix dropped), because the remaining hops travel in cleartext. A redirect to the
same origin keeps every header, whether its `Location` is relative or absolute.

**Plain-http base URL.** `cleartextProblem(baseUrl, secrets?)` (exported) returns one
sentence when the base URL is `http:` to a host other than loopback (`localhost`,
`127.0.0.0/8`, `::1`) — `requests to <host> are sent unencrypted (http:, not https:)`, or
naming the base URL's `user:password@` as "the base URL's credentials" (never the value) —
and `undefined` otherwise. The CLI logs it as a `WARN` record of `ddb.http` on stderr once per run,
before the first request (`action()` in `apps/cli/src/cli/shared.ts`); help, version and usage errors
never warn, and stdout and the exit code are untouched.

**Base-URL credentials per hop.** The userinfo of a base URL (`https://user:pw@mirror/2`,
for a proxy or mirror behind a login) never reaches a transport inside the URL: the
engine sends it as an `Authorization: Basic` header (unless `defaultHeaders` sets its own
`Authorization`), so the cross-origin rule above applies to it too. Userinfo in a
`Location` is never used. When a cross-origin hop dropped credentials and the target then
answers `401`/`403`, the error says so ("the server redirected http→https, which dropped
the base URL's credentials; use an https base URL").

**Transports must not follow redirects.** A custom transport must honour
`HttpRequest.redirect` (`"manual"`) and return a 3xx as is, never follow it: one that
follows it sends `defaultHeaders` and the base URL's `Authorization` to the redirect target
before the engine sees the answer, and the library cannot prevent that hop — a documented
limitation of the `transport` option, not something the engine can enforce. The engine passes `redirect: "manual"`
(`HttpRequest.redirect`) and follows redirects itself, because only it can drop headers
per hop; `fetch` follows by default and strips only `Authorization`, not `X-Auth-Token`
or `X-API-Key`. A fetch transport passes it on (`fetch(url, { redirect: req.redirect })`)
and reports `HttpResponse.url = response.url`; a response whose `url` lies on another
origin than the request is rejected as a `DdbNetworkError` ("the transport followed a
redirect to another origin"). Checked by `apps/cli/test/conformance-p3-redirect-credentials.test.ts`.

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
itself too, for every transport (`apps/cli/test/conformance-p5-transport-contract.test.ts`).

**Query builder.** [`buildQueryString`](packages/client/src/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`, optional `checkOutput`/`isTerminal`). Lets the
whole CLI run in tests with a mocked client and captured output — no subprocess.
`checkOutput` runs in `action()` before the client is built: an existing `-o` path
(without `--force`; a dangling link too) or a directory is a usage error there
(`OutputRefusedError`, a `DdbUsageError`: exit 2, an ERROR of `ddb.output`) with the message
`writeFile` would raise, so a refused write costs no request. `writeFile` is atomic: without
`--force` it claims the name with an exclusive create (so a file that appears meanwhile is still
refused, an `OutputError`, exit 1), writes a temporary file beside the target and renames it over
it; a write that fails part-way removes both, so no half-written file and no claimed name is left,
and with `--force` the old file stays as it was. `--force` keeps the old file's mode and writes
through a symlink to the file it points at. `-o -` (stdout) skips both.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `DdbApiError` (non-2xx,
carries `status`/`apiName`/`detail`/`url`/`method`/`body`, with `isRetryable`),
`DdbNetworkError` (transport failure/timeout), `DdbParseError` (bad JSON),
`DdbUsageError` (a usage error such as `--force` without `--output` — no request
made) and `DdbValidationError` (the library rejected an input before any request;
it extends `DdbUsageError`), all extending `DdbError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`, `types`),
with the transport helpers (`helpers.ts`, which `apps/cli/test/helpers.ts` re-exports next
to the CLI's own helpers) and the canned responses (`fixtures.ts`); everything that drives
the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback
  `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error-envelope mapping,
  `429`/`503` retry, redirect following, cross-origin credential stripping,
  `getText`.
- **`client.test.ts`** — the Solr passthrough path and params, `fq`/`facet.field`
  forwarding, content-type-aware `item` decoding (JSON vs XML), the item sub-paths,
  and that no `Authorization` header is sent — mocked transport.
- **`types.test.ts`** — a consumer file compiled with `exactOptionalPropertyTypes` against
  the built declarations (it starts `tsc`, so it gets 30 s), and every option given as
  `undefined` meaning its default.
- **`validate.test.ts`** — `assertValid`, the `DdbValidationError` → exit 2
  mapping and the `parity()` helper (`apps/cli/test/helpers.ts`), which sends one input
  through `run()` and through the library on one recording mock transport.
- **`cli.test.ts`** — command parsing, `--filter`/`--facet`/`--sort`/`--fields`,
  the paging note and the past-the-end note (an `--offset` at or beyond `numFound`, CLI only:
  the library returns Solr's answer as is), raw-XML item output, id validation, and exit
  codes — mocked client.
- **`io.test.ts`** — `-o` writes and refusals, and `handleOutputErrors()`: a reader that
  has gone (EPIPE, ENOTCONN), and any other stdout write error as an ERROR record of
  `ddb.output`.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`, `installWarningLog`); the CLI-level checks are
  P23's.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (fix plan
  `.reviews/2026-10-05-exploratory/fix-plan.md` in the workspace), one file per pattern, the same
  code in every repo apart from an adapter block at the top: P1 credential redaction in CLI output,
  P2 in library objects and errors, P3 credentials across redirects, P4/P19 base-URL validation
  (P19 skipped: `ddb` reads no environment variable), P5 the transport contract (timeout, size
  cap, body types, header shapes, resets), P6 the retry floor, P7 pipes and exit codes (spawns
  the built bin), P8/P9/P13 charset, 2xx body shapes and error classes, P10 strict search keys
  and repeated options, P12 `-o -` as stdout (also through the built bin), P20 the stderr warning
  for a plain-`http:` base URL (follow-up round `.reviews/2026-10-06-followup/round.md`; the
  environment and API-key cases skipped: `ddb` reads neither), P21 README links (a relative
  link must point at a file `files` ships — npmjs.com shows the README; anything else is an
  absolute GitHub URL), P23 the stderr log format, P24 the input corpus (the query and
`--filter` go out trimmed and in NFC or are refused; an item id in its canonical form or refused),
P25 the response corpus (a number a double can't carry exactly, or an empty answer, is an error),
P26 `-o` integrity (a write cut short under `ulimit -f` leaves the old file and no half-written one;
an existing file without `--force` is refused before any request; both start the built bin).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*`
  tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/deutsche-digitale-bibliothek-cli/>
in English and <https://maschinenlesbar.org/deutsche-digitale-bibliothek-cli/de/> in
German — is built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` (which also says where the published manifest
and the built program are: `manifest: apps/cli/package.json`, `program:
apps/cli/dist/src/cli/program.js`) and `site/_data/project.yml` (the German intro and the
access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/deutsche-digitale-bibliothek-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `ddb.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the API's answers: HTTP errors, the 403 hint, the paging notes, the ancestor note
of `item`, and a malformed answer, a `DdbParseError`: bad JSON, the wrong shape, an
error document with a success status, an unknown charset, a `/version` body that is no
version), `http` (the connection: network errors, the cleartext warning, the
https->http redirect downgrade) and `output` (`Wrote N bytes to …`, and any refusal or
failure to write the `-o` file: an `OutputError`, whatever the `CliIO` threw). Code logs through
`logOf(deps)` and never writes diagnostics with `io.err` directly. `run()` builds the
logger from argv before commander parses it (`logFormatFromArgv`, which skips the value
of one of the program's own value options, as commander does, and is used only for the records of a
parse error; a `preAction` hook then sets the format commander parsed, so `--user-agent
--log-format=jsonl` logs text), so commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a `(Did you mean …?)` line joined to it), the help
it shows after one an INFO record per line, and the program run with options but no
command (or `help` with an unknown name) an ERROR "missing command: `ddb <subcommand>`"
before that help, so every failed run has an ERROR record (`writeCommanderErr`). The log
is built with the run's redaction (`withRedactedOutput`), which replaces a secret in the
message only, before it is escaped: the frame is never touched, and a secret is kept out
of the log in either format. `CliDeps.now` makes the timestamps testable. stdout carries data only. What
happens outside `run()`, in the bin shim, is logged too, through `processLogger(argv)`
(the format argv asks for, the run's redaction): a stdout write error
(`handleOutputErrors`, e.g. EBADF) is an ERROR of `ddb.output`, `Could not write to
stdout: …`, and exits 1; Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
are WARN records of `ddb.cli`: the bin shim installs `installWarningLog`, which removes
Node's default `warning` listener and logs `(node) <name>: <message>`. In `defaultDeps` a
record waits for stdout (`stderrAfterStdout`): it is held while stdout has a backlog and
written, in order, once it is gone, so with `2>&1 |` and a slow reader it never lands
inside the data. Conformance test P23
checks all of this, and its body is shared across the *-cli repos.
