# Usage

`ddb` — a CLI for the Deutsche Digitale Bibliothek (DDB) API. This is the
use-case-driven cookbook; for the option reference see the
**[README](README.md)**, and for domain terms the **[Glossary](GLOSSARY.md)**.

```bash
ddb [global options] <command> [command options]
```

All commands except `version` need an API key — set `DDB_API_KEY` or pass
`--api-key` (see [README → API key](README.md#api-key)).

## Global options

| Option | Description |
|---|---|
| `--api-key <key>` | DDB API key (env: `DDB_API_KEY`) |
| `--base-url <url>` | API base URL (only `http:`/`https:` accepted) |
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

The query uses **Solr syntax**. Some starting points:

```bash
ddb search Goethe                         # simple keyword
ddb search "Weimarer Republik"            # phrase (quote it in your shell)
ddb search 'Goethe AND Faust'             # boolean operators
ddb search '*'                            # match everything (browse mode)
ddb search 'label:Faust'                  # field-scoped query
```

| Option | Description |
|---|---|
| `--rows <n>` | number of results (0..1000, default 10) |
| `--offset <n>` | offset of the first result (paging) |
| `--sort <spec>` | `RELEVANCE` / `ALPHA_ASC` / `ALPHA_DESC` / `RANDOM[_<seed>]` |
| `--facet <name>` | compute counts for this facet field (repeatable) |
| `--facet-limit <n>` | cap the number of values per facet |
| `--filter <facet=value>` | restrict to a facet value (repeatable) |

The default result shape is:

```json
{
  "numberOfResults": 12345,
  "results": [ { "numberOfDocs": 10, "docs": [ { "id": "…", "label": "…", "type": "…" } ] } ],
  "facets": [ … ]
}
```

### Filtering with facets

`--filter facet=value` narrows the result set to matching objects; `--facet name`
asks the API to return value counts for a facet (for building the next filter):

```bash
# Images (Bild) from Berlin
ddb search '*' --filter type_fct=Bild --filter place_fct=Berlin

# Two places at once (OR within the same facet)
ddb search Bauhaus --filter place_fct=Berlin --filter place_fct=Dessau

# Ask for the type distribution of a query, top 5 values
ddb search Goethe --facet type_fct --facet-limit 5 | jq '.facets[0].facetValues'
```

### Paging

```bash
# First page (1–10) then the next page (11–20)
ddb search Goethe --rows 10
ddb search Goethe --rows 10 --offset 10
```

## `item` — object detail

```bash
ddb item <id> [--part <component>]
```

`<id>` is the exact **32-character** id from a search result's `id`. The `--part`
option selects which component of the Archive Information Package (AIP) to fetch:

| `--part` | Returns |
|---|---|
| `view` *(default)* | the data set a DDB frontend object page is built on |
| `aip` | the full AIP (all components) |
| `edm` | the Europeana Data Model record |
| `binaries` | the list of related binary files (thumbnails, media) |
| `children` | child items (for hierarchical/archival objects) |
| `parents` | parent items up the hierarchy |
| `indexing-profile` | the profile used to index the item |

```bash
ID=$(ddb search Goethe | jq -r '.results[0].docs[0].id')
ddb item "$ID"
ddb item "$ID" --part edm
ddb item "$ID" --part binaries | jq '.'
```

## `facets` — explore facets

```bash
ddb facets                 # list the available facet fields
ddb facets place_fct       # values (with counts) for one facet
ddb facets place_fct --query Bauhaus   # scope the counts to a query
```

## `institutions` — the data partners

```bash
ddb institutions                        # all registered institutions (nested tree)
ddb institutions --has-items            # only those with items in the DDB
ddb institutions --sector sec_06        # only museums
```

Sector codes: `sec_01` Archive · `sec_02` Library · `sec_03` Monument protection
· `sec_04` Research · `sec_05` Media · `sec_06` Museum · `sec_07` Other.

## `version` — connectivity check

```bash
ddb version        # e.g. 6.12.5 — works WITHOUT an API key
```

Useful to confirm the API is reachable: if `version` works but `search` returns a
`403`, the problem is your key, not connectivity.

## Scripting recipes

```bash
# Object ids + labels of the current page
ddb search Goethe | jq -r '.results[0].docs[] | "\(.id)\t\(.label)"'

# Total number of matches
ddb search Goethe | jq '.numberOfResults'

# Top 10 providers for a query
ddb facets provider_fct --query Goethe | jq '.facets[0].facetValues[:10]'

# Save a full result set to disk
ddb --output goethe.json search Goethe --rows 100
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (e.g. a `403` with no/insufficient key), or a catch-all |
| `2` | usage error (bad flags, unknown command, wrong-length item id, bad `--base-url`) |
| `4` | HTTP 404 (not found) |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **Metadata returned by this CLI is CC0** (no attribution required); object
  *media* (not downloaded here) carry per-object rights — see
  [DATA_LICENSE.md](DATA_LICENSE.md).
- **`search` default fields** are whatever the Solr index returns per document;
  large objects can be verbose — use `jq` to project the fields you need.
- The API exposes **only CC0 metadata**, a narrower set than the DDB web portal.
