// Canned DDB **v2** API responses used across the client and CLI tests. Shapes
// mirror the real API (native Solr for search; JSON or XML per item component)
// but are trimmed to what the tests assert.

/** A native Solr search response where more documents match than are returned. */
export const solr = {
  responseHeader: {
    status: 0,
    QTime: 12,
    params: { q: "Goethe", rows: "10", wt: "json" },
  },
  response: {
    numFound: 99866,
    start: 0,
    maxScore: 18.9,
    numFoundExact: true,
    docs: [
      { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", title: ["Goethe, Bildnis"], type: ["mediatype_002"] },
      { id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", title: ["Faust, Erstdruck"], type: ["mediatype_003"] },
    ],
  },
  facet_counts: {
    facet_fields: { type_fct: ["mediatype_002", 8000, "mediatype_003", 4000] },
  },
};

/** A Solr response whose whole result set fits in the page (no paging note). */
export const solrExact = {
  response: {
    numFound: 2,
    start: 0,
    docs: [
      { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ],
  },
};

/** A JSON item component (e.g. `view`). */
export const itemView = {
  edm: { id: "TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK", title: "Goethe, Bildnis" },
  institution: { name: "Klassik Stiftung Weimar" },
};

/** The RDF/XML body the `edm` component serves (Content-Type application/rdf+xml). */
export const edmXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<rdf:RDF><edm:ProvidedCHO rdf:about="#obj"/></rdf:RDF>';

/** The DDB error envelope returned (as HTTP 404) for a missing item. */
export const notFound = {
  name: "ItemNotFoundException",
  message: "Item 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234' not found.",
  stacktrace: "",
};

/** A Solr error body (HTTP 400) for a malformed query. */
export const solrError = {
  responseHeader: { status: 400, QTime: 1 },
  error: { msg: "undefined field bogus_fct", code: 400 },
};
