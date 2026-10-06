# OscarTV Yume plugin

This repository publishes the OscarTV plugin for Yume Plugin API v2. Production executes the single-file plugin in Yume's QuickJS runtime using its built-in `fetch`, `CryptoJS`, and Cheerio-compatible bridge. Node.js is used only for local and live smoke tests.

## Runtime files

- `manifest.json` — v2 manifest with independent movies, series, and anime catalogs.
- `plugins/oscartv-v2.js` — self-contained API v2 runtime plugin.
- `plugins/oscartv.js` — retained API v1 rollout file for clients with a cached old manifest.
- `tests/` — deterministic API mapping/signer tests, live smoke, and the signer vector.

## Verified API contract

Base/image host: `https://ostvapp.cam`.

- Catalogs: `GET /api/movies/`, `/api/series/`, `/api/anime/` with `page`, `limit`, and optional `search`. Each Yume catalog request calls exactly one matching endpoint.
- Movie details and embedded watch links: `GET /api/movies/show.php?id=…`.
- Series details: `GET /api/series/show.php?id=…`; seasons: `/api/seasons/?series_id=…`; episode pages: `/api/episodes/?season_id=…&per_page=100&page=…`.
- Anime details (including embedded seasons): `/api/anime/show.php?id=…`; episode pages: `/api/anime/episodes/?season_id=…&per_page=100&page=…`.
- Episode links: series `/api/episodes/show.php?id=…`, then `/api/watch_links/?episode_id=…`; anime `/api/anime/episodes/show.php?id=…`.
- Iron signature: HMAC-SHA256 over `rawPath|unixTimestamp|nonce`; key derivation and constants are verified against `tests/fixtures/iron-signer.json`. API requests use `okhttp/4.12.0` and the Iron headers.

Catalog cursors are Oscar's positive numeric page numbers encoded as strings. The host treats them as opaque and only the plugin decodes them. Metadata includes source-provided titles, posters, banner, release year, rating, story, genres, native IDs, and validated `tmdb_id` / `imdb_id` values when Oscar supplies them in a response. The plugin does not make extra details requests for catalog items or perform TMDB lookup; external IDs pass through as `externalIds.tmdb` and `externalIds.imdb`.

The old CloudStream resolver delegates arbitrary hosts to a dynamic extractor system and does not enumerate a stable host list. This plugin only handles direct media, SeriesMP4 iframe wrappers, explicit HTML media nodes, and Yandex direct/redirect media when the final URL or MIME identifies playable media. No CloudStream dependency or generic extractor framework is included; unknown embed hosts can remain unresolved.

The v1 file remains available during rollout. The v2 live service and physical-device behavior must be verified independently; unit tests do not claim production API success.

## Tests

From this directory:

- `node --test tests/oscartv.test.cjs tests/oscartv-v2.test.cjs`
- `node tests/live-smoke.cjs` (bounded requests to the live API)
