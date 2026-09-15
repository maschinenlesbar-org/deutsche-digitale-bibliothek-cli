---
name: ddb-item
description: >
  Fetch the full detail of one digitised object from the Deutsche Digitale
  Bibliothek by its id, using the deutsche-digitale-bibliothek-cli. Trigger when
  the user has a DDB object id (or a link to a DDB object page) and asks "show me
  the details of this DDB object", "get the Europeana metadata for this item",
  "what images/binaries belong to this record?", "list the child items of this
  archival record", "get the IIIF manifest for this object", or wants the view,
  EDM, binaries, source record, IIIF manifest, or hierarchy (parents and children)
  of a specific object. Resolves the 32-character id and picks the component.
version: 2.0.0
userInvocable: true
---

# DDB Item Detail

Given a 32-character DDB object id, this skill fetches one component of that
object's record from the v2 API.

## Tooling

This skill drives the `ddb` command. **Before anything else, validate it is available** — run `command -v ddb` (or `ddb --version`). If it is not on your PATH, STOP and inform the user that the `ddb` CLI (`@maschinenlesbar.org/deutsche-digitale-bibliothek-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The v2 read routes (search, item, version) are public — run the commands directly; there is nothing to register or pass. A `403` is unusual and means a custom `--base-url` hit an authenticated endpoint, not "you need a key" — surface that rather than retrying. Metadata returned by the CLI is CC0 (no attribution required); object *media* carry per-object rights — see DATA_LICENSE.md.

## Fetching an item

```bash
ddb item <id> [--part view|aip|edm|binaries|children|parents|source|source-description|source-record|iiif|citation] [--lang CODE]
```

The `<id>` is the exact **32-character** id — the `id` field from a search result,
or the trailing segment of a DDB object URL
(`deutsche-digitale-bibliothek.de/item/<id>`). Pick the component with `--part`:

| `--part` | Returns | Format |
|---|---|---|
| `view` *(default)* | the friendliest record — the data behind a DDB object page | JSON |
| `aip` | the full Archive Information Package | JSON |
| `edm` | the Europeana Data Model record (standardised, interoperable) | RDF/**XML** |
| `binaries` | related binary files (thumbnails, media) and their URLs | JSON |
| `children` | the direct children one level down (archival records, multi-part works) | JSON |
| `parents` | the whole chain up: the object itself, every ancestor, then the institution | JSON |
| `source` / `source-description` | the ingest source metadata / its description | JSON |
| `source-record` | the raw provider record (METS/MODS, LIDO, MARCXML) | **XML** |
| `iiif` | the IIIF Presentation manifest — only where the object has one | JSON |
| `citation` | a newspaper-issue citation file — only where applicable | BIB |

`--part children` also takes `--rows`/`--offset` for paging a large child set.
`--lang <code>` sets the label language for view/aip/edm/binaries/source*.

Both `children` and `parents` return `{ numberOfResults, hierarchy[] }`, each entry with
`id`, `parent`, `label`, `type` and `leaf`. In `parents`, `hierarchy[0]` is the object
itself (`leaf: true`) and the last entry is the providing institution
(`type: "institution"`, `parent: null`), and `numberOfResults` counts both. So a museum
object with no real hierarchy (`YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ`) still returns 2; an
archival record from Staatsarchiv München returned 7 (itself, four series, the
Archivtektonik, the archive). For "what is this part of?", skip `hierarchy[0]`, and
present the institution as the holder rather than as a parent record.

## Recipes

```bash
# Full friendly view of an object
ddb item TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK

# Standardised Europeana metadata (RDF/XML → straight to a file)
ddb item TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK --part edm -o object.edm.xml

# What media files does this object have, and under which licence?
ddb item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part binaries \
  | jq '.binary[] | {name, mimetype, licence: .kind, url: .local_pathname}'

# Media licence vs. metadata licence in the view
ddb item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ \
  | jq '{media: .item.license.resource, metadata: .item["metdata-rights"], rights: .item.rights}'

# Pipe a search straight into a detail lookup
ID=$(ddb search Goethe --fields id | jq -r '.response.docs[0].id')
ddb item "$ID"
```

## Traps

- **Ids are exactly 32 characters.** A wrong-length id is rejected up front
  (exit 2). If the user pastes a DDB object URL, take the last path segment.
- **`view` is the friendliest starting point**; reach for `edm` when the user
  wants standardised/interoperable metadata, `binaries` for the media files,
  `iiif` for a viewer manifest.
- **`edm` and `source-record` are XML**, printed raw (not JSON) — redirect to a
  `.xml` file or pipe to an XML tool, not `jq`. Every other component is JSON.
- **`iiif` and `citation` exist only for some objects** — a `404` (exit 4) there
  means "this object has no manifest / citation", not a bad id.
- **Object media rights vary per object** (the DDB "Lizenzkorb"): the CC0 status
  of the metadata does *not* extend to the image/audio/video — check the object's
  own rights statement before reusing its media. `--part binaries` lists file URLs;
  it does not download them.
- **Where the rights statement is.** In `view`, `item.rights` is often `""`; the media
  licence URI is in `item.license.resource` (e.g.
  `http://creativecommons.org/licenses/by-nc-nd/4.0/` for
  `YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ`), and the metadata licence sits under the key
  `item["metdata-rights"]`, misspelled upstream. In `--part binaries`, each file's
  licence URI is in `binary[].kind`, with `binary[].license_group` as a `rights_*` code.
  Report "no rights statement" only when all of these are empty.
- **`--lang` can 404.** `--lang en` returned `HTTP 404 … The content of the data column
  <sip_en> … is empty!` (exit 4) for all seven objects tried on 2026-09-15, while the
  same ids work without `--lang`. A 404 with `--lang` means "no view in that
  language": retry without it before concluding the id is wrong.
- A `404` on `view`/`aip` without `--lang` means the id doesn't exist — re-fetch it
  from a fresh `ddb search`.
- Don't have an id yet? Use the **ddb-search** skill to find one first.
