# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `ddb`, eines pro Skill: eine
Anfrage, die `ddb`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `ddb` 0.0.4 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [ddb-item](#ddb-item) · [ddb-search](#ddb-search)

## ddb-item

> Was ist das DDB-Objekt YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ, welche Bilddateien gehören dazu, gibt es ein IIIF-Manifest? Und bitte den Europeana-Datensatz speichern.

```bash
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part binaries
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part iiif        # Exit 4: Objekt hat kein Manifest
ddb item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part edm -o oktoberfest-1810.edm.xml
ddb --compact item YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ --part parents
```

Ein 404 bei `iiif` bedeutet, dass das Objekt kein Manifest hat – die ID selbst ist gültig. In der
Ansicht ist das Feld `rights` leer, die Medienlizenz steht unter `item.license.resource`. Der Aufruf
`parents` lieferte nur den Datensatz des Museums selbst, der Druck gehört also zu keiner Archivhierarchie.

```
Oktoberfest 1810   (DDB YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ · DHM-Inventarnr. Gr 90/722)
  Alt. Titel:    DAS OCTOBERFEST. 1810.
  Objekt:        Druck · Druckgraphik (Gattung) · Druckfarbe; Papier; Radierung
  Maße:          25,1 x 37 cm (Blatt) · 16,9 x 25,8 cm (Darstellung)
  Entstanden:    1810, Deutschland · Zeichner: Peter von Hess · Stecher: ? Weller
  Themen:        Fest · Oktoberfest (München) · Landwirtschaft
  Bestand:       Stiftung Deutsches Historisches Museum, Berlin
  Quellseite:    https://db.dhm.de/objekt/GR105655
  Hierarchie:    keine; einziger Elterneintrag ist die Institution (FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463)
  Metadaten:     CC0 1.0 (geliefert als LIDO)
  Medienrechte:  CC BY-NC-ND 4.0 – keine kommerzielle Nutzung, keine Bearbeitung, Namensnennung
                 („Urheber*in: Hess, Peter von; Weller, ? (Herstellung) / Rechtewahrnehmung:
                  Deutsches Historisches Museum")

Binärdateien: 1
  image/jpeg · primär · „Oktoberfest 1810"
  https://objekt.db.dhm.de/GR105655/download/large_without_watermark
IIIF:     keins (404; auch die Viewer-Liste der Ansicht ist leer)
EDM:      oktoberfest-1810.edm.xml geschrieben, 11.575 Byte RDF/XML
          (edm:type IMAGE, edm:isShownBy = das JPEG oben, edm:rights CC BY-NC-ND 4.0)
```

Als Nächstes angeboten: der rohe LIDO-Datensatz des Lieferanten (`--part source-record`) oder weitere
Oktoberfest-Bilder des DHM über ddb-search.

## ddb-search

> Das Oktoberfest steht kurz bevor. Wie viel ist dazu in der Deutschen Digitalen Bibliothek digitalisiert, und welche Einrichtungen und Orte haben am meisten?

```bash
ddb --compact search Oktoberfest --rows 0 --facet provider_fct --facet place_fct --facet type_fct --facet sector_fct --facet-limit 10
ddb --compact search Oktoberfest --rows 0 --facet objecttype_fct --facet-limit 10
for t in 007 002 003 005; do ddb --compact search Oktoberfest --filter type_fct:mediatype_$t --rows 2 --fields id,label,digitalisat,mimetype_fct,objecttype --facet mimetype_fct --facet-limit 4; done   # was jeder Code enthält
ddb --compact search Oktoberfest --filter type_fct:mediatype_002 --rows 0 --facet provider_fct --facet-limit 5
ddb --compact search Oktoberfest --filter type_fct:mediatype_002 --filter 'provider_fct:"Stiftung Deutsches Historisches Museum"' --rows 8 --fields id,label,objecttype,license,begin_time
```

Der Skill hat keine Legende für die `mediatype_*`-Codes, deshalb hat er jeden Code stichprobenartig
abgefragt. Dokumente unter `007` haben keine digitalisierten Medien, `002` sind Fotografien, `003`
Textabschnitte und `005` Filmtrailer. Die Sparten-Namen stammen aus dem Glossar des Repos. Facetten
liefern auch Werte mit Anzahl 0 (`mediatype_001`, `sec_03`), diese wurden weggelassen. Die Ortsfacette
enthält mehrere Schreibweisen von München; sie stehen getrennt, weil ein Objekt mehrere tragen kann.

```
„Oktoberfest" in der DDB: 1.614 Objekte

Medien:   ohne Digitalisat 1.029 · Bilder 477 · Text 105 · Video 2
Sparten:  Archive 967 · Museen 347 · Bibliotheken 226 · Mediatheken 52 · Forschung 22

Top-Einrichtungen                                                      gesamt   Bilder
  Stiftung Deutsches Historisches Museum                                  286      257
  Staatsarchiv München                                                    261
  Archive in NRW                                                          160
  Münchner Stadtbibliothek / Monacensia im Hildebrandhaus - Literaturarchiv 128
  Deutsche Nationalbibliothek                                             123
  Landesarchiv Berlin                                                      97
  Landesarchiv Baden-Württemberg                                           73       44
  … 3 weitere in den Top 10; weitere Bildbestände: DFF - Deutsches Filminstitut & Filmmuseum e.V. 33,
    filmportal.de 33, Stiftung Stadtmuseum Berlin 22

Orte:     München 420 (dazu „München, Oktoberfest" 27, „München M; Oktoberfest" 9, „München M" 7)
          · Berlin 328 · Frankfurt am Main 134 · Heidelberg 19 · Bayern 16 · Dresden 8
Typen:    Archivale 332 · Akten 308 · Fotografie 196 · Negativ (Fotografie) 69 · Bild 62 · Text 46
          · Standfotografie 30 · Plakat 28 · Zeitungsausschnitt 26 · Akte 25

DHM-Bilder: 257; erste Seite (alle CC BY-NC-ND 4.0):
  YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ  Oktoberfest 1810
  4L65B6SDQPBJXGCVRFMSNZAVWCFXZBCK  München, Oktoberfest          Fotografie
  ACOXBGXRZTVKSZZVTY7IYCUYQOT7KWKO  Münchener Oktoberfest         Fotografie
  MLPAM6ODR2NJ4LFBWUB6BKLQALKW4RO5  Münchener Oktoberfest         Stereofotografie
  … 253 weitere (weiterblättern mit --offset 8)
Metadaten sind CC0; die Medienrechte legt jedes Objekt selbst fest.
```

Als Nächstes angeboten: eines dieser Objekte mit ddb-item öffnen oder auf ein Archiv eingrenzen
(`--filter 'provider_fct:"Staatsarchiv München"'`).
