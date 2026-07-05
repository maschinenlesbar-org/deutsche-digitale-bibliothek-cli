# Glossary

Domain and technical terms you meet when using `ddb`. For the option reference
see the **[README](README.md)** and the full cookbook in **[Usage.md](Usage.md)**.

## The DDB and its data

**Deutsche Digitale Bibliothek (DDB).** Germany's national aggregator for
digitised cultural and scientific heritage. It does not hold objects itself; it
harvests metadata from ~500 partner institutions (archives, libraries, museums,
research bodies) and offers one shared search across them.

**Object / item.** A single catalogued thing — a book, image, archival record,
piece of sheet music, film, audio recording, etc. Identified by a **32-character
id** (e.g. `OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF`), the value in a search result's
`id` and the argument to `ddb item`.

**Institution / provider.** A data partner that contributes objects. `ddb
institutions` lists them (as a nested tree, since institutions can contain
sub-institutions); the `provider_fct` facet lets you filter a search by provider.

**Sector (Sparte).** The cultural sector an institution belongs to, coded
`sec_01`..`sec_07`: Archive, Library, Monument protection, Research, Media,
Museum, Other. Used by `ddb institutions --sector` and the `sector_fct` facet.

## Search

**Solr.** The search engine behind the DDB. `search` queries use **Solr / Lucene
query syntax**: bare keywords, `"quoted phrases"`, boolean `AND`/`OR`/`NOT`,
field-scoped terms (`label:Faust`), ranges, and `*` to match everything.

**Query (`query`).** The search term(s). Required; pass `'*'` to browse all
objects. Defaults matter: `ddb search` caps results at `--rows 10` (the API's own
default is 1000).

**Rows / offset.** `--rows` is the page size (0..1000); `--offset` is how many
leading results to skip. Together they page a result set.

**numberOfResults.** The total number of hits for a query, independent of how
many rows were actually returned — the field to read for "how many match?".

**Facet.** A field the search index can group and count by — e.g. object type,
place, provider, language, time. Facets power "drill-down" browsing: see which
values exist and how many objects each has, then narrow.

**`*_fct` fields.** The DDB's facet field names end in `_fct`. The common ones:

| Field | Facets by |
|---|---|
| `type_fct` | object type (Bild, Buch, …) |
| `place_fct` | place |
| `provider_fct` | contributing institution |
| `sector_fct` | cultural sector |
| `language_fct` | language |
| `keywords_fct` | subject keywords |
| `time_fct` / `time_begin_fct` / `time_end_fct` | time period |
| `state_fct` | German federal state |
| `mimetype_fct` | media MIME type |

Run `ddb facets` to list every facet, `ddb facets <name>` to list one facet's
values with counts.

**`--facet` vs. `--filter`.** `--facet type_fct` asks the API to *return counts*
for that facet alongside the results (so you can see what to narrow to).
`--filter type_fct=Bild` *restricts* the result set to objects with that facet
value. Repeating `--filter` for the same facet is an OR within that facet.

**sort.** `RELEVANCE` (default when a real query is given), `ALPHA_ASC` /
`ALPHA_DESC` (alphabetical), or `RANDOM` (optionally `RANDOM_<seed>` — reuse the
`randomSeed` from a previous response for a stable shuffle).

**correctedQuery.** A spelling-corrected version of your query the API returns
when the original looked mistyped.

## Item components (the AIP)

**AIP (Archive Information Package).** The bundle of all information the DDB holds
for one item. `ddb item <id> --part <component>` fetches a single component:

| Component (`--part`) | What it is |
|---|---|
| `view` *(default)* | the data set a DDB frontend object page is built from — the friendliest view |
| `aip` | the complete package (all components) |
| `edm` | the **Europeana Data Model** record — the standardised, interoperable metadata profile the DDB shares with [Europeana](https://www.europeana.eu) |
| `binaries` | the list of related binary files (thumbnails, media) with their URLs |
| `children` / `parents` | items one level down / up in a hierarchy (archival finding aids, multi-part works) |
| `indexing-profile` | the profile used to index the item |

> The `source` component (raw provider XML like METS/MODS, LIDO, MARCXML) and
> `binary` file downloads are **not** exposed by this CLI, which is JSON-only.

## Auth & rights

**API key / `oauth_consumer_key`.** The DDB protects the API with OAuth 1.0a, but
in practice a single **consumer key** suffices — no request signing. This client
sends it as the header `Authorization: OAuth oauth_consumer_key="<key>"`. Get a
free key from a **"Mein DDB"** account. `ddb version` is the one endpoint that
works without a key.

**CC0 1.0.** The Creative Commons "no rights reserved" public-domain dedication.
The DDB API returns **metadata exclusively under CC0** — freely reusable, no
attribution required.

**Rights statement / Lizenzkorb.** The DDB's "license basket": the fixed set of
rights notices an institution may attach to a **digital object's media** (image,
audio, video) — CC0, CC BY, CC BY-SA, Public Domain Mark, various *In Copyright*
/ *Rights Reserved* statements. Object media (not downloaded by this CLI) can
therefore be more restricted than the CC0 metadata — always check the individual
object's rights before reusing its media. See [DATA_LICENSE.md](DATA_LICENSE.md).

## CLI / technical

**Exit codes.** `0` success · `2` usage error (bad flag, wrong-length id) · `4`
not found · `6` network failure · `1` other API/runtime error (incl. `403`). See
[Usage.md](Usage.md#exit-codes).

**Cross-origin credential stripping.** If the API ever redirects to a different
host, the client removes the `Authorization` (and `Cookie`/`X-API-Key`) header
before following, so your key is never leaked to another origin.
