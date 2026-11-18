# CimaCloud integration status

Reference revisions used on 2026-11-18:

- `yume-sources`: `b5c4d848aeaec8626f5ca9e41f8b76a23d1a022a`
- `mo7AmMeD64/cs-ar`: `ae0f7f8717e05fdb551876d3751f4e30998827ac`
- inspected APK: `com.app.cimacloud`, version `1.4` (code `6`)

The 1.4 remote configuration still points at the public v1.3 API. Public HTTPS requests were verified for aggregate Home, paged `/all`, search, movie details, series details, and public episode lists. The server endpoints return a JSON rejection with `blocked=true` without app-specific attestation.

This plugin deliberately does not copy the original application's attestation, certificate identity, encryption keys, or protected-server decryption. `getStreams` reports `CIMACLOUD_AUTHORIZED_SERVER_ACCESS_REQUIRED` until CimaCloud provides a documented third-party access route or a legitimate readable server export is supplied for review.

Implemented boundaries:

- Stable IDs: `cc:movie:<id>`, `cc:series:<id>`, `cc:episode:<id>`.
- Aggregate Home is fetched once and episode cards resolve to their parent series.
- Catalog/search cursors are bounded positive page numbers.
- Details verify returned native identity before display.
- TMDB/IMDb values are forwarded only when their source fields pass strict validation.
- No stream URL, cookie, authorization value, or query token is logged.
- Remote API hosts must be public HTTPS names or public IPv4 addresses; private and local destinations are rejected.

Playback is intentionally blocked, not simulated. Fixture tests do not prove live playback.
