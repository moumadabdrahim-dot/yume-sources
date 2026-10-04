# OscarTV Yume plugin

This independent repository contains the single-file OscarTV plugin for Yume Plugin API v1. Production runs in Yume's QuickJS runtime and uses its built-in `fetch`, `CryptoJS`, and Cheerio-compatible bridge. Node.js is used only for local tests.

## Runtime files

- `manifest.json` — the single-plugin manifest shape supported by Yume API v1.
- `plugins/oscartv.js` — self-contained runtime plugin.
- `tests/` — local deterministic tests and signer vector.

## Observed Oscar API contract (read-only CloudStream reference)

Base/image host: `https://ostvapp.cam`.

- Home/search catalogs: `GET /api/movies/`, `/api/series/`, `/api/anime/` with `page`, `limit`, and optional `search`.
- Movie details and embedded watch links: `GET /api/movies/show.php?id=…`.
- Series details: `GET /api/series/show.php?id=…`; seasons: `/api/seasons/?series_id=…`; episode pages: `/api/episodes/?season_id=…&per_page=100&page=…`.
- Anime details (including embedded seasons): `/api/anime/show.php?id=…`; episode pages: `/api/anime/episodes/?season_id=…&per_page=100&page=…`.
- Episode links: series `/api/episodes/show.php?id=…`, then `/api/watch_links/?episode_id=…`; anime `/api/anime/episodes/show.php?id=…`.
- Iron request signature: HMAC-SHA256 over `rawPath|unixTimestamp|nonce`; derived key and constants reproduce the reference implementation's deterministic vector. API requests use `okhttp/4.12.0` and the Iron headers.

The reference resolver delegates arbitrary hosts to CloudStream's dynamic extractor system; the old source does not enumerate a stable host list. This plugin intentionally has only bounded Oscar-specific handling: direct media URLs, SeriesMP4 iframe wrappers, explicit HTML media elements, and Yandex direct/redirect media when the returned URL or MIME identifies playable media. It does not include CloudStream or a generic extractor framework. Unknown third-party embed hosts can therefore remain unresolved.

Oscar's current network/API availability must be verified through the live QuickJS-on-device test; local unit tests do not claim live service success.

## Local tests

Run `node --test tests/oscartv.test.cjs` from this directory.
