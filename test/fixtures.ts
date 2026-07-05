// Canned DDB API responses used across the client and CLI tests. Shapes mirror
// the real API (see the OpenAPI spec) but are trimmed to what the tests assert.

export const search = {
  numberOfResults: 12345,
  results: [
    {
      numberOfDocs: 2,
      docs: [
        { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", label: "Goethe, Bildnis", type: "Bild" },
        { id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", label: "Faust, Erstdruck", type: "Buch" },
      ],
    },
  ],
  facets: [
    {
      field: "type_fct",
      numberOfFacets: 2,
      facetValues: [
        { value: "Bild", count: 8000 },
        { value: "Buch", count: 4000 },
      ],
    },
  ],
  correctedQuery: "",
  randomSeed: "",
};

export const itemView = {
  item: { id: "OAXO2AGT7YH35YYHN3YKBXJMEI77W3FF", title: "Goethe, Bildnis" },
  institution: { name: "Klassik Stiftung Weimar" },
};

export const facetsList = ["type_fct", "place_fct", "provider_fct", "sector_fct"];

export const facetValues = {
  facets: [
    {
      field: "place_fct",
      numberOfFacets: 2,
      facetValues: [
        { value: "Berlin", count: 500 },
        { value: "München", count: 300 },
      ],
    },
  ],
};

export const institutions = [
  {
    id: "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",
    name: "Klassik Stiftung Weimar",
    latitude: 50.98,
    longitude: 11.32,
    sector: "sec_06",
    children: [],
  },
];

/** The DDB error envelope returned (as HTTP 403/404) on failures. */
export const notAuthorized = {
  name: "NotAuthorizedException",
  message: "Your security level does not allow access to this method.",
  stacktrace: "",
};

export const notFound = {
  name: "ItemNotFoundException",
  message: "Item 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234' not found.",
  stacktrace: "",
};
