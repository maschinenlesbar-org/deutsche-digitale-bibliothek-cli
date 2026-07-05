# Data license

> **This tool does not include, host, or redistribute any data.**
> `deutsche-digitale-bibliothek-cli` is a *client*. It only accesses data served
> live by the **Deutsche Digitale Bibliothek (DDB)** via its API. That data is
> governed by **the DDB's and its partner institutions'** terms, summarized
> below. The license of this CLI's own source code is a separate matter — see
> [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Deutsche Digitale Bibliothek (DDB) — aggregating German archives, libraries, museums and other cultural/scientific institutions |
| **API / source** | `https://api.deutsche-digitale-bibliothek.de` · portal: https://www.deutsche-digitale-bibliothek.de |
| **Metadata license (what this CLI returns)** | **CC0 1.0 Universal** (Public Domain Dedication) — the API exposes metadata *exclusively* under CC0 |
| **License text** | https://creativecommons.org/publicdomain/zero/1.0/ |
| **Attribution** | **Not legally required** for the CC0 metadata (crediting the DDB and the holding institution is nonetheless good practice) |
| **Commercial use** | Allowed (metadata is CC0) |
| **Object media (images/audio/video)** | **Per-object rights — varies**; see below |

## The key distinction: metadata vs. digital objects

- **Metadata (what this CLI returns).** The DDB API deliberately serves **only
  CC0-licensed metadata**. This is a narrower set than the portal shows: metadata
  that a partner has *not* placed under CC0 is simply not returned by the API.
  So everything you get from `ddb search`, `ddb item`, `ddb facets` and
  `ddb institutions` is CC0 — freely usable, no attribution obligation.
- **Digital objects (images, audio, video).** The actual media files are **not**
  returned by this CLI (it does not implement the `/binary` endpoint). Each
  object carries its **own** rights statement, chosen by the holding institution
  from the DDB "Lizenzkorb" (license basket): CC0, CC BY, CC BY-SA, Public Domain
  Mark, various *Rights Reserved* / *In Copyright* statements, and so on. **If you
  follow a link to an object's media, check that object's individual rights
  statement** — do not assume it is CC0 just because its metadata is.

## Notes & caveats

- An API key is required (free, from a "Mein DDB" account), but that is an
  access-control measure, not a license grant — it does not change the CC0 status
  of the metadata.
- No warranty for accuracy or completeness; institutions supply their own data.
- The DDB's terms and the per-object rights basket can change — verify at the
  source before relying on the data, especially for redistribution of any object
  media.

## Sources

- https://pro.deutsche-digitale-bibliothek.de/daten-liefern/teilnahmekriterien/rechtliches/lizenzen-und-rechtehinweise-der-lizenzkorb-der-deutschen-digitalen-bibliothek — the DDB license basket for objects
- https://creativecommons.org/publicdomain/zero/1.0/ — CC0 1.0 (metadata)
- https://api.deutsche-digitale-bibliothek.de/OpenAPI — API documentation

---

*Good-faith summary compiled 2026-07-06; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
