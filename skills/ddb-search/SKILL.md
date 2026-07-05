---
name: ddb-search
description: >
  Search Germany's digitised cultural heritage (archives, libraries, museums) via
  the Deutsche Digitale Bibliothek using the deutsche-digitale-bibliothek-cli.
  Trigger when the user asks "find objects about the Bauhaus in the DDB", "how
  many photographs of Goethe are digitised?", "search the Deutsche Digitale
  Bibliothek for medieval manuscripts", "museum objects from Berlin", or wants to
  filter cultural objects by type, place, provider, sector, language or time and
  get result counts. Builds the query, facet filters and result paging.
version: 1.0.0
userInvocable: true
---

# DDB Search

The Deutsche Digitale Bibliothek (DDB) aggregates tens of millions of digitised
objects from ~500 German cultural and scientific institutions. This skill searches
that index and narrows it with facets.

## Tooling

This skill drives the `ddb` command. **Before anything else, validate it is available** — run `command -v ddb` (or `ddb --version`). If it is not on your PATH, STOP and inform the user that the `ddb` CLI (`@maschinenlesbar.org/deutsche-digitale-bibliothek-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required** for every command except `ddb version`. The key is free from a "Mein DDB" account (register at deutsche-digitale-bibliothek.de, then generate the key in the account settings). Provide it via the `DDB_API_KEY` environment variable or `--api-key`; never bundle or hard-code a key. A `403` means the key is missing or insufficient — tell the user how to get one rather than retrying. `ddb version` needs no key and is a quick connectivity check. Metadata returned by the CLI is CC0 (no attribution required); object *media* carry per-object rights — see DATA_LICENSE.md.

## Searching

```bash
ddb search <query> [--rows N] [--offset N] [--sort SPEC] [--facet NAME] [--filter FACET=VALUE]
```

- The query uses **Solr syntax**: keywords, `"phrases"`, `AND`/`OR`/`NOT`,
  field-scoped terms, and `*` to match everything.
- `--rows` defaults to 10 (max 1000); page with `--offset`.
- Read **`numberOfResults`** for "how many match?" — don't page everything to count.

## Facets: narrowing and counting

`--facet NAME` asks the API to return value counts for a facet. `--filter
FACET=VALUE` restricts to that value (repeat for OR within a facet). Common facets:

| Facet | Narrows by |
|---|---|
| `type_fct` | object type (Bild, Buch, …) |
| `place_fct` | place |
| `provider_fct` | contributing institution |
| `sector_fct` | cultural sector |
| `language_fct` | language |
| `keywords_fct` | subject keywords |
| `time_fct` | time period |
| `state_fct` | German federal state |

Run `ddb facets` for the full list, or use the **ddb-facets** skill to explore a
facet's values.

## Recipes

```bash
# How many objects match "Bauhaus"? (just the total)
ddb search Bauhaus | jq '.numberOfResults'

# Photographs (Bild) of Goethe held in Berlin, key fields
ddb search Goethe --filter type_fct=Bild --filter place_fct=Berlin --compact \
  | jq '.results[0].docs[] | {id, label, type}'

# Type distribution for a query (top 10 values)
ddb search "mittelalterliche Handschrift" --facet type_fct --facet-limit 10 \
  | jq '.facets[0].facetValues'

# Second page of results (11–20)
ddb search Weimar --rows 10 --offset 10
```

## Traps

- **Read `numberOfResults` to count** — never page all results just to total them.
- **Results are nested:** `.results[0].docs[]` holds the documents; each doc's
  `id` is the 32-character id for the **ddb-item** skill.
- **`--facet` returns counts; `--filter` restricts.** They are different: use
  `--facet type_fct` to *see* the types, `--filter type_fct=Bild` to *keep only*
  images. Repeating `--filter place_fct=…` ORs the places.
- **The query is required.** Use `'*'` to browse everything (still capped at
  `--rows`).
- **A `403`** means the API key is missing/insufficient, not that nothing matched
  — surface the key hint, don't retry blindly.
- Fetching one object's detail → the **ddb-item** skill; browsing facet values or
  institutions → the **ddb-facets** skill.
- The API returns **only CC0 metadata**; cite the DDB as the source as a courtesy.
