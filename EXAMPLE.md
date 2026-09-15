# Examples

Real examples for the Claude Code skills of the `ddb` plugin, one per skill: a request,
the `ddb` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `ddb` 0.0.4.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [ddb-item](#ddb-item) · [ddb-search](#ddb-search)

## ddb-item

> Show me DDB object YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ: what is it, which image files belong to it, is there an IIIF manifest? And save the Europeana record.

```bash
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part binaries
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part iiif        # exit 4: object has no manifest
ddb item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part edm -o oktoberfest-1810.edm.xml
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part parents
```

A 404 on `iiif` means the object has no manifest; the id itself is valid. In the view, the `rights`
field is empty and the media licence sits under `item.license.resource`. The `parents` call returned
only the museum's own record, so the print isn't part of an archival hierarchy.

```
Oktoberfest 1810   (DDB YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ · DHM inventory no. Gr 90/722)
  Alt. title:   DAS OCTOBERFEST. 1810.
  Object:       Druck · Druckgraphik (Gattung) · Druckfarbe; Papier; Radierung
  Size:         25,1 x 37 cm (Blatt) · 16,9 x 25,8 cm (Darstellung)
  Made:         1810, Deutschland · Zeichner: Peter von Hess · Stecher: ? Weller
  Subjects:     Fest · Oktoberfest (München) · Landwirtschaft
  Held by:      Stiftung Deutsches Historisches Museum, Berlin
  Source page:  https://db.dhm.de/objekt/GR105655
  Hierarchy:    none; the only parent is the institution (FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463)
  Metadata:     CC0 1.0 (delivered as LIDO)
  Media rights: CC BY-NC-ND 4.0: no commercial use, no derivatives, credit required
                ("Urheber*in: Hess, Peter von; Weller, ? (Herstellung) / Rechtewahrnehmung:
                 Deutsches Historisches Museum")

Binaries: 1
  image/jpeg · primary · "Oktoberfest 1810"
  https://objekt.db.dhm.de/GR105655/download/large_without_watermark
IIIF:     none (404; the view's viewer list is empty too)
EDM:      wrote oktoberfest-1810.edm.xml, 11 575 bytes of RDF/XML
          (edm:type IMAGE, edm:isShownBy = the JPEG above, edm:rights CC BY-NC-ND 4.0)
```

Next steps offered: the raw LIDO provider record (`--part source-record`), or more DHM Oktoberfest images through ddb-search.

## ddb-search

> The Oktoberfest is about to start. How much about it is digitised in the Deutsche Digitale Bibliothek, and which institutions and places hold the most?

```bash
ddb --compact search Oktoberfest --rows 0 --facet provider_fct --facet place_fct --facet type_fct --facet sector_fct --facet-limit 10
ddb --compact search Oktoberfest --rows 0 --facet objecttype_fct --facet-limit 10
for t in 007 002 003 005; do ddb --compact search Oktoberfest --filter type_fct:mediatype_$t --rows 2 --fields id,label,digitalisat,mimetype_fct,objecttype --facet mimetype_fct --facet-limit 4; done   # what each code holds
ddb --compact search Oktoberfest --filter type_fct:mediatype_002 --rows 0 --facet provider_fct --facet-limit 5
ddb --compact search Oktoberfest --filter type_fct:mediatype_002 --filter 'provider_fct:"Stiftung Deutsches Historisches Museum"' --rows 8 --fields id,label,objecttype,license,begin_time
```

The skill has no legend for the `mediatype_*` codes, so it sampled each one. Documents under `007`
have no digitised media, `002` are photographs, `003` are text sections and `005` are film trailers.
Sector names come from the repo glossary. Facets also return zero-count values (`mediatype_001`,
`sec_03`), which were dropped. The place facet has several spellings of München, listed separately
because one object can carry more than one of them.

```
"Oktoberfest" in the DDB: 1 614 objects

Media:    no digitised media 1 029 · images 477 · text 105 · video 2
Sectors:  archives 967 · museums 347 · libraries 226 · media 52 · research 22

Top institutions                                                          all   images
  Stiftung Deutsches Historisches Museum                                  286      257
  Staatsarchiv München                                                    261
  Archive in NRW                                                          160
  Münchner Stadtbibliothek / Monacensia im Hildebrandhaus - Literaturarchiv 128
  Deutsche Nationalbibliothek                                             123
  Landesarchiv Berlin                                                      97
  Landesarchiv Baden-Württemberg                                           73       44
  … 3 more in the top 10; other image holders: DFF - Deutsches Filminstitut & Filmmuseum e.V. 33,
    filmportal.de 33, Stiftung Stadtmuseum Berlin 22

Places:   München 420 (also "München, Oktoberfest" 27, "München M; Oktoberfest" 9, "München M" 7)
          · Berlin 328 · Frankfurt am Main 134 · Heidelberg 19 · Bayern 16 · Dresden 8
Types:    Archivale 332 · Akten 308 · Fotografie 196 · Negativ (Fotografie) 69 · Bild 62 · Text 46
          · Standfotografie 30 · Plakat 28 · Zeitungsausschnitt 26 · Akte 25

DHM images: 257; first page (all CC BY-NC-ND 4.0):
  YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ  Oktoberfest 1810
  4L65B6SDQPBJXGCVRFMSNZAVWCFXZBCK  München, Oktoberfest          Fotografie
  ACOXBGXRZTVKSZZVTY7IYCUYQOT7KWKO  Münchener Oktoberfest         Fotografie
  MLPAM6ODR2NJ4LFBWUB6BKLQALKW4RO5  Münchener Oktoberfest         Stereofotografie
  … 253 more (page with --offset 8)
Metadata is CC0; media rights are set per object.
```

Next steps offered: open one of these objects with ddb-item, or narrow to one archive (`--filter 'provider_fct:"Staatsarchiv München"'`).
