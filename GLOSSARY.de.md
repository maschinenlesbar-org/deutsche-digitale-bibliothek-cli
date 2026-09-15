# Glossar

Fach- und technische Begriffe, denen Sie bei der Arbeit mit `ddb` begegnen. Die Optionsreferenz
finden Sie in der **[README](README.md)**, das vollständige Kochbuch in **[Usage.md](Usage.md)**.

`ddb` nutzt die **v2**-API der DDB (`https://api.deutsche-digitale-bibliothek.de/2`).
Ihre Lese-Routen – Suche, Objekt, Version – sind **öffentlich: kein API-Schlüssel**.

## Die DDB und ihre Daten

**Deutsche Digitale Bibliothek (DDB).** Deutschlands nationaler Aggregator für digitalisiertes
Kultur- und Wissenschaftserbe. Sie verwahrt selbst keine Objekte, sondern sammelt Metadaten von
rund 500 Partnereinrichtungen (Archive, Bibliotheken, Museen, Forschungseinrichtungen) und bietet
eine gemeinsame Suche über alle an.

**Objekt / Item.** Ein einzelnes katalogisiertes Stück – ein Buch, ein Bild, eine Archivalie, ein
Notenblatt, ein Film, eine Tonaufnahme usw. Es wird über eine **32-stellige ID** identifiziert
(z. B. `TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK`); das ist der Wert von `id` in einem Suchtreffer und
das Argument für `ddb item`.

**Einrichtung / Provider.** Ein Datenpartner, der Objekte liefert. Diese CLI hat keinen eigenen
Befehl `institutions`; filtern oder aggregieren Sie stattdessen über die Facette
**`provider_fct`** (`--facet provider_fct` oder `--filter provider_fct:"…"`).

**Sparte.** Der Kulturbereich, zu dem die liefernde Einrichtung eines Objekts gehört, abgebildet
als Facette **`sector_fct`** mit den Codes `sec_01`..`sec_07`: Archiv, Bibliothek,
Denkmalpflege, Forschung, Mediathek, Museum, Sonstige.

## Suche

**v2 = Solr-Passthrough.** In v2 ist `ddb search` ein dünner Wrapper um den Apache-**Solr**-Index
der DDB (`GET /2/search/index/{collection}/{requestHandler}`, standardmäßig
`search`/`select`). Ihre Optionen werden auf native Solr-Abfrageparameter abgebildet, und die
Antwort ist **natives Solr-JSON**, keine von der DDB aufbereitete Antwortstruktur.

**Solr-/Lucene-Abfragesyntax.** `search`-Abfragen verwenden einfache Suchbegriffe, Phrasen in
Anführungszeichen (`"quoted phrases"`), die booleschen Operatoren `AND`/`OR`/`NOT`, feldbezogene
Terme (`title:Faust`), Bereiche und **`*:*`** als Treffer für alle Dokumente.

**`q` (die Abfrage).** Der oder die Suchbegriffe. Pflichtangabe; übergeben Sie `'*:*'`, um alle
Objekte zu durchstöbern. `ddb search` begrenzt die Treffer standardmäßig auf `--rows 10`.

**rows / start.** `--rows` ist die Seitengröße (Solr `rows`); `--offset` gibt an, wie viele
Dokumente am Anfang übersprungen werden (Solr `start`). Zusammen blättern sie durch eine
Ergebnismenge.

**Antwortstruktur.** Eine Solr-Antwort hat vier Teile, die für Sie relevant sind:

| Pfad | Bedeutung |
|---|---|
| `response.numFound` | Gesamtzahl der Treffer – lesen Sie diesen Wert für „wie viele passen?“ |
| `response.start` | Offset des ersten zurückgegebenen Dokuments (der `--offset`, zu dem Sie geblättert haben) |
| `response.docs[]` | die Dokumente dieser Seite (jedes mit einer `id` und weiteren Solr-Feldern) |
| `facet_counts.facet_fields.<field>` | Facettenwerte mit Anzahl, wenn `--facet` verwendet wurde |

**Dokumentfelder.** Jeder Eintrag in `docs[]` enthält die `id` des Items und viele Solr-Felder –
häufig `label` / `title` (Anzeigetext), `type` (Medientyp-Codes), `objecttype`, `place` /
`place_fct`, `provider` / `provider_fct`, `preview` (URL des Vorschaubilds), `license`. Die
Felder unterscheiden sich je nach Objekt; wählen Sie mit `jq` aus, was Sie brauchen.

**Facette.** Ein Feld, nach dem der Index gruppieren und zählen kann – Objekttyp, Ort,
Einrichtung, Sprache, Sparte, Zeit. `--facet <field>` weist Solr an, für dieses Feld *die Anzahl
je Wert zurückzugeben*, und zwar in `facet_counts.facet_fields.<field>` als **flaches Array**
`[value, count, value, count, …]`. Das Array kann Werte mit der Anzahl `0` enthalten, und die
Werte kommen so, wie die Einrichtungen sie erfasst haben (`place_fct` enthält `München` neben
`München, Oktoberfest`).

**`*_fct`-Felder.** Die Namen der Facettenfelder der DDB enden auf `_fct`. Die gebräuchlichsten:

| Feld | Facettiert nach | Wertform |
|---|---|---|
| `type_fct` | Medientyp | Codes wie `mediatype_002` (siehe unten) |
| `objecttype_fct` | Objekttyp | Wörter (Druckgraphik, …) |
| `place_fct` | Ort | Ortsnamen |
| `provider_fct` | liefernde Einrichtung | Namen der Einrichtungen |
| `sector_fct` | Sparte | `sec_01`..`sec_07` |
| `language_fct` | Sprache | Sprachcodes |
| `keywords_fct` | Schlagwörter | Wörter |
| `begin_time` / `end_time` | Zeitraum | Tagesnummern, keine Jahre: `660725` = 1. Januar 1810 (Python `date.toordinal()` + 1) |
| `mimetype_fct` | MIME-Typ der Medien | MIME-Typen |

Es gibt kein `time_fct` und keine Facette für Bundesländer: `time_fct` und `state_fct` sind
undefinierte Felder, ihre Verwendung scheitert mit HTTP 500 (Exit-Code 1).

Die `type_fct`-Codes, benannt nach dem Wert `item.media` der Objekte (Stichprobe vom
15.09.2026): `mediatype_001` Audio, `mediatype_002` Bild, `mediatype_003` Text,
`mediatype_005` Video, `mediatype_007` unbekannt (kein Digitalisat, nur Metadaten),
`mediatype_010` 3D.

**`--facet` vs. `--filter`.** `--facet type_fct` weist Solr an, für dieses Feld *Anzahlen
zurückzugeben* (damit Sie sehen, worauf Sie eingrenzen können). `--filter` nimmt eine rohe
Solr-**Filterabfrage (`fq`)** entgegen, die die Ergebnismenge *einschränkt*, z. B.
`--filter place_fct:"Berlin"` oder `--filter type_fct:mediatype_002`. Wiederholen Sie
`--filter`, um mehrere Bedingungen mit AND zu verknüpfen; ein OR formulieren Sie innerhalb
einer fq (`--filter 'place_fct:("Berlin" OR "Dessau")'`).

**sort.** Solr-Sortiersyntax: `<field> asc|desc`, z. B. `--sort "score desc"` (Relevanz, der
Standard, wenn nichts angegeben ist) oder `--sort "id asc"`. Weitere Kriterien für Gleichstände
trennen Sie mit Komma ab (`--sort "score desc, id asc"`).

**fields (`fl`).** `--fields id,label,type` beschränkt jedes zurückgegebene Dokument auf diese
Felder (Solr `fl`) – der sauberste Weg, ausführliche Dokumente zu bändigen.

## Objektbestandteile

**Objektbestandteile.** `ddb item <id> --part <component>` ruft einen Bestandteil eines Objekts
ab. Die meisten sind JSON; einige werden als XML oder als einfache Datei geliefert und **roh**
ausgegeben (damit sie bei `> file.xml` und in Pipes unverändert bleiben):

| Bestandteil (`--part`) | Bedeutung | Format |
|---|---|---|
| `view` *(Standard)* | der Datensatz, aus dem eine Objektseite im DDB-Frontend aufgebaut wird – die zugänglichste Ansicht | JSON |
| `aip` | das Archive Information Package (der vollständige Datensatz) | JSON |
| `edm` | der Datensatz im **Europeana Data Model** – dem standardisierten, interoperablen Profil, das die DDB mit [Europeana](https://www.europeana.eu) teilt | RDF/**XML** |
| `binaries` | zugehörige Binärdateien (Vorschaubilder, Medien) mit ihren URLs | JSON |
| `children` / `parents` | die direkten Kind-Objekte eine Ebene tiefer / die ganze Kette nach oben, beginnend mit dem Objekt selbst und endend mit seiner Einrichtung (Findmittel, mehrteilige Werke) | JSON |
| `source` | die Metadaten der Ingest-Quelle | JSON |
| `source-description` | eine Beschreibung des Quelldatensatzes | JSON |
| `source-record` | der rohe Datensatz der liefernden Einrichtung (METS/MODS, LIDO, MARCXML, …) | **XML** |
| `iiif` | das [IIIF](https://iiif.io)-Presentation-Manifest (nur wenn das Objekt eines hat) | JSON |
| `citation` | eine Zitier-/Zitatdatei für eine Zeitungsausgabe (nur wo zutreffend) | BIB-Datei |

> `--part children` akzeptiert zusätzlich `--rows` / `--offset`, um durch eine große Menge von
> Kind-Objekten zu blättern. `--lang <code>` legt die bevorzugte Sprache der Bezeichnungen für
> `view`/`aip`/`edm`/`binaries`/`source`/`source-description` fest; hat ein Objekt keinen
> Datensatz in dieser Sprache, antwortet die API mit `404` (beobachtet bei `--lang en`).

## Authentifizierung & Rechte

**Kein API-Schlüssel.** Die Lese-Routen, die diese CLI nutzt, sind öffentlich – Suche, Objekt
und Version funktionieren anonym. Ein `403` ist daher ungewöhnlich und bedeutet, dass
`--base-url` auf einen authentifizierten Endpoint zeigt oder der konkrete Objektbestandteil
zugriffsbeschränkt ist – **nicht**, dass Sie einen Schlüssel brauchen.

**CC0 1.0.** Die Creative-Commons-Widmung „keine Rechte vorbehalten“, mit der Werke in die
Gemeinfreiheit entlassen werden. Die DDB-API liefert **Metadaten ausschließlich unter CC0** –
frei nachnutzbar, ohne Pflicht zur Namensnennung.

**Rechtehinweis / Lizenzkorb.** Der „Lizenzkorb“ der DDB: die feste Auswahl an Rechtehinweisen,
die eine Einrichtung den **Medien eines digitalen Objekts** (Bild, Audio, Video) zuordnen kann –
CC0, CC BY, CC BY-SA, Public Domain Mark, verschiedene Hinweise wie *In Copyright* /
*Rights Reserved*. Die Medien eines Objekts (die diese CLI nicht herunterlädt) können daher
strenger lizenziert sein als die CC0-Metadaten – prüfen Sie immer die Rechte des einzelnen
Objekts, bevor Sie seine Medien nachnutzen: In `view` steht die Lizenz-URI der Medien in
`item.license.resource` (`item.rights` ist oft leer), in `binaries` im Feld `kind` jeder Datei.
Siehe [DATA_LICENSE.md](DATA_LICENSE.md).

## CLI / Technik

**Exit-Codes.** `0` Erfolg · `2` Aufruffehler (ungültiges Flag, ID mit falscher Länge) · `4`
nicht gefunden · `6` Netzwerkfehler · `1` sonstiger API- oder Laufzeitfehler. Siehe
[Usage.md](Usage.md#exit-codes).

**Entfernen von Zugangsdaten beim Wechsel des Origins.** Die Lese-Routen senden keine
Zugangsdaten. Falls Sie aber über einen Header welche mitgeben und die API jemals auf einen
anderen Host umleitet, entfernt der Client vor dem Folgen jeden `Authorization`- / `Cookie`- /
`X-API-Key`-Header, sodass er nie an einen anderen Origin gelangt.
