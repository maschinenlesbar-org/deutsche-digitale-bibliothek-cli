// Recorded answers of the DDB v2 API (2026-11-19, ~23:43 CET), cut to the fields the use cases
// read, and a mock of the API over its own paths that answers from them: the use cases' tests
// (operations.test.ts) and the MCP server's tests run on it. Live: a search for Oktoberfest (its
// first three objects with the fields a hit shows, and the facet counts of media type, sector,
// place and provider), two Staatsarchiv München records, the view, media and parents of the 1810
// print YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ (its EDM in full), the parents of an archival record
// (seven levels), the empty parents of a book section, three of the 100 children of a series, and
// the 404s of a view in English and of a missing IIIF manifest. The source-record redirect of a
// book section (303 to its volume, without the /2 prefix) is the client test's, with a stand-in
// record.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { jsonResponse, makeMockTransport, rawResponse, type MockTransport } from "./helpers.js";

/** The 1810 print of the Oktoberfest (Deutsches Historisches Museum): view, media, parents, EDM. */
export const PRINT = "YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ";
/** An archival record of the Staatsarchiv München ("Oktoberfest 1893"), seven levels deep. */
export const RECORD = "5UPF53VT2D55EKJWAGOPV5AY5XO75RMO";
/** A series of that archive ("Oktoberfest in München") with 100 children. */
export const SERIES = "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF";
/** An illustration in a book of the Staatsbibliothek zu Berlin, which belongs to the Stiftung Preußischer Kulturbesitz. */
export const ILLUSTRATION = "5556S6VXBQ7766TPFLK3IDEOG4SX4MGH";
/** A section of a digitised book: no parents listed, its source-record is its volume's. */
export const SECTION = "JG3YAM7VLFJPVGMAWK4IBCJVFHNFZ5NP";
export const VOLUME = "JY7HJBJAUBYMG437RSIFJNUPMMSAHT26";

/** search q=Oktoberfest rows=3 (the hit fields). */
export const SEARCH_OKTOBERFEST = {
  "response": {
    "numFound": 1617,
    "start": 0,
    "numFoundExact": true,
    "docs": [
      {
        "id": "KE43D2INXYOPHOEEME6T3BEJIMIKTPLU",
        "label": [
          "Oktoberfest"
        ],
        "title": [
          "Oktoberfest"
        ],
        "type_fct": [
          "mediatype_003"
        ],
        "objecttype": [
          "Abschnitt (Publikation)",
          "Fotografie"
        ],
        "provider": [
          "Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden"
        ],
        "begin_time": [
          714416
        ],
        "end_time": [
          714780
        ],
        "license": [
          "http://rightsstatements.org/vocab/InC/1.0/"
        ]
      },
      {
        "id": "LIVC7P2HG574DHYOII7AK5XA2BYUQJDC",
        "label": [
          "Oktoberfest"
        ],
        "title": [
          "Oktoberfest"
        ],
        "type_fct": [
          "mediatype_003"
        ],
        "objecttype": [
          "Abschnitt (Publikation)",
          "Fotografie"
        ],
        "provider": [
          "Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden"
        ],
        "begin_time": [
          714416
        ],
        "end_time": [
          714780
        ],
        "license": [
          "http://rightsstatements.org/vocab/InC/1.0/"
        ]
      },
      {
        "id": "UXFGNVRVBIA7VQRPYHLK4FUPCYVT2M4J",
        "label": [
          "Oktoberfest"
        ],
        "title": [
          "Oktoberfest"
        ],
        "type_fct": [
          "mediatype_003"
        ],
        "objecttype": [
          "Abschnitt (Publikation)",
          "Fotografie"
        ],
        "provider": [
          "Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden"
        ],
        "begin_time": [
          714416
        ],
        "end_time": [
          714780
        ],
        "license": [
          "http://rightsstatements.org/vocab/InC/1.0/"
        ]
      }
    ]
  }
};

/** search q=Oktoberfest fq=provider_fct:"Staatsarchiv München" rows=2. */
export const SEARCH_STAATSARCHIV = {
  "response": {
    "numFound": 261,
    "start": 0,
    "numFoundExact": true,
    "docs": [
      {
        "id": "5UPF53VT2D55EKJWAGOPV5AY5XO75RMO",
        "label": [
          "Oktoberfest 1893"
        ],
        "type_fct": [
          "mediatype_007"
        ],
        "objecttype": [
          "Akten"
        ],
        "provider": [
          "Staatsarchiv München"
        ],
        "place_fct": [
          "München, Oktoberfest, Trabrennen",
          "München, Trabrennen, Oktoberfest"
        ],
        "begin_time": [
          691041
        ],
        "end_time": [
          691405
        ]
      },
      {
        "id": "43HYN7XRB2I7MAGHMWQ2ABQY4GNF2X57",
        "label": [
          "Bekanntmachung. Oktoberfest 1900"
        ],
        "type_fct": [
          "mediatype_007"
        ],
        "objecttype": [
          "Akten"
        ],
        "provider": [
          "Staatsarchiv München"
        ],
        "place_fct": [
          "München, Dillmann, Kgl. Polizeidirektion",
          "München, Kgl. Polizeidirektion",
          "München, Oktoberfest, Oktoberfestschießen, Bekanntmachung",
          "München, Oktoberfestschießen, Oktoberfest"
        ],
        "begin_time": [
          693232
        ],
        "end_time": [
          693961
        ]
      }
    ]
  }
};

/** search q=Oktoberfest rows=0, facets type_fct, sector_fct, place_fct, provider_fct, facet.limit=10. */
export const FACETS_OKTOBERFEST = {
  "response": {
    "numFound": 1617,
    "start": 0,
    "maxScore": 25.583057,
    "numFoundExact": true,
    "docs": []
  },
  "facet_counts": {
    "facet_fields": {
      "type_fct": [
        "mediatype_007",
        1036,
        "mediatype_002",
        477,
        "mediatype_003",
        100,
        "mediatype_005",
        2,
        "mediatype_001",
        1,
        "mediatype_010",
        0
      ],
      "sector_fct": [
        "sec_01",
        975,
        "sec_06",
        347,
        "sec_02",
        221,
        "sec_05",
        52,
        "sec_04",
        22,
        "sec_03",
        0,
        "sec_07",
        0
      ],
      "place_fct": [
        "München",
        421,
        "Berlin",
        329,
        "Frankfurt am Main",
        134,
        "München, Oktoberfest",
        27,
        "Heidelberg",
        19,
        "Bayern",
        16,
        "München M; Oktoberfest",
        9,
        "Dresden",
        8,
        "München M",
        7,
        "München, Königliche Polizeidirektion",
        7
      ],
      "provider_fct": [
        "Stiftung Deutsches Historisches Museum",
        286,
        "Staatsarchiv München",
        261,
        "Archive in NRW",
        160,
        "Münchner Stadtbibliothek / Monacensia im Hildebrandhaus - Literaturarchiv",
        128,
        "Deutsche Nationalbibliothek",
        123,
        "Landesarchiv Berlin",
        97,
        "Landesarchiv Baden-Württemberg",
        73,
        "Bayerische Staatsbibliothek",
        62,
        "Bayerisches Hauptstaatsarchiv",
        60,
        "Stadtarchiv München",
        48
      ]
    }
  }
};

/** items/PRINT/view (the index fields cut to one). */
export const VIEW_PRINT = {
  "item": {
    "identifier": "DE-MUS-319517/GR105655",
    "label": "Oktoberfest 1810",
    "title": "Oktoberfest 1810",
    "subtitle": "Druck",
    "rights": "",
    "metdata-rights": "http://creativecommons.org/publicdomain/zero/1.0/",
    "origin": "https://db.dhm.de/objekt/GR105655",
    "category": "Kultur",
    "media": "image",
    "thumbnail": "",
    "license": {
      "resource": "http://creativecommons.org/licenses/by-nc-nd/4.0/"
    },
    "institution": {
      "id": "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463",
      "url": "http://www.dhm.de",
      "name": "Stiftung Deutsches Historisches Museum",
      "logo-institution-ddbid": "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463"
    },
    "viewers": {
      "viewer": []
    },
    "fields": [
      {
        "usage": "display",
        "field": [
          {
            "id": "flex_mus_neu_015",
            "name": "AlternativTitel",
            "value": [
              {
                "content": "DAS OCTOBERFEST. 1810.",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_020",
            "name": "Objekt Bezeichnung",
            "value": [
              {
                "content": "Druck",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_060",
            "name": "Material/Technik",
            "value": [
              {
                "content": "Druckfarbe; Papier; Radierung",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_070",
            "name": "Maße",
            "value": [
              {
                "content": "Höhe x Breite: 25,1 x 37 cm (Blatt)",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              },
              {
                "content": "Höhe x Breite: 16,9 x 25,8 cm (Darstellung)",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_100",
            "name": "Ereignis",
            "value": [
              {
                "content": "Herstellung",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_110",
            "name": "(wer)",
            "value": [
              {
                "content": "Zeichner: Peter von Hess",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              },
              {
                "content": "Stecher: ? Weller",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_120",
            "name": "(wo)",
            "value": [
              {
                "content": "Deutschland",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_130",
            "name": "(wann)",
            "value": [
              {
                "content": "1810",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_210",
            "name": "Bezug (was)",
            "value": [
              {
                "content": "Fest",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              },
              {
                "content": "Oktoberfest (München)",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              },
              {
                "content": "Landwirtschaft",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_340",
            "name": "Klassifikation",
            "value": [
              {
                "content": "Druckgraphik (Gattung)",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_400",
            "name": "Standort",
            "value": [
              {
                "content": "Deutsches Historisches Museum, Berlin, Berlin, Deutschland",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          },
          {
            "id": "flex_mus_neu_410",
            "name": "Inventarnummer",
            "value": [
              {
                "content": "Gr 90/722",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          }
        ]
      },
      {
        "usage": "index",
        "field": [
          {
            "id": "title",
            "name": "Title",
            "value": [
              {
                "content": "Oktoberfest 1810",
                "resource": null,
                "rightsinfo": null,
                "rightsholder": null,
                "creditline": null
              }
            ],
            "georeference": null
          }
        ]
      }
    ]
  }
};

/** items/PRINT/binaries. */
export const BINARIES_PRINT = {
  "binary": [
    {
      "ref": "6133e060-12d2-4326-a80f-7b045ce3057d",
      "name": "Oktoberfest 1810",
      "name2": "Urheber*in: Hess, Peter von; Weller, ? (Herstellung) / Rechtewahrnehmung: Deutsches Historisches Museum",
      "name3": null,
      "kind": "http://creativecommons.org/licenses/by-nc-nd/4.0/",
      "mimetype": "image/jpeg",
      "position": 1,
      "primary": true,
      "local_pathname": "https://objekt.db.dhm.de/GR105655/download/large_without_watermark",
      "license_group": "rights_002"
    }
  ]
};

/** items/PRINT/parents: the object itself, then the institution. */
export const PARENTS_PRINT = {
  "numberOfResults": 2,
  "hierarchy": [
    {
      "aggregationEntity": false,
      "id": "YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ",
      "parent": "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463",
      "ingestId": "10351542388340548lkaH",
      "providerId": [
        "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463",
        "oid1444921227476"
      ],
      "label": "Oktoberfest 1810",
      "type": null,
      "position": "-1",
      "leaf": true
    },
    {
      "aggregationEntity": false,
      "id": "FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463",
      "parent": null,
      "ingestId": "5095594020963603yfKs",
      "providerId": [
        "00008615",
        "IPSQKSWH46RX2B475NRZARHV4SFHLQGZ"
      ],
      "label": "Stiftung Deutsches Historisches Museum",
      "type": "institution",
      "position": "-1",
      "leaf": false
    }
  ]
};

/** items/RECORD/parents: the record, four levels of the archive, its Archivtektonik, the archive. */
export const PARENTS_RECORD = {
  "numberOfResults": 7,
  "hierarchy": [
    {
      "aggregationEntity": false,
      "id": "5UPF53VT2D55EKJWAGOPV5AY5XO75RMO",
      "parent": "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Oktoberfest 1893",
      "type": "htype_034",
      "position": "01192",
      "leaf": true
    },
    {
      "aggregationEntity": true,
      "id": "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF",
      "parent": "O264RSC5WCULSXEB5S4WUKOF6EN2ECC2",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Oktoberfest in München",
      "type": "htype_031",
      "position": "01169",
      "leaf": false
    },
    {
      "aggregationEntity": true,
      "id": "O264RSC5WCULSXEB5S4WUKOF6EN2ECC2",
      "parent": "R4KTTQLYLWOS7MR5VNQZT2QH4W52BFY2",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Veranstaltungsplakate",
      "type": "htype_031",
      "position": "01168",
      "leaf": false
    },
    {
      "aggregationEntity": false,
      "id": "R4KTTQLYLWOS7MR5VNQZT2QH4W52BFY2",
      "parent": "67E6H7O5L3UBTVI5KM2XHIJQELWP2UWX",
      "ingestId": "1caf864b780367332170aa5a9da4a72bb94afa69",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Plakatsammlung",
      "type": "htype_030",
      "position": "00560",
      "leaf": false
    },
    {
      "aggregationEntity": true,
      "id": "67E6H7O5L3UBTVI5KM2XHIJQELWP2UWX",
      "parent": "VWCCJTRHUNO3Q3ZKTMHOBD5RW22SJXI6",
      "ingestId": "1caf864b780367332170aa5a9da4a72bb94afa69",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "V. Sammlungsgut / Dokumentationen",
      "type": "htype_037",
      "position": "00553",
      "leaf": false
    },
    {
      "aggregationEntity": true,
      "id": "VWCCJTRHUNO3Q3ZKTMHOBD5RW22SJXI6",
      "parent": "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC",
      "ingestId": "1caf864b780367332170aa5a9da4a72bb94afa69",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Staatsarchiv München (Archivtektonik)",
      "type": "Tektonik_collection",
      "position": "00001",
      "leaf": false
    },
    {
      "aggregationEntity": false,
      "id": "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC",
      "parent": null,
      "ingestId": "5095594020963603yfKs",
      "providerId": [
        "00008615",
        "IPSQKSWH46RX2B475NRZARHV4SFHLQGZ"
      ],
      "label": "Staatsarchiv München",
      "type": "institution",
      "position": "-1",
      "leaf": false
    }
  ]
};

/** items/ILLUSTRATION/parents (2026-11-20, ~00:01 CET): the illustration, its volume, the work, the library, then the foundation the library belongs to: two institutions. */
export const PARENTS_ILLUSTRATION = {
  "numberOfResults": 5,
  "hierarchy": [
    {
      "aggregationEntity": false,
      "id": "5556S6VXBQ7766TPFLK3IDEOG4SX4MGH",
      "parent": "72P5NGEPP6S3FGXD6KW4TORFVOIRIOZT",
      "ingestId": "49532188503360679IsDa",
      "providerId": [
        "00008125",
        "6GFV3I4ELFEEFQIN2WECOXMTI5FUWHCK"
      ],
      "label": "Goethe.",
      "type": "htype_015",
      "position": "00002",
      "leaf": true
    },
    {
      "aggregationEntity": false,
      "id": "72P5NGEPP6S3FGXD6KW4TORFVOIRIOZT",
      "parent": "N3MUEEC4VMOVEH4KQIIHKVIHHGTDDOHC",
      "ingestId": "49532188503360679IsDa",
      "providerId": [
        "00008125",
        "6GFV3I4ELFEEFQIN2WECOXMTI5FUWHCK"
      ],
      "label": "Tome Premier",
      "type": "htype_007",
      "position": "00001",
      "leaf": false
    },
    {
      "aggregationEntity": false,
      "id": "N3MUEEC4VMOVEH4KQIIHKVIHHGTDDOHC",
      "parent": "6GFV3I4ELFEEFQIN2WECOXMTI5FUWHCK",
      "ingestId": "49532188503360679IsDa",
      "providerId": [
        "00008125",
        "6GFV3I4ELFEEFQIN2WECOXMTI5FUWHCK"
      ],
      "label": "Mémoires De Goethe",
      "type": "htype_020",
      "position": "00001",
      "leaf": false
    },
    {
      "aggregationEntity": false,
      "id": "6GFV3I4ELFEEFQIN2WECOXMTI5FUWHCK",
      "parent": "FB2OLEOR7CKRPB23WLCIUIIJMJOGN3UH",
      "ingestId": "5095594020963603yfKs",
      "providerId": [
        "00008615",
        "IPSQKSWH46RX2B475NRZARHV4SFHLQGZ"
      ],
      "label": "Staatsbibliothek zu Berlin - Preußischer Kulturbesitz",
      "type": "institution",
      "position": "-1",
      "leaf": false
    },
    {
      "aggregationEntity": false,
      "id": "FB2OLEOR7CKRPB23WLCIUIIJMJOGN3UH",
      "parent": null,
      "ingestId": "5095594020963603yfKs",
      "providerId": [
        "00008615",
        "IPSQKSWH46RX2B475NRZARHV4SFHLQGZ"
      ],
      "label": "Stiftung Preußischer Kulturbesitz",
      "type": "institution",
      "position": "-1",
      "leaf": false
    }
  ]
};

/** items/SERIES/children?rows=3: three of its 100 children. */
export const CHILDREN_SERIES = {
  "numberOfResults": 100,
  "hierarchy": [
    {
      "aggregationEntity": false,
      "id": "Q4WVE5KVBVO25ZVTJZ6N4PAKWTVCK6GT",
      "parent": "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Bekanntmachung. Oktoberfest 1921",
      "type": "htype_034",
      "position": "01248",
      "leaf": true
    },
    {
      "aggregationEntity": false,
      "id": "PWKS2K7L7GTUPAYCZLFBQKDZILIDJIW6",
      "parent": "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Bekanntmachung. Oktoberfest 1895 betr.",
      "type": "htype_034",
      "position": "01208",
      "leaf": true
    },
    {
      "aggregationEntity": false,
      "id": "OBO7MWSO3UKYR564FSZDBEBZOV4WHO6Q",
      "parent": "EV5F5USPSDKV5VCM3G6OIRXPA2QGY6LF",
      "ingestId": "05729beeedc53aab338dd27ecaf32592ba981e07",
      "providerId": [
        "00001219",
        "NDNVX424LRMBVY64C6KSEXBSUTNB7VWC"
      ],
      "label": "Bekanntmachung. Oktoberfest 1896 betr.",
      "type": "htype_034",
      "position": "01211",
      "leaf": true
    }
  ]
};

/** items/PRINT/view?lang=en: HTTP 404 (no view in English; seen for every object tried). */
export const VIEW_EN_404 = { message: "The content of the data column <sip_en> for the id <YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ> is empty!'" };

/** items/PRINT/edm (application/rdf+xml), in full. */
export const EDM_PRINT = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:ddb=\"http://www.deutsche-digitale-bibliothek.de/edm/\" xmlns:item=\"http://www.deutsche-digitale-bibliothek.de/item\" xmlns:lido=\"http://www.lido-schema.org\" xmlns:ns14=\"http://www.deutsche-digitale-bibliothek.de/ns/cortex-item-source-description\" xmlns:ns15=\"http://www.deutsche-digitale-bibliothek.de/ns/cortex-item-source\" xmlns:wgs84_pos=\"http://www.w3.org/2003/01/geo/wgs84_pos#\">\n        <ore:Aggregation rdf:about=\"RVFQ2SWNGD2FVUMNYS72KZ2NYJYRGNCX\" xmlns:ore=\"http://www.openarchives.org/ore/terms/\">\n            <edm:aggregatedCHO rdf:resource=\"http://www.deutsche-digitale-bibliothek.de/item/YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <edm:dataProvider xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">Stiftung Deutsches Historisches Museum</edm:dataProvider>\n            <edm:dataProvider rdf:resource=\"http://www.deutsche-digitale-bibliothek.de/organization/FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <edm:isShownAt rdf:resource=\"https://db.dhm.de/objekt/GR105655\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <edm:isShownBy rdf:resource=\"https://objekt.db.dhm.de/GR105655/download/large_without_watermark\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <edm:object rdf:resource=\"https://objekt.db.dhm.de/GR105655/download/large_without_watermark\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <edm:provider xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">Deutsche Digitale Bibliothek</edm:provider>\n            <edm:rights rdf:resource=\"http://creativecommons.org/licenses/by-nc-nd/4.0/\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\"/>\n            <dcterms:rights rdf:resource=\"http://creativecommons.org/publicdomain/zero/1.0/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n</ore:Aggregation>\n        <edm:WebResource xmlns:marcrel=\"http://id.loc.gov/vocabulary/relators.html\" rdf:about=\"https://db.dhm.de/objekt/GR105655\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <edm:rights rdf:resource=\"http://creativecommons.org/licenses/by-nc-nd/4.0/\"/>\n            <dc:type rdf:resource=\"http://ddb.vocnet.org/medientyp/mt002\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"/>\n            <dcterms:rights rdf:resource=\"http://creativecommons.org/licenses/by-nc-nd/4.0/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n</edm:WebResource>\n        <skos:Concept rdf:about=\"http://ddb.vocnet.org/medientyp/mt002\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:notation>mediatype_002</skos:notation>\n</skos:Concept>\n        <edm:WebResource xmlns:marcrel=\"http://id.loc.gov/vocabulary/relators.html\" rdf:about=\"https://objekt.db.dhm.de/GR105655/download/large_without_watermark\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <edm:rights rdf:resource=\"http://creativecommons.org/licenses/by-nc-nd/4.0/\"/>\n            <dc:type rdf:resource=\"http://ddb.vocnet.org/medientyp/mt002\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"/>\n            <dcterms:rights rdf:resource=\"http://creativecommons.org/licenses/by-nc-nd/4.0/\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n</edm:WebResource>\n        <skos:Concept rdf:about=\"http://ddb.vocnet.org/medientyp/mt002\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:notation>mediatype_002</skos:notation>\n</skos:Concept>\n        <edm:Agent rdf:about=\"http://www.deutsche-digitale-bibliothek.de/organization/FKBVHZEFB6RYNEMU3RNQGTMCFOSV7463\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <skos:prefLabel xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">Stiftung Deutsches Historisches Museum</skos:prefLabel>\n            <rdf:type rdf:resource=\"http://ddb.vocnet.org/sparte/sparte006\"/>\n</edm:Agent>\n        <skos:Concept rdf:about=\"http://ddb.vocnet.org/sparte/sparte006\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:notation>sec_06</skos:notation>\n</skos:Concept>\n        <edm:ProvidedCHO rdf:about=\"http://www.deutsche-digitale-bibliothek.de/item/YJFMZZU3OPATMQJBOUSB2ECY2NANFEFQ\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <edm:currentLocation rdf:resource=\"RA5ZEP24LOCXJBLQPBMP3PTHQENUVRSH\"/>\n            <edm:hasMet rdf:resource=\"IRFAX3IYFSOU7AG6C7PW3Q6YQ4XVAMW4\"/>\n            <edm:type>IMAGE</edm:type>\n            <dc:creator xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Hess, Peter von (Herstellung) (Zeichner)</dc:creator>\n            <dc:creator xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Weller, ? (Herstellung) (Stecher)</dc:creator>\n            <dc:identifier xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Gr 90/722 (Inventarnummer)</dc:identifier>\n            <dc:format xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Druckfarbe (Material/Technik)</dc:format>\n            <dc:format xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Papier (Material/Technik)</dc:format>\n            <dc:format xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Radierung (Technik)</dc:format>\n            <dc:type xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Druck</dc:type>\n            <dc:subject xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Fest</dc:subject>\n            <dc:subject xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Oktoberfest (München)</dc:subject>\n            <dc:subject xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Landwirtschaft</dc:subject>\n            <dc:title xml:lang=\"ger\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Oktoberfest 1810</dc:title>\n            <dcterms:subject rdf:resource=\"HUNVQ3TBEEVHLBH367WJJENJA5IVKVYQ\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n            <dcterms:subject rdf:resource=\"DBCADRMIZUEXW5ACWSCGVIN6K56NJXYZ\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n            <dcterms:subject rdf:resource=\"EMM43X7Z5I3XKV5BOUTXHYTMJG6UH6NM\" xmlns:dcterms=\"http://purl.org/dc/terms/\"/>\n            <dcterms:alternative xml:lang=\"ger\" xmlns:dcterms=\"http://purl.org/dc/terms/\">DAS OCTOBERFEST. 1810.</dcterms:alternative>\n            <dcterms:extent xml:lang=\"ger\" xmlns:dcterms=\"http://purl.org/dc/terms/\">Höhe x Breite: 25,1 x 37 cm (Blatt)</dcterms:extent>\n            <dcterms:extent xml:lang=\"ger\" xmlns:dcterms=\"http://purl.org/dc/terms/\">Höhe x Breite: 16,9 x 25,8 cm (Darstellung)</dcterms:extent>\n            <dcterms:created xmlns:dcterms=\"http://purl.org/dc/terms/\">1810 (Herstellung)</dcterms:created>\n            <dcterms:spatial xml:lang=\"ger\" xmlns:dcterms=\"http://purl.org/dc/terms/\">Deutschland</dcterms:spatial>\n</edm:ProvidedCHO>\n        <skos:Concept rdf:about=\"HUNVQ3TBEEVHLBH367WJJENJA5IVKVYQ\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:prefLabel xml:lang=\"ger\">Fest</skos:prefLabel>\n</skos:Concept>\n        <skos:Concept rdf:about=\"DBCADRMIZUEXW5ACWSCGVIN6K56NJXYZ\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:prefLabel xml:lang=\"ger\">Oktoberfest (München)</skos:prefLabel>\n</skos:Concept>\n        <skos:Concept rdf:about=\"EMM43X7Z5I3XKV5BOUTXHYTMJG6UH6NM\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">\n            <skos:prefLabel xml:lang=\"ger\">Landwirtschaft</skos:prefLabel>\n</skos:Concept>\n        <edm:Event xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" rdf:about=\"IRFAX3IYFSOU7AG6C7PW3Q6YQ4XVAMW4\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <edm:hasType rdf:resource=\"http://terminology.lido-schema.org/lido00007\"/>\n            <crm:P11_had_participant rdf:resource=\"TBPIZSU6R32FXN6SORP77YMWH66YRP2U\" xmlns:crm=\"http://www.cidoc-crm.org/rdfs/cidoc_crm_v5.0.2_english_label.rdfs#\"/>\n            <crm:P11_had_participant rdf:resource=\"XJM7SBNDQDDOFPAGW4FWTUFZREZMEVCK\" xmlns:crm=\"http://www.cidoc-crm.org/rdfs/cidoc_crm_v5.0.2_english_label.rdfs#\"/>\n            <edm:occuredAt rdf:resource=\"V2ZTICVY76VX7XI4VPINYTXJJ6UZZ3T2\"/>\n</edm:Event>\n        <edm:Agent rdf:about=\"TBPIZSU6R32FXN6SORP77YMWH66YRP2U\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <skos:prefLabel xml:lang=\"zxx\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">Hess, Peter von</skos:prefLabel>\n            <edm:wasPresentAt rdf:resource=\"IRFAX3IYFSOU7AG6C7PW3Q6YQ4XVAMW4\"/>\n</edm:Agent>\n        <edm:Agent rdf:about=\"XJM7SBNDQDDOFPAGW4FWTUFZREZMEVCK\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <skos:prefLabel xml:lang=\"zxx\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">Weller, ?</skos:prefLabel>\n            <edm:wasPresentAt rdf:resource=\"IRFAX3IYFSOU7AG6C7PW3Q6YQ4XVAMW4\"/>\n</edm:Agent>\n        <edm:TimeSpan rdf:about=\"V2ZTICVY76VX7XI4VPINYTXJJ6UZZ3T2\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <edm:begin>1810</edm:begin>\n            <edm:end>1810</edm:end>\n</edm:TimeSpan>\n        <edm:Place xmlns:exslt=\"http://exslt.org/common\" rdf:about=\"RA5ZEP24LOCXJBLQPBMP3PTHQENUVRSH\" xmlns:edm=\"http://www.europeana.eu/schemas/edm/\">\n            <skos:prefLabel xml:lang=\"ger\" xmlns:skos=\"http://www.w3.org/2004/02/skos/core#\">Berlin</skos:prefLabel>\n</edm:Place>\n</rdf:RDF>";

/** A stand-in for the volume's METS (the real one is large). */
export const METS_VOLUME = "<?xml version=\"1.0\"?>\n<mets:mets xmlns:mets=\"http://www.loc.gov/METS/\">\n<mets:dmdSec ID=\"DMD1\"/>\n</mets:mets>\n";

/** The DDB error envelope of an unknown item (HTTP 404). */
const notFound = (id: string): HttpResponse => jsonResponse({ name: "ItemNotFoundException", message: `Item '${id}' not found.`, stacktrace: "" }, 404);

/** Solr's answer to a search: the recorded one its parameters fit, paged and cut as Solr does. */
function search(url: URL): HttpResponse {
  const q = url.searchParams.get("q") ?? "";
  const fq = url.searchParams.getAll("fq");
  const rows = Number(url.searchParams.get("rows") ?? "10");
  const start = Number(url.searchParams.get("start") ?? "0");
  const none = { response: { numFound: 0, start, numFoundExact: true, docs: [] } };
  if (!/oktoberfest/i.test(q)) return jsonResponse(none);
  if (rows === 0) {
    const fields = url.searchParams.getAll("facet.field");
    const limit = Number(url.searchParams.get("facet.limit") ?? "100");
    const all = FACETS_OKTOBERFEST.facet_counts.facet_fields as Record<string, (string | number)[]>;
    const facetFields = Object.fromEntries(fields.map((field) => [field, (all[field] ?? []).slice(0, 2 * limit)]));
    return jsonResponse({ response: { ...FACETS_OKTOBERFEST.response, numFound: fq.length > 0 ? 0 : 1617 }, ...(fields.length > 0 ? { facet_counts: { facet_fields: facetFields } } : {}) });
  }
  const recorded = fq.length === 0 ? SEARCH_OKTOBERFEST : fq.length === 1 && fq[0] === 'provider_fct:"Staatsarchiv München"' ? SEARCH_STAATSARCHIV : undefined;
  if (recorded === undefined) return jsonResponse(none);
  return jsonResponse({ response: { ...recorded.response, start, docs: recorded.response.docs.slice(start, start + rows) } });
}

/** One component of an item. */
function item(id: string, rest: string, url: URL): HttpResponse {
  if (rest === "/source/record") {
    if (id === SECTION) {
      // The live answer: 303 with an absolute Location that lacks the /2 prefix.
      return { status: 303, headers: { location: `https://api.deutsche-digitale-bibliothek.de/items/${VOLUME}/source/record`, "content-type": "application/xml" }, body: Buffer.from("<x/>") };
    }
    if (id === VOLUME) return rawResponse(METS_VOLUME, "application/xml;charset=UTF-8");
    return notFound(id);
  }
  if (rest === "/parents") {
    if (id === PRINT) return jsonResponse(PARENTS_PRINT);
    if (id === RECORD) return jsonResponse(PARENTS_RECORD);
    if (id === ILLUSTRATION) return jsonResponse(PARENTS_ILLUSTRATION);
    if (id === SECTION) return jsonResponse({ numberOfResults: 0, hierarchy: [] });
    return notFound(id);
  }
  if (rest === "/children") {
    if (id !== SERIES) return id === PRINT || id === SECTION ? jsonResponse({ numberOfResults: 0, hierarchy: [] }) : notFound(id);
    const rows = Number(url.searchParams.get("rows") ?? "20");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    return jsonResponse({ numberOfResults: 100, hierarchy: CHILDREN_SERIES.hierarchy.slice(offset, offset + rows) });
  }
  if (id !== PRINT) return notFound(id);
  if (rest === "/view") return url.searchParams.get("lang") === "en" ? jsonResponse(VIEW_EN_404, 404) : jsonResponse(VIEW_PRINT);
  if (rest === "/binaries") return jsonResponse(BINARIES_PRINT);
  if (rest === "/edm") return rawResponse(EDM_PRINT, "application/rdf+xml;charset=utf-8");
  // The live 404 of a missing manifest has no body.
  if (rest === "/iiif") return { status: 404, headers: { "content-length": "0" }, body: Buffer.alloc(0) };
  return notFound(id);
}

/** The API's answer to `request`, from the recorded ones. */
export function ddbAnswer(request: HttpRequest): HttpResponse {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/2(?=\/)/, "");
  if (path === "/search/index/search/select") return search(url);
  const match = /^\/items\/([A-Z0-9]{32})(\/.*)?$/.exec(path);
  if (match !== null) return item(match[1] as string, match[2] ?? "", url);
  if (path === "/version") return rawResponse("7.5\n", "text/plain;charset=UTF-8");
  return jsonResponse({ error: "not found" }, 404);
}

/** A mock of the API over its own paths, answering from the recorded answers. */
export function ddbApi(): MockTransport {
  return makeMockTransport(ddbAnswer);
}
