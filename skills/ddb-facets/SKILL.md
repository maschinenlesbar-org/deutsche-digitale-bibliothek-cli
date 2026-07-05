---
name: ddb-facets
description: >
  Explore and aggregate the Deutsche Digitale Bibliothek by facet — which places,
  object types, providers, languages or sectors have the most digitised objects —
  and list the DDB's partner institutions, using the deutsche-digitale-bibliothek-cli.
  Trigger when the user asks "which institutions have the most objects about the
  Bauhaus?", "what object types exist in the DDB?", "top places for medieval
  manuscripts", "list the museums registered at the DDB", or wants facet value
  distributions and counts rather than individual objects.
version: 1.0.0
userInvocable: true
---

# DDB Facets & Institutions

This skill answers "what values exist and how many objects each has" questions
(facet distributions) and lists the DDB's data partners.

## Tooling

This skill drives the `ddb` command. **Before anything else, validate it is available** — run `command -v ddb` (or `ddb --version`). If it is not on your PATH, STOP and inform the user that the `ddb` CLI (`@maschinenlesbar.org/deutsche-digitale-bibliothek-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required** for every command except `ddb version`. The key is free from a "Mein DDB" account (register at deutsche-digitale-bibliothek.de, then generate the key in the account settings). Provide it via the `DDB_API_KEY` environment variable or `--api-key`; never bundle or hard-code a key. A `403` means the key is missing or insufficient — tell the user how to get one rather than retrying. `ddb version` needs no key and is a quick connectivity check. Metadata returned by the CLI is CC0 (no attribution required); object *media* carry per-object rights — see DATA_LICENSE.md.

## Facets

```bash
ddb facets                 # list all available facet fields
ddb facets <name>          # values (with counts) for one facet
ddb facets <name> --query <q>   # scope those counts to a search query
```

Common facet fields: `type_fct`, `place_fct`, `provider_fct`, `sector_fct`,
`language_fct`, `keywords_fct`, `time_fct`, `state_fct`, `mimetype_fct`.

Two ways to get a distribution:
- **Global** — `ddb facets place_fct` gives place counts across the whole DDB.
- **Scoped to a query** — `ddb facets place_fct --query Bauhaus` gives place
  counts *among Bauhaus objects*. (Equivalently, `ddb search Bauhaus --facet
  place_fct` returns the facet alongside the results.)

## Institutions

```bash
ddb institutions [--sector sec_01..sec_07] [--has-items]
```

Sectors: `sec_01` Archive · `sec_02` Library · `sec_03` Monument protection ·
`sec_04` Research · `sec_05` Media · `sec_06` Museum · `sec_07` Other. The result
is a **nested tree** (institutions can contain sub-institutions).

## Recipes

```bash
# Top 10 places for "Bauhaus" objects
ddb facets place_fct --query Bauhaus | jq '.facets[0].facetValues[:10]'

# Which providers hold the most about a topic?
ddb search "mittelalterliche Handschrift" --facet provider_fct --facet-limit 10 \
  | jq '.facets[0].facetValues'

# All object types in the DDB
ddb facets type_fct | jq '.facets[0].facetValues'

# Museums with items, names only
ddb institutions --sector sec_06 --has-items | jq -r '.. | .name? // empty' | sort -u
```

## Traps

- **This skill is for distributions and partners, not individual objects.** For
  the objects themselves use the **ddb-search** skill; for one object's detail,
  **ddb-item**.
- **Facet values live under `.facets[0].facetValues`** as `{ value, count }` pairs.
- **`facets <name>` vs `search --facet <name>`:** the first is a dedicated facet
  lookup; the second returns the facet *together with* matching documents. Use
  whichever fits — both give the same value/count pairs.
- **`institutions` returns a nested tree** — recurse (`jq '..'`) to reach
  sub-institutions; don't assume a flat list.
- A `403` means the API key is missing/insufficient — surface the key hint.
- The API returns **only CC0 metadata**; cite the DDB as the source as a courtesy.
