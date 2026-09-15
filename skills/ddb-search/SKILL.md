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
| `type_fct` | media type (`mediatype_*` codes, see below) |
| `objecttype_fct` | object type (Druckgraphik, …) |
| `place_fct` | place |
| `provider_fct` | contributing institution |
| `sector_fct` | cultural sector (`sec_01`..`sec_07`, see below) |
| `language_fct` | language (`ger`, `eng`, …) |
| `keywords_fct` | subject keywords |
| `mimetype_fct` | MIME type of the media (`image/jpeg`, …) |

There is **no federal-state facet and no `time_fct`**: `state_fct` and `time_fct` fail
with exit 1 (`HTTP 500 … undefined field`). For time, filter on `begin_time` /
`end_time` (see the recipe and Traps).

**Media types** (`type_fct`), labelled by the `item.media` value of sampled objects on
2026-09-15:

| Code | Media | Code | Media |
|---|---|---|---|
| `mediatype_001` | audio | `mediatype_005` | video |
| `mediatype_002` | image | `mediatype_007` | unknown: no digitised media, metadata only (the largest group) |
| `mediatype_003` | text | `mediatype_010` | 3D model |

**Sectors** (`sector_fct`): `sec_01` archive, `sec_02` library, `sec_03` monument
protection, `sec_04` research, `sec_05` media library, `sec_06` museum, `sec_07` other.

For a pure **distribution** ("which places/providers have the most X?"), request
counts with `--rows 0` so you get facets without documents. Counts come back as a
**flat array** `[value, count, value, count, …]`, and can include values with count `0`.

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

# Top places as {value,count} pairs, zero counts dropped
ddb search Bauhaus --rows 0 --facet place_fct --facet-limit 10 \
  | jq '.facet_counts.facet_fields.place_fct
        | [range(0;length;2) as $i | {value:.[$i], count:.[$i+1]}]
        | map(select(.count > 0))'

# Objects whose date range starts in 1900–1909 (begin_time is a day number)
FROM=$(jq -n '1900 | (. - 1) as $p | 365*$p + ($p/4|floor) - ($p/100|floor) + ($p/400|floor) + 2')
TO=$(jq -n '1910 | (. - 1) as $p | 365*$p + ($p/4|floor) - ($p/100|floor) + ($p/400|floor) + 1')
ddb search Oktoberfest --filter "begin_time:[$FROM TO $TO]" --rows 0 | jq '.response.numFound'

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
- **Facets include zero counts.** `type_fct` for "Oktoberfest" lists `mediatype_001 0`
  and `mediatype_010 0`; with `--filter type_fct:mediatype_007 --facet mimetype_fct
  --facet-limit 4` all four values were `0`. The CLI can't set Solr's `facet.mincount`, so
  drop zeros (`map(select(.count > 0))`) before building a "top N"; a padded list can be
  all zeros.
- **Facet values are raw, not normalised.** `place_fct` for "Oktoberfest" returns
  `München` next to `München, Oktoberfest`, `München M; Oktoberfest` and
  `München, Königliche Polizeidirektion`, and mixes places with regions (`Bayern`). For
  "which places have the most X?", say the values are as delivered, or merge obvious
  variants of one place and say so.
- **`begin_time` / `end_time` are day numbers, not years.** The 1810 print
  `YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ` has `begin_time [660725]` (1 Jan 1810) and
  `end_time [661089]` (31 Dec 1810); the value is Python's `date.toordinal()` + 1. Convert
  years first (see recipe); `begin_time:[1900 TO 1909]` returns 0 hits without an error.
- **`--filter` is a raw Solr `fq`**, e.g. `type_fct:mediatype_002` or
  `place_fct:"Berlin"` — not `facet=value`. Quote values with spaces.
- **The query is required.** Use `'*:*'` to browse everything (still capped at `--rows`).
- **A paging note on stderr** (`… documents match; N shown`) is informational, not
  an error — stdout stays clean JSON. It is not printed for `--rows 0`.
- Fetching one object's detail → the **ddb-item** skill.
- The API returns **only CC0 metadata**; cite the DDB as the source as a courtesy.
