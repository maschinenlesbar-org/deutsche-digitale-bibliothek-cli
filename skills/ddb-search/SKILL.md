---
name: ddb-search
description: >
  Search Germany's digitised cultural heritage (archives, libraries, museums) via
  the Deutsche Digitale Bibliothek using the deutsche-digitale-bibliothek-cli.
  Trigger when the user asks "find objects about the Bauhaus in the DDB", "how
  many photographs of Goethe are digitised?", "search the Deutsche Digitale
  Bibliothek for medieval manuscripts", "museum objects from Berlin", "which
  places or institutions have the most objects about X?", "what object types
  exist in the DDB?", or wants to filter cultural objects by type, place,
  provider, sector, language or time and get result counts or facet
  distributions. Builds the Solr query, filter queries, facet counts and paging.
version: 2.0.0
userInvocable: true
---

# DDB Search

The Deutsche Digitale Bibliothek (DDB) aggregates tens of millions of digitised
objects from ~500 German cultural and scientific institutions. In v2, `ddb search`
is a thin wrapper over the DDB's Apache **Solr** index: this skill searches that
index, narrows it with filter queries, and reads facet distributions.

## Tooling

This skill drives the `ddb` command. **Before anything else, validate it is available** — run `command -v ddb` (or `ddb --version`). If it is not on your PATH, STOP and inform the user that the `ddb` CLI (`@maschinenlesbar.org/deutsche-digitale-bibliothek-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The v2 read routes (search, item, version) are public — run the commands directly; there is nothing to register or pass. A `403` is unusual and means a custom `--base-url` hit an authenticated endpoint, not "you need a key" — surface that rather than retrying. Metadata returned by the CLI is CC0 (no attribution required); object *media* carry per-object rights — see DATA_LICENSE.md.

## Searching

```bash
ddb search <query> [--rows N] [--offset N] [--sort SPEC] [--fields LIST] [--filter FQ] [--facet FIELD]
```

- The query uses **Solr syntax**: keywords, `"phrases"`, `AND`/`OR`/`NOT`,
  field-scoped terms (`title:Faust`), and **`*:*`** to match everything.
- `--rows` defaults to 10; page with `--offset` (Solr `start`).
- `--sort` is Solr syntax: `"score desc"` (relevance, the default) or `"id asc"`.
- `--fields id,label,type` trims verbose docs (Solr `fl`).
- Read **`response.numFound`** for "how many match?" — don't page everything to count.

## Response shape (native Solr)

| Path | What it is |
|---|---|
| `.response.numFound` | total hits — read this to count |
| `.response.docs[]` | this page of documents; each `.id` is the 32-char item id |
| `.facet_counts.facet_fields.<field>` | facet values + counts, when `--facet` used |

## Facets: filtering, counting, distributions

`--facet FIELD` asks Solr to return value counts for a facet. `--filter FQ`
restricts the set with a Solr filter query. Common facets:

| Facet | Narrows by |
|---|---|
| `type_fct` | media type (`mediatype_*` codes) |
| `objecttype_fct` | object type (Druckgraphik, …) |
| `place_fct` | place |
| `provider_fct` | contributing institution |
| `sector_fct` | cultural sector (`sec_01`..`sec_07`) |
| `language_fct` | language |
| `keywords_fct` | subject keywords |
| `state_fct` | German federal state |

For a pure **distribution** ("which places/providers have the most X?"), request
counts with `--rows 0` so you get facets without documents. Counts come back as a
**flat array** `[value, count, value, count, …]`.

## Recipes

```bash
# How many objects match "Bauhaus"? (just the total)
ddb search Bauhaus | jq '.response.numFound'

# Objects of a media type held in Berlin, key fields only
ddb search Goethe --filter type_fct:mediatype_002 --filter 'place_fct:"Berlin"' \
  --fields id,label,type --compact | jq '.response.docs[]'

# Object-type distribution for a query (top 10)
ddb search "mittelalterliche Handschrift" --rows 0 --facet objecttype_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.objecttype_fct'

# Top places as {value,count} pairs
ddb search Bauhaus --rows 0 --facet place_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.place_fct
        | [range(0;length;2) as $i | {value:.[$i], count:.[$i+1]}]'

# Second page of results (11–20)
ddb search Weimar --rows 10 --offset 10
```

## Traps

- **Read `response.numFound` to count** — never page all results just to total them.
- **Native Solr shape:** documents are `.response.docs[]` (not a nested
  `results[].docs[]`); the total is `.response.numFound`. Each doc's `id` is the
  32-character id for the **ddb-item** skill.
- **`--facet` returns counts; `--filter` restricts.** `--facet type_fct` *counts*
  the types; `--filter type_fct:mediatype_002` *keeps only* that type. Repeat
  `--filter` to AND constraints; OR inside one fq (`'place_fct:("Berlin" OR "Dessau")'`).
- **Facet counts are a flat array** `[value, count, …]` under
  `.facet_counts.facet_fields.<field>` — zip pairs in `jq` (see recipe).
- **`--filter` is a raw Solr `fq`**, e.g. `type_fct:mediatype_002` or
  `place_fct:"Berlin"` — not `facet=value`. Quote values with spaces.
- **The query is required.** Use `'*:*'` to browse everything (still capped at `--rows`).
- **A paging note on stderr** (`… documents match; N shown`) is informational, not
  an error — stdout stays clean JSON.
- Fetching one object's detail → the **ddb-item** skill.
- The API returns **only CC0 metadata**; cite the DDB as the source as a courtesy.
