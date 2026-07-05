---
name: ddb-item
description: >
  Fetch the full detail of one digitised object from the Deutsche Digitale
  Bibliothek by its id, using the deutsche-digitale-bibliothek-cli. Trigger when
  the user has a DDB object id (or a link to a DDB object page) and asks "show me
  the details of this DDB object", "get the Europeana metadata for this item",
  "what images/binaries belong to this record?", "list the child items of this
  archival record", or wants the view, EDM, binaries, or hierarchy (parents and
  children) of a specific object. Resolves the 32-character id and picks the AIP part.
version: 1.0.0
userInvocable: true
---

# DDB Item Detail

Given a 32-character DDB object id, this skill fetches one component of that
object's Archive Information Package (AIP).

## Tooling

This skill drives the `ddb` command. **Before anything else, validate it is available** — run `command -v ddb` (or `ddb --version`). If it is not on your PATH, STOP and inform the user that the `ddb` CLI (`@maschinenlesbar.org/deutsche-digitale-bibliothek-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**An API key is required** for every command except `ddb version`. The key is free from a "Mein DDB" account (register at deutsche-digitale-bibliothek.de, then generate the key in the account settings). Provide it via the `DDB_API_KEY` environment variable or `--api-key`; never bundle or hard-code a key. A `403` means the key is missing or insufficient — tell the user how to get one rather than retrying. `ddb version` needs no key and is a quick connectivity check. Metadata returned by the CLI is CC0 (no attribution required); object *media* carry per-object rights — see DATA_LICENSE.md.

## Fetching an item

```bash
ddb item <id> [--part view|aip|edm|binaries|children|parents|indexing-profile]
```

The `<id>` is the exact **32-character** id — the `id` field from a search result,
or the trailing segment of a DDB object URL
(`deutsche-digitale-bibliothek.de/item/<id>`). Pick the component with `--part`:

| `--part` | Returns |
|---|---|
| `view` *(default)* | the friendliest record — the data behind a DDB object page |
| `aip` | the complete package (all components) |
| `edm` | the Europeana Data Model record (standardised, interoperable) |
| `binaries` | related binary files (thumbnails, media) and their URLs |
| `children` / `parents` | items down / up a hierarchy (archival records, multi-part works) |
| `indexing-profile` | the profile used to index the item |

## Recipes

```bash
# Full friendly view of an object
ddb item OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF

# Standardised Europeana metadata
ddb item OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF --part edm

# What media files does this object have?
ddb item OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF --part binaries | jq '.'

# Pipe a search straight into a detail lookup
ID=$(ddb search Goethe | jq -r '.results[0].docs[0].id')
ddb item "$ID"
```

## Traps

- **Ids are exactly 32 characters.** A wrong-length id is rejected up front
  (exit 2). If the user pastes a DDB object URL, take the last path segment.
- **`view` is the friendliest starting point**; reach for `edm` when the user
  wants standardised/interoperable metadata, `binaries` for the media files.
- **`source` (raw provider XML) and binary file *downloads* are not exposed** by
  this CLI — it is JSON-only. `--part binaries` lists the files and their URLs;
  it does not download them.
- **Object media rights vary per object** (the DDB "Lizenzkorb"): the CC0 status
  of the metadata does *not* extend to the image/audio/video — check the object's
  own rights statement before reusing its media.
- A `404` means the id doesn't exist — re-fetch it from a fresh `ddb search`.
- Don't have an id yet? Use the **ddb-search** skill to find one first.
