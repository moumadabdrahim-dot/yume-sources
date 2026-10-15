# OscarTV Yume plugin

This repository publishes the OscarTV plugin for Yume Plugin API v2. Production executes the single-file plugin in Yume's QuickJS runtime using its built-in `fetch`, `CryptoJS`, and Cheerio-compatible bridge. Node.js is used only for local and live smoke tests.

## Runtime files

- `manifest.json` — v2 manifest with independent movies, series, and anime catalogs.
- `plugins/oscartv-v2.js` — self-contained API v2 runtime plugin.
- `plugins/oscartv.js` — retained API v1 rollout file for clients with a cached old manifest.
- `tests/` — deterministic API mapping/signer tests, live smoke, and the signer vector.
- `docs/OSCARTV_RECONSTRUCTION.md` — architecture, API mapping, playback behavior, evidence status, monitoring design, and production gaps.

## API map and current evidence

API host declared by the extracted app: `https://ostvapp.cam`. The Yume v2 plugin uses the published OscarTV API origin `https://ostv-11-11.xyz`, which was verified from Windows during this update.

- Catalogs/search: `GET /api/movies/`, `/api/series/`, `/api/anime/` with `page`, `limit`, optional `search`, and supported catalog filters. Each Yume catalog request calls one matching endpoint.
- Movie details and embedded watch links: `GET /api/movies/show.php?id=…`.
- Series details: `GET /api/series/show.php?id=…`; seasons: `/api/seasons/?series_id=…`; episode pages: `/api/episodes/?season_id=…&per_page=100&page=…`.
- Anime details (including embedded seasons): `/api/anime/show.php?id=…`; episode pages: `/api/anime/episodes/?season_id=…&per_page=100&page=…`.
- Episode links: series `/api/episodes/show.php?id=…`, then `/api/watch_links/?episode_id=…`; anime `/api/anime/episodes/show.php?id=…`.
- Iron signature compatibility code runs locally; the third-party `flech.tn` signer is not called. `tests/fixtures/iron-signer.json` remains a deterministic vector, while live requests using the local signer returned HTTP 200 from `ostv-11-11.xyz` and retrieved current catalog, details, episode and WatchLink data. Requests to the extracted app host `ostvapp.cam` returned a Cloudflare HTML 403, including when the published signer helper was used.

Catalog cursors are Oscar's positive numeric page numbers encoded as strings. Metadata includes source-provided titles, posters, banner, release year, rating, story, genres, native IDs, and validated `tmdb_id` / `imdb_id` values when Oscar supplies them. The plugin does not make extra details requests for catalog items or perform TMDB lookup.

The old CloudStream resolver delegates arbitrary hosts to a dynamic extractor system and does not enumerate a stable host list. This plugin only handles direct media, SeriesMP4 iframe wrappers, explicit HTML media nodes, and Yandex direct/redirect media when the final URL or MIME identifies playable media. No CloudStream dependency or generic extractor framework is included; unknown embed hosts can remain unresolved.

The v1 file remains available during rollout. Stream options with a provider WatchLink ID keep only that ID in their token and fetch a fresh selected link at resolution time; legacy links without an ID retain the compatible URL-bearing token. A fresh Windows check retrieved House of the Dragon S1E1 WatchLinks, resolved the fourth Yume option by stable ID, and read its HLS manifest: the response was a finite 65:36 VOD playlist with no redirect. No media segment was fetched or played, so actual episode content and full playback remain unverified; the one-minute warning was not observed in the manifest response.

## Update monitoring

The Windows GitHub Actions workflow checks the official OscarTV APK release, verifies package/version/digest/certificate, compares relevant JADX source fingerprints, runs the plugin suite, and uploads a review artifact. It does not change the baseline, publish code, or deploy automatically. A new signing identity or breaking source change requires manual review.

## Tests

From this directory:

- `node --test tests/oscartv.test.cjs tests/oscartv-v2.test.cjs`
- `node tests/live-smoke.cjs` (bounded requests to the live API)

The deterministic plugin suite currently passes 80 tests. A live smoke returning HTTP 403 is reported as an access failure, not as a content/playback result.
