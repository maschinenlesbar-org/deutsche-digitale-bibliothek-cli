# deutsche-digitale-bibliothek-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
**Germany's digitised cultural heritage**, all powered by the **[ddb](README.md)** CLI
over the **v2** [Deutsche Digitale Bibliothek API](https://api.deutsche-digitale-bibliothek.de/2).

Each skill teaches Claude how to drive the `ddb` CLI to answer a specific, real-world
question — "find objects about the Bauhaus", "show me this object's details", "which
places hold the most on this topic?" — and to report the answer with citations rather
than guesswork. They encode the parts that are easy to get wrong (the native-Solr
`response.docs[]` shape, `--facet` vs `--filter`, the flat facet-count array, the
CC0-metadata-vs-object-rights split) so Claude doesn't rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **ddb-search** | Searches the Solr object index, narrows with filter queries, and reads facet distributions (which places / types / providers have the most objects). | "find Bauhaus objects", "how many photos of Goethe are digitised?", "manuscripts from Berlin", "top places for medieval manuscripts" |
| **ddb-item** | Fetches one object by its 32-character id — the friendly `view`, the `edm` record, its `binaries`, IIIF manifest, or `parents`/`children` hierarchy. | "show this DDB object's details", "get the Europeana metadata for this item", "what media belong to this record?" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `ddb` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/deutsche-digitale-bibliothek-cli   # installs the `ddb` bin
  ```
- **No API key.** The read routes (`search`, `item`, `version`) are public — there is
  nothing to register and nothing to pass.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/deutsche-digitale-bibliothek-cli
/plugin install ddb@ddb-skills
```

The first command registers the marketplace; the second installs the `ddb` plugin, which
bundles both skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/deutsche-digitale-bibliothek-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/ddb-search/SKILL.md`. Start a new Claude Code session and the skills are picked up
automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Find digitised Bauhaus posters in the DDB and show me the top ten.

> Which places hold the most objects about medieval manuscripts?

> Get the Europeana metadata for object TNPFDKO2VDGBZ72RWC6RKDNZYZQZP3XK.

You can also invoke a skill explicitly with its slash command, e.g. `/ddb-search`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which `ddb`
subcommands to call, in what order, and how to interpret the JSON. The skills encode the
non-obvious parts of this API, for example:

- **no key needed** — the v2 read routes are public; a `403` (CLI exit `1`) is unusual and
  means a custom `--base-url` hit an authenticated endpoint, not "set a key";
- **native Solr shape** — hits live under `response.docs[]`, and the total is
  `response.numFound` (read it to count; don't page everything);
- **`--facet` vs `--filter`** — `--facet type_fct` *returns* value counts (a flat
  `[value, count, …]` array under `facet_counts.facet_fields`); `--filter` takes a raw Solr
  `fq` like `type_fct:mediatype_002` that *restricts* the set;
- **item ids are exactly 32 characters** — a wrong-length id is rejected up front (exit
  `2`); from a DDB object URL, take the last path segment;
- **some item components are XML** — `edm` and `source-record` print raw XML, not JSON;
- **metadata is CC0, object media are not** — the API returns only CC0 metadata, but the
  image/audio/video a record points to carry per-object rights from the DDB "Lizenzkorb";
  check each object's rights before reusing its media;
- **the API exposes a narrower set than the web portal** — only CC0 metadata is served, so
  a portal object may be absent from API results.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
