# Glossary

Domain and technical terms you meet when using `ddb`. For the option reference
see the **[README](README.md)** and the full cookbook in **[Usage.md](Usage.md)**.

`ddb` targets the DDB **v2** API (`https://api.deutsche-digitale-bibliothek.de/2`).
Its read routes — search, item, version — are **public: no API key**.

## The DDB and its data

**Deutsche Digitale Bibliothek (DDB).** Germany's national aggregator for
digitised cultural and scientific heritage. It does not hold objects itself; it
harvests metadata from ~500 partner institutions (archives, libraries, museums,
research bodies) and offers one shared search across them.

**Object / item.** A single catalogued thing — a book, image, archival record,
piece of sheet music, film, audio recording, etc. Identified by a **32-character
id** (e.g. `TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK`), the value in a search result's
`id` and the argument to `ddb item`.

**Institution / provider.** A data partner that contributes objects. There is no
dedicated `institutions` command in this CLI; filter or aggregate by provider
through the **`provider_fct`** facet instead (`--facet provider_fct`, or
`--filter provider_fct:"…"`).

**Sector (Sparte).** The cultural sector an object's provider belongs to, exposed
as the **`sector_fct`** facet with codes `sec_01`..`sec_07`: Archive, Library,
Monument protection, Research, Media, Museum, Other.

## Search

**v2 = Solr passthrough.** In v2, `ddb search` is a thin wrapper over the DDB's
Apache **Solr** index (`GET /2/search/index/{collection}/{requestHandler}`, by
default `search`/`select`). Your options map onto native Solr query parameters and
the response is **native Solr JSON**, not a DDB-curated envelope.

**Solr / Lucene query syntax.** `search` queries use bare keywords, `"quoted
phrases"`, boolean `AND`/`OR`/`NOT`, field-scoped terms (`title:Faust`), ranges,
and **`*:*`** to match every document.

**`q` (the query).** The search term(s). Required; pass `'*:*'` to browse all
objects. `ddb search` caps results at `--rows 10` by default.

**rows / start.** `--rows` is the page size (Solr `rows`); `--offset` is how many
leading documents to skip (Solr `start`). Together they page a result set.

**Response shape.** A Solr response has four parts you care about:

| Path | What it is |
|---|---|
| `response.numFound` | total hits for the query — read this for "how many match?" |
| `response.start` | offset of the first returned doc (the `--offset` you paged to) |
| `response.docs[]` | this page of documents (each has an `id`, plus Solr fields) |
| `facet_counts.facet_fields.<field>` | facet values + counts, when `--facet` was used |

**Document fields.** Each `docs[]` entry carries the item `id` plus many Solr
fields — commonly `label` / `title` (display text), `type` (media-type codes),
`objecttype`, `place` / `place_fct`, `provider` / `provider_fct`, `preview`
(thumbnail URL), `license`. Fields vary by object; project what you need with `jq`.

**Facet.** A field the index can group and count by — object type, place,
provider, language, sector, time. `--facet <field>` asks Solr to *return value
counts* for that field, in `facet_counts.facet_fields.<field>` as a **flat array**
`[value, count, value, count, …]`. The array can include values with count `0`, and
values are delivered as the institutions wrote them (`place_fct` has `München` next to
`München, Oktoberfest`).

**`*_fct` fields.** The DDB's facet field names end in `_fct`. The common ones:

| Field | Facets by | Value form |
|---|---|---|
| `type_fct` | media type | codes like `mediatype_002` (see below) |
| `objecttype_fct` | object type | words (Druckgraphik, …) |
| `place_fct` | place | place names |
| `provider_fct` | contributing institution | provider names |
| `sector_fct` | cultural sector | `sec_01`..`sec_07` |
| `language_fct` | language | language codes |
| `keywords_fct` | subject keywords | words |
| `begin_time` / `end_time` | time period | day numbers, not years: `660725` = 1 Jan 1810 (Python `date.toordinal()` + 1) |
| `mimetype_fct` | media MIME type | MIME types |

There is no `time_fct` and no federal-state facet: `time_fct` and `state_fct` are
undefined fields, and using one fails with HTTP 500 (exit 1).

The `type_fct` codes, as labelled by the objects' `item.media` value (sampled
2026-09-15): `mediatype_001` audio, `mediatype_002` image, `mediatype_003` text,
`mediatype_005` video, `mediatype_007` unknown (no digitised media, metadata only),
`mediatype_010` 3D.

**`--facet` vs. `--filter`.** `--facet type_fct` asks Solr to *return counts* for
that field (so you can see what to narrow to). `--filter` takes a raw Solr
**filter query (`fq`)** that *restricts* the result set, e.g.
`--filter place_fct:"Berlin"` or `--filter type_fct:mediatype_002`. Repeat
`--filter` to AND several constraints; express OR inside one fq
(`--filter 'place_fct:("Berlin" OR "Dessau")'`).

**sort.** Solr sort syntax: `<field> asc|desc`, e.g. `--sort "score desc"`
(relevance, the default when omitted) or `--sort "id asc"`. Comma-separate for
tie-breakers (`--sort "score desc, id asc"`).

**fields (`fl`).** `--fields id,label,type` restricts each returned document to
those fields (Solr `fl`) — the cleanest way to tame verbose docs.

## Item components

**Item components.** `ddb item <id> --part <component>` fetches one component of an
object. Most are JSON; a few are served as XML or a plain file and are printed
**raw** (so `> file.xml` and piping keep them intact):

| Component (`--part`) | What it is | Format |
|---|---|---|
| `view` *(default)* | the data set a DDB frontend object page is built from — the friendliest view | JSON |
| `aip` | the Archive Information Package (the full record) | JSON |
| `edm` | the **Europeana Data Model** record — the standardised, interoperable profile the DDB shares with [Europeana](https://www.europeana.eu) | RDF/**XML** |
| `binaries` | related binary files (thumbnails, media) with their URLs | JSON |
| `children` / `parents` | the direct children one level down / the whole chain up, starting with the object itself and ending with its institution (finding aids, multi-part works) | JSON |
| `source` | the ingest source metadata | JSON |
| `source-description` | a description of the source record | JSON |
| `source-record` | the raw provider record (METS/MODS, LIDO, MARCXML, …) | **XML** |
| `iiif` | the [IIIF](https://iiif.io) Presentation manifest (only where the object has one) | JSON |
| `citation` | a citation/quote file for a newspaper issue (only where applicable) | BIB file |

> `--part children` also accepts `--rows` / `--offset` for paging a large child
> set. `--lang <code>` sets the preferred label language for
> `view`/`aip`/`edm`/`binaries`/`source`/`source-description`; an object without a
> record in that language answers `404` (seen for `--lang en`).

## Auth & rights

**No API key.** The read routes this CLI uses are public — search, item and
version all work anonymously. A `403` is therefore unusual and means `--base-url`
was pointed at an authenticated endpoint, or the specific item component is
access-restricted — **not** "you need a key".

**CC0 1.0.** The Creative Commons "no rights reserved" public-domain dedication.
The DDB API returns **metadata exclusively under CC0** — freely reusable, no
attribution required.

**Rights statement / Lizenzkorb.** The DDB's "license basket": the fixed set of
rights notices an institution may attach to a **digital object's media** (image,
audio, video) — CC0, CC BY, CC BY-SA, Public Domain Mark, various *In Copyright*
/ *Rights Reserved* statements. Object media (not downloaded by this CLI) can
therefore be more restricted than the CC0 metadata — always check the individual
object's rights before reusing its media: in `view` the media licence URI is
`item.license.resource` (`item.rights` is often empty), in `binaries` it is each
file's `kind`. See [DATA_LICENSE.md](DATA_LICENSE.md).

## CLI / technical

**Exit codes.** `0` success · `2` usage error (bad flag, wrong-length id) · `4`
not found · `6` network failure · `1` other API/runtime error. See
[Usage.md](Usage.md#exit-codes).

**Cross-origin credential stripping.** The read routes send no credentials, but if
you inject one via a header and the API ever redirects to a different host, the
client removes any `Authorization` / `Cookie` / `X-API-Key` header before
following, so it is never leaked to another origin.
