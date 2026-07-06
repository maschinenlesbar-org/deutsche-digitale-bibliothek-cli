# Usage

`ddb` — a CLI for the Deutsche Digitale Bibliothek (DDB) **v2** API. This is the
use-case-driven cookbook; for the option reference see the
**[README](README.md)**, and for domain terms the **[Glossary](GLOSSARY.md)**.

```bash
ddb [global options] <command> [command options]
```

The v2 read routes are **public — no API key**. Just run the commands.

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (default `…/2`; only `http:`/`https:` accepted) |
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-o, --output <file>` | write output to a file instead of stdout |
| `-V, --version` / `-h, --help` | version / help |

## `search` — find objects

```bash
ddb search <query> [options]
```

v2 search is a **Solr passthrough**: the query and `--filter` use Solr syntax, and
the response is **native Solr JSON**. Some starting points:

```bash
ddb search Goethe                         # simple keyword
ddb search "Weimarer Republik"            # phrase (quote it in your shell)
ddb search 'Goethe AND Faust'             # boolean operators
ddb search '*:*'                          # match everything (browse mode)
ddb search 'title:Faust'                  # field-scoped query
```

| Option | Description |
|---|---|
| `--rows <n>` | number of documents (Solr `rows`, default 10) |
| `--offset <n>` | offset of the first document (Solr `start`, paging) |
| `--sort <spec>` | Solr sort, e.g. `"score desc"` or `"id asc"` |
| `--fields <list>` | fields to return (Solr `fl`), e.g. `id,label,type` |
| `--filter <fq>` | Solr filter query (repeatable), e.g. `type_fct:mediatype_002` |
| `--facet <field>` | return counts for this facet field (repeatable) |
| `--facet-limit <n>` | cap the number of values per facet |
| `--collection <name>` | Solr collection (default `search`) |
| `--handler <name>` | Solr request handler (default `select`) |

The result shape is native Solr:

```json
{
  "responseHeader": { "status": 0, "params": { "q": "Goethe", "rows": "10" } },
  "response": {
    "numFound": 99866,
    "start": 0,
    "docs": [ { "id": "…", "label": "…", "type": ["mediatype_002"] } ]
  },
  "facet_counts": { "facet_fields": { "type_fct": ["mediatype_003", 50024] } }
}
```

### Filtering with facets

`--filter <fq>` narrows the result set with a Solr filter query; `--facet <field>`
asks Solr to return value counts for a facet (to build the next filter):

```bash
# Images (a media-type code) from Berlin
ddb search '*:*' --filter type_fct:mediatype_002 --filter 'place_fct:"Berlin"'

# Two places at once (OR inside one filter query)
ddb search Bauhaus --filter 'place_fct:("Berlin" OR "Dessau")'

# Ask for the object-type distribution of a query, top 5 values
ddb search Goethe --rows 0 --facet objecttype_fct --facet-limit 5 \
  | jq '.facet_counts.facet_fields.objecttype_fct'
```

Facet counts arrive as a **flat array** `[value, count, value, count, …]`. To turn
one into `{value, count}` objects:

```bash
ddb search Bauhaus --rows 0 --facet place_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.place_fct
        | [range(0; length; 2) as $i | {value: .[$i], count: .[$i+1]}]'
```

### Paging

```bash
# First page (1–10) then the next page (11–20)
ddb search Goethe --rows 10
ddb search Goethe --rows 10 --offset 10
```

When more documents match than were returned, `ddb` prints a note like
`Note: 99866 documents match; 10 shown.` to **stderr** — page with `--offset` or
narrow with `--filter`. Read `response.numFound` for the true total.

## `item` — object detail

```bash
ddb item <id> [--part <component>] [--lang <code>]
```

`<id>` is the exact **32-character** id from a search result's `id`. `--part`
selects which component to fetch — most are JSON, a few are XML / a plain file
and print **raw** (so `> file.xml` and piping keep them intact):

| `--part` | Returns | Format |
|---|---|---|
| `view` *(default)* | the data set a DDB frontend object page is built on | JSON |
| `aip` | the full Archive Information Package | JSON |
| `edm` | the Europeana Data Model record | RDF/**XML** |
| `binaries` | related binary files (thumbnails, media) and their URLs | JSON |
| `children` | child items (accepts `--rows`/`--offset`) | JSON |
| `parents` | parent items up the hierarchy | JSON |
| `source` | the ingest source metadata | JSON |
| `source-description` | a description of the source record | JSON |
| `source-record` | the raw provider record (METS/MODS, LIDO, MARCXML) | **XML** |
| `iiif` | the IIIF Presentation manifest (only where present → else `404`) | JSON |
| `citation` | a newspaper-issue citation file (only where applicable) | BIB file |

`--lang <code>` sets the preferred label language for
`view`/`aip`/`edm`/`binaries`/`source`/`source-description`.

```bash
ID=$(ddb search Goethe --fields id | jq -r '.response.docs[0].id')
ddb item "$ID"
ddb item "$ID" --part edm -o object.edm.xml     # RDF/XML → file
ddb item "$ID" --part binaries | jq '.'
ddb item "$ID" --part children --rows 20         # first 20 children
```

## `version` — connectivity check

```bash
ddb version        # e.g. 7.5
```

Useful to confirm the API is reachable and the CLI is wired up.

## Scripting recipes

```bash
# Object ids + labels of the current page
ddb search Goethe | jq -r '.response.docs[] | "\(.id)\t\(.label)"'

# Total number of matches
ddb search Goethe | jq '.response.numFound'

# Top 10 providers for a query (flat facet array)
ddb search Goethe --rows 0 --facet provider_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.provider_fct'

# Save a full result page to disk
ddb --output goethe.json search Goethe --rows 100
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error, or a catch-all (includes an unexpected `403`) |
| `2` | usage error (bad flags, unknown command, wrong-length item id, bad `--base-url`) |
| `4` | HTTP 404 (not found) |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **No API key.** The read routes are public; a `403` means a custom `--base-url`
  hit an authenticated endpoint or the item component is access-restricted.
- **Metadata returned by this CLI is CC0** (no attribution required); object
  *media* (not downloaded here) carry per-object rights — see
  [DATA_LICENSE.md](DATA_LICENSE.md).
- **`search` returns native Solr JSON.** Hits live under `response.docs[]`, the
  total is `response.numFound`, facet counts under `facet_counts.facet_fields`.
- **Docs can be verbose** — use `--fields`/`fl` or `jq` to project what you need.
- The API exposes **only CC0 metadata**, a narrower set than the DDB web portal.
