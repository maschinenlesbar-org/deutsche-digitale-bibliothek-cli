# ddb-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Deutsche Digitale Bibliothek](https://www.deutsche-digitale-bibliothek.de/) (DDB): tens of
millions of digitised objects from German archives, libraries, museums and other institutions,
to search, count and facet, and one object's description, rights, hierarchy, media files and full
records, as tools for AI agents. Read-only, no API key. The metadata are CC0; the media an object
links to carry the holding institution's own rights (see Licence).

It is the MCP side of [deutsche-digitale-bibliothek-cli](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/deutsche-digitale-bibliothek-mcp
```

This installs the **`ddb-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/deutsche-digitale-bibliothek-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add ddb -- ddb-mcp
# or with the image:
claude mcp add ddb -- docker run -i --rm ghcr.io/maschinenlesbar-org/deutsche-digitale-bibliothek-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "ddb": { "command": "ddb-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "ddb": { "type": "stdio", "command": "ddb-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
ddb-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http ddb http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/deutsche-digitale-bibliothek-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/releases) instead of
`latest`: `…/deutsche-digitale-bibliothek-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/deutsche-digitale-bibliothek-mcp:<version> --repo maschinenlesbar-org/deutsche-digitale-bibliothek-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `searchObjects` | Objects for a Solr query and filters (media type, sector, place, provider, object type, language, keyword, years), a page at a time: label, media type, object types, holder, places, date range, media licence. |
| `countObjects` | How many objects match, and their distribution by media type, object type, place, provider, sector, language, keyword or MIME type: value/count pairs, zero counts dropped, codes explained. |
| `getObject` | One object by its id or page link: title, holding institution, displayed fields, and its rights where they really are (media and metadata licence). |
| `getObjectContext` | What an object is part of (series, fonds, the archive's structure), nearest first, and the institution that holds it. |
| `listObjectChildren` | The records one level below an object (the files of a series, the parts of a work), a page at a time. |
| `getObjectMedia` | An object's image, audio, video or text files: links, types, credit lines and each file's licence. |
| `getObjectRecord` | Any other component as text in chunks, a page at a time: EDM, the provider's own record (METS/MODS, LIDO, MARCXML), the archive information package, the ingest source, the IIIF manifest, a newspaper citation. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (an answer a redirect fetched from another host says so there: "…
(answered by https://other.example after a redirect)", and a WARN record names both) and the data
licence. Counts come from the index's total, never from
paging; years are turned into the index's day numbers; facet values are as the index holds them
(one place can come in several spellings). An unknown id, an object without a hierarchy, media or
IIIF manifest, a view missing in a language: each is said in words, with what to try. A failure
is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://api.deutsche-digitale-bibliothek.de/2)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one
  of those origins gets CORS (its preflight answered, the answers readable). With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as, a regular
  file (a FIFO is refused at once, never waited on); read once at start; `(umask 077; openssl rand
  -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and
  stops a tool call after its deadline (a tool that has read part of its answer by then may answer
  with that part, and says so). A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log
  says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi,
  zero-width, tag and other invisible characters removed, but an emoji keeps its joiners; a key
  that cleaning makes equal to another stays, as `name~2`), but it is still other people's text:
  a model can be told things in it. The server can't act on that (it has no tool that writes),
  but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio a signal ends it at once; when stdin ends, it first answers the
  requests it has read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory. The answers it reads are small (a search reads at most 50 objects, a
  record is served in pages of chunks).
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/blob/main/LICENSING.md)).
Data: the DDB's API serves only metadata under CC0 1.0
(https://creativecommons.org/publicdomain/zero/1.0/): free to use, commercially too, no
attribution required, though naming the DDB and the holding institution is good practice
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/blob/main/DATA_LICENSE.md)).
The media an object links to (images, audio, video) are not covered: each carries its own rights
statement, chosen by the holding institution from the DDB's licence basket (CC BY, CC BY-NC-ND,
In Copyright, Public Domain Mark, …). Every result carries this note in its `licence` field;
`getObject` and `getObjectMedia` give the rights of each object and file. We provide the tool,
not the data.
