# deutsche-digitale-bibliothek-cli

[![CI](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/deutsche-digitale-bibliothek-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/deutsche-digitale-bibliothek-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/deutsche-digitale-bibliothek-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/deutsche-digitale-bibliothek-cli/de/) — command reference, guides and API docs

Search Germany's **digitised cultural heritage** from your terminal. `ddb` is a
command-line tool over the **v2**
[Deutsche Digitale Bibliothek API](https://api.deutsche-digitale-bibliothek.de/2):
tens of millions of objects from German archives, libraries, museums and
research institutions — searchable, faceted, and returned as clean JSON you can
pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **No API key.** The v2 read routes are public — install and search, nothing to
  register.
- **One search over everything** — books, images, archival records, sheet music,
  film and more, across ~500 institutions, via the DDB's Apache Solr index.
- **Facets that actually help** — narrow by type, place, provider, sector, time
  and language; ask the index to count values for you.
- **Item detail on demand** — fetch an object's `view`, `edm` (Europeana Data
  Model), `binaries` list, hierarchy (`parents`/`children`), IIIF manifest and more.
- **Clean output** — pretty JSON by default, `--compact` for scripting,
  `-o <file>` to write to disk; XML components (`edm`, `source-record`) stream out raw.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/deutsche-digitale-bibliothek-cli
```

This installs the **`ddb`** command. Requires **Node.js 20+**.

Check it works:

```bash
ddb version        # prints the backend version, e.g. 7.5
```

## No API key needed

The read routes (`search`, `item`, `version`) are **public** — there is nothing to
register and no key to pass. Just run the commands.

A `403` is therefore unexpected: it means `--base-url` points at an authenticated
endpoint, or the specific item component is access-restricted — not "you need a key".

## Quickstart

```bash
# Search objects matching a keyword (10 results by default)
ddb search Goethe

# How many objects match in total?
ddb search Goethe | jq '.response.numFound'

# Narrow to images in Berlin, and count the type distribution
ddb search Goethe --filter 'place_fct:"Berlin"' --filter type_fct:mediatype_002 --facet objecttype_fct

# Grab an object id from a result, then fetch its detail
ddb search Goethe --fields id | jq -r '.response.docs[0].id'
ddb item TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK
```

## Commands

| Command | What it does |
| --- | --- |
| `search <query>` | Full-text / faceted search over the Solr object index (`GET /2/search/index/{collection}/{requestHandler}`) |
| `item <id>` | Fetch one component of an object by its 32-character id (`--part` selects the component) |
| `version` | Print the DDB backend version — a quick connectivity check |

New to terms like *facet*, *AIP*, *EDM*, *sector*, Solr `fq` or the `*_fct`
fields? The **[Glossary](GLOSSARY.md)** decodes every one.

### `search` options

| Option | Meaning |
| --- | --- |
| `--rows <n>` | Number of documents to return (Solr `rows`, default 10) |
| `--offset <n>` | Offset of the first document (Solr `start`) — for paging |
| `--sort <spec>` | Solr sort, e.g. `"score desc"` (relevance) or `"id asc"` |
| `--fields <list>` | Comma-separated fields to return (Solr `fl`), e.g. `id,label` |
| `--filter <fq>` | Solr filter query — repeatable, e.g. `type_fct:mediatype_002` |
| `--facet <field>` | Return value counts for this facet field — repeatable, e.g. `type_fct` |
| `--facet-limit <n>` | Cap the number of values returned per facet |
| `--collection <name>` | Solr collection (default `search`) |
| `--handler <name>` | Solr request handler (default `select`) |

Query strings and `--filter` use **Solr syntax**; pass `'*:*'` to match
everything. `--filter` restricts the set (repeat to AND; OR inside one fq like
`'place_fct:("Berlin" OR "Dessau")'`), while `--facet` only *counts* values.
When more documents match than were returned, `ddb` prints a short paging hint to
stderr.

### Common facet fields

| Facet | Narrows by |
| --- | --- |
| `type_fct` | Media type (`mediatype_*` codes) |
| `objecttype_fct` | Object type (Druckgraphik, …) |
| `place_fct` | Place |
| `provider_fct` | Contributing institution |
| `sector_fct` | Cultural sector (`sec_01`..`sec_07`) |
| `language_fct` | Language |
| `keywords_fct` | Subject keywords |
| `state_fct` | German federal state |

Facet counts come back under `facet_counts.facet_fields.<field>` as a flat
`[value, count, …]` array.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Paging: documents 21–40 of a search
ddb search "Weimarer Republik" --rows 20 --offset 20

# Everything from Bavaria, id + label only, as compact JSON
ddb --compact search '*:*' --filter 'state_fct:"Bayern"' --fields id,label

# The Europeana Data Model record for one object (RDF/XML, straight to a file)
ddb item TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK --part edm -o goethe.edm.xml

# Which places have the most matches for "Bauhaus"? (top of the flat facet array)
ddb search Bauhaus --rows 0 --facet place_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.place_fct'
```

## Output & scripting

`search` and JSON item components print **JSON to stdout**; `version` and the XML
components (`edm`, `source-record`) print raw text. Errors and diagnostics
(including the paging hint) go to stderr, so piping stdout into `jq` stays clean.

```bash
# id + label for the current result page
ddb search Goethe | jq -r '.response.docs[] | "\(.id)\t\(.label)"'

# Total hits for a query
ddb search Goethe | jq '.response.numFound'
```

Use `--compact` for single-line JSON and `-o <file>` to write to a file — both
are **global options** that work before or after the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Not found (`404` from the API) |
| `6` | Network / transport failure (DNS, connection, timeout, size cap) |
| `1` | Any other runtime error (including an unexpected `403`) |

## Troubleshooting

- **`command not found: ddb`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/deutsche-digitale-bibliothek-cli …`.
- **Exit `4` / "not found"** — the id passed to `item` doesn't exist (or that
  component isn't available for it — e.g. `iiif`/`citation` only exist for some
  objects). Re-fetch the id from a fresh `search`. Ids are exactly 32 characters;
  a wrong-length id is rejected up front (exit `2`).
- **Empty `docs` array** — the query matched nothing; broaden the keyword or relax
  a `--filter`, and check `response.numFound`.
- **Unexpected `403`** — the read routes are public, so this usually means a custom
  `--base-url` targets an authenticated endpoint, or the item component is
  access-restricted.
- **Rate-limited** — the client retries `429`/`503` automatically up to
  `--max-retries` times; if it persists, slow down or raise `--timeout`.

## Global options

These may be given **before or after** the command, e.g.
`ddb --compact search Goethe`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the CLI version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout (refuses to overwrite an existing file unless `--force`) |
| `--force` | Overwrite the `--output` file if it already exists |
| `--base-url <url>` | API base URL (default `https://api.deutsche-digitale-bibliothek.de/2`) |
| `--timeout <ms>` | Per-request timeout (default `30000`; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (0..10, default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term and facet explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is governed **separately from this tool's code**. See
**[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Deutsche Digitale Bibliothek** — the API serves metadata **exclusively under
> CC0 1.0** (no attribution required). The digital object *media* (not returned
> by this CLI) carry their own per-object rights — check each object's rights
> statement before reusing its media.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
