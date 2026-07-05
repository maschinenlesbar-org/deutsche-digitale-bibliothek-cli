# deutsche-digitale-bibliothek-cli

[![CI](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/deutsche-digitale-bibliothek-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/deutsche-digitale-bibliothek-cli)

Search Germany's **digitised cultural heritage** from your terminal. `ddb` is a
command-line tool over the
[Deutsche Digitale Bibliothek API](https://api.deutsche-digitale-bibliothek.de):
tens of millions of objects from German archives, libraries, museums and
research institutions — searchable, faceted, and returned as clean JSON you can
pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **One search over everything** — books, images, archival records, sheet music,
  film and more, across ~500 institutions.
- **Facets that actually help** — narrow by type, place, provider, sector, time
  and language; ask the API to count values for you.
- **Item detail on demand** — fetch an object's `view`, `edm` (Europeana Data
  Model), `binaries` list, hierarchy (`parents`/`children`) and more.
- **Clean JSON output** — pretty by default, `--compact` for scripting,
  `-o <file>` to write to disk.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/deutsche-digitale-bibliothek-cli
```

This installs the **`ddb`** command. Requires **Node.js 20+**.

Check it works (no key needed for this one):

```bash
ddb version
```

## API key

**Every command except `ddb version` requires an API key** — it is not bundled.
The key is **free**, but needs a personal account:

1. Register for **"Mein DDB"** at
   [deutsche-digitale-bibliothek.de](https://www.deutsche-digitale-bibliothek.de).
2. Generate your personal API key in the account settings.
3. Export it:

```bash
export DDB_API_KEY=your-personal-key
```

Or pass it per-invocation (it is a global option, so it works **before or after**
the command):

```bash
ddb --api-key your-personal-key search Goethe
```

Precedence is `--api-key` > `DDB_API_KEY` env var > none. Without a key the API
returns `403`; the CLI then prints a plain-language hint on how to get one.

## Quickstart

```bash
export DDB_API_KEY=your-personal-key

# Search objects matching a keyword (10 results by default)
ddb search Goethe

# How many objects match in total?
ddb search Goethe | jq '.numberOfResults'

# Narrow to images in Berlin, and count value distributions by type
ddb search Goethe --filter place_fct=Berlin --filter type_fct=Bild --facet type_fct

# Grab an object id from a result, then fetch its detail
ddb search Goethe | jq -r '.results[0].docs[0].id'
ddb item OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF
```

## Commands

| Command | What it does |
| --- | --- |
| `search <query>` | Full-text / faceted search over the object index (`GET /search`) |
| `item <id>` | Fetch one object by its 32-character id (`--part` selects the AIP component) |
| `facets [name]` | List the facet fields, or the values (with counts) of one facet |
| `institutions` | List the archives/libraries/museums registered at the DDB |
| `version` | Print the DDB backend version — **works without a key** |

New to terms like *facet*, *AIP*, *EDM*, *sector* or the `*_fct` fields? The
**[Glossary](GLOSSARY.md)** decodes every one.

### `search` options

| Option | Meaning |
| --- | --- |
| `--rows <n>` | Number of results (0..1000, default 10) |
| `--offset <n>` | Offset of the first result (paging) |
| `--sort <spec>` | `RELEVANCE` \| `ALPHA_ASC` \| `ALPHA_DESC` \| `RANDOM[_<seed>]` |
| `--facet <name>` | Compute value counts for this facet field — repeatable, e.g. `type_fct` |
| `--facet-limit <n>` | Cap the number of values returned per facet |
| `--filter <facet=value>` | Restrict to a facet value — repeatable, e.g. `place_fct=Berlin` |

`--filter` maps `facet=value` to the DDB's facet-value query parameter. Repeating
the same facet (`--filter place_fct=Berlin --filter place_fct=München`) narrows
by multiple values. Query strings use Solr syntax; pass `'*'` to match everything.

### Common facet fields

| Facet | Narrows by |
| --- | --- |
| `type_fct` | Object type (Bild, Buch, …) |
| `place_fct` | Place |
| `provider_fct` | Contributing institution |
| `sector_fct` | Cultural sector (archive, library, museum, …) |
| `language_fct` | Language |
| `keywords_fct` | Subject keywords |
| `time_fct` | Time period |

Run `ddb facets` to list them all, or `ddb facets place_fct` to see a facet's
values.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Paging: results 21–40 of a search
ddb search "Weimarer Republik" --rows 20 --offset 20

# Objects held in Bavaria, newest first, as compact JSON
ddb --compact search '*' --filter state_fct=Bayern --sort ALPHA_ASC

# The Europeana Data Model record for one object
ddb item OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF --part edm

# Which places have the most matches for "Bauhaus"?
ddb facets place_fct --query Bauhaus | jq '.facets[0].facetValues[:10]'

# All museums registered at the DDB, to a file
ddb --output museums.json institutions --sector sec_06
```

## Output & scripting

Every command prints **JSON to stdout** (except `version`, which prints the plain
version string). Errors and diagnostics go to stderr, so piping stdout into `jq`
stays clean.

```bash
# Titles of the current result page
ddb search Goethe | jq -r '.results[0].docs[] | "\(.id)\t\(.label)"'

# Total hits for a query
ddb search Goethe | jq '.numberOfResults'
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
| `1` | Any other runtime error — including `403` (missing/insufficient key) |

## Troubleshooting

- **`command not found: ddb`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/deutsche-digitale-bibliothek-cli …`.
- **Exit `1` / "Access denied (403)"** — no key was sent, or the key's security
  level is insufficient. Export `DDB_API_KEY` or pass `--api-key`. A free key is
  available from a "Mein DDB" account. (`ddb version` works without a key — use it
  to check connectivity.)
- **Exit `4` / "not found"** — the id passed to `item` doesn't exist. Re-fetch it
  from a fresh `search`. Ids are exactly 32 characters; a wrong-length id is
  rejected up front (exit `2`).
- **Empty `docs` array** — the query matched nothing; broaden the keyword, relax
  a `--filter`, or check `numberOfResults`.
- **Exit `1` / rate-limited** — the client retries `429`/`503` automatically up
  to `--max-retries` times; if it persists, slow down or raise `--timeout`.

## Global options

These may be given **before or after** the command, e.g.
`ddb --api-key $DDB_API_KEY search Goethe`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the CLI version number |
| `-h, --help` | Show help for the program or a command |
| `--api-key <key>` | DDB API key (env `DDB_API_KEY`) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--base-url <url>` | API base URL (default `https://api.deutsche-digitale-bibliothek.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
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
