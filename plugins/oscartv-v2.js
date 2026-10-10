/* OscarTV Yume Plugin API v2. No Node/browser-only APIs and no third-party runtime imports. */
(function (root) {
  "use strict";

  var API = "https://ostvapp.cam";
  var PLUGIN_ID = "oscar";
  var CERT_SHA256 = "6e2fcda8631eb49ebcba4ca8ef4c597abe84654c7d3e8096db32bdd21ecf763f";
  var PACKAGE_NAME = "com.drama.mp4";
  var IRON_DIAG = "f=6e2fcda8 p=6e2fcda8 h=0";
  var API_UA = "okhttp/4.12.0";
  var MEDIA_UA = "TDMuaPlayer";
  var MAX_PAGES = 1000;
  var MAX_CONCURRENT_STREAM_RESOLUTIONS = 2;

  function fail(message) { throw new Error("Source: " + message); }
  function text(value) {
    return value == null ? "" : String(value).trim();
  }
  function optional(value) {
    var v = text(value);
    return v && v !== "null" && v !== "undefined" ? v : null;
  }
  function positiveInt(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n <= 2147483647 && Math.floor(n) === n ? n : null;
  }
  function parseId(value) {
    if (typeof value !== "string") fail("native id must be a string");
    var match = /^(movie|series|anime|series_episode|anime_episode):([1-9][0-9]*)$/.exec(value);
    if (!match) fail("malformed native id: " + value);
    var id = positiveInt(match[2]);
    if (!id) fail("native id is outside supported integer range");
    return { type: match[1], id: id };
  }
  function nativeId(type, id) {
    if (["movie", "series", "anime", "series_episode", "anime_episode"].indexOf(type) < 0) fail("unsupported native id type");
    var number = positiveInt(id);
    if (!number) fail("invalid Oscar id");
    return type + ":" + number;
  }
  function utf8Bytes(value) {
    var word = CryptoJS.enc.Utf8.parse(String(value));
    var out = [];
    for (var i = 0; i < word.sigBytes; i++) out.push((word.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255);
    return out;
  }
  function wordArray(bytes) {
    var words = [];
    for (var i = 0; i < bytes.length; i++) words[i >>> 2] = (words[i >>> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
    return CryptoJS.lib.WordArray.create(words, bytes.length);
  }
  function hexBytes(hex) {
    var out = [];
    for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }
  function xorRepeated(bytes, mask) {
    return bytes.map(function (value, index) { return value ^ mask[index % mask.length]; });
  }
  function deriveIronKey() {
    var value = utf8Bytes(CERT_SHA256 + "|" + PACKAGE_NAME);
    // Kotlin reference: "OscarTVIronGuard".toByteArray().copyOf(7) => ASCII OscarTV.
    value = xorRepeated(value, utf8Bytes("OscarTV"));
    value.reverse();
    value = xorRepeated(value, utf8Bytes("IronGuard"));
    for (var i = 0; i < 3; i++) value = hexBytes(CryptoJS.SHA256(wordArray(value)).toString(CryptoJS.enc.Hex));
    return wordArray(value);
  }
  function signedPath(urlOrPath) {
    var source = String(urlOrPath || "");
    var match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(source);
    if (match) return match[1] || "/";
    return source.split(/[?#]/)[0] || "/";
  }
  function sign(pathOrUrl, timestamp, nonce) {
    var payload = signedPath(pathOrUrl) + "|" + String(timestamp) + "|" + String(nonce);
    return CryptoJS.HmacSHA256(payload, deriveIronKey()).toString(CryptoJS.enc.Hex);
  }
  function randomNonce() {
    return CryptoJS.lib.WordArray.random(4).toString(CryptoJS.enc.Hex).toLowerCase();
  }
  function apiHeaders(url) {
    var timestamp = Math.floor(Date.now() / 1000);
    var nonce = randomNonce();
    var headers = {
      "Accept": "application/json",
      "User-Agent": API_UA,
      "X-Iron-Sig": sign(url, timestamp, nonce),
      "X-Iron-Ts": String(timestamp),
      "X-Iron-Nonce": nonce,
      "X-Iron-Diag": IRON_DIAG
    };
    return headers;
  }
  function queryString(values) {
    var pairs = [];
    Object.keys(values || {}).forEach(function (key) {
      if (values[key] !== undefined && values[key] !== null) pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(values[key])));
    });
    return pairs.join("&");
  }
  function buildUrl(path, query) {
    var suffix = queryString(query);
    return API + path + (suffix ? "?" + suffix : "");
  }
  async function request(path, query) {
    var url = buildUrl(path, query);
    var response;
    try {
      response = await fetch(url, { method: "GET", headers: apiHeaders(url), redirect: "follow" });
    } catch (error) { throw error; }
    if (!response || !response.ok) fail("HTTP " + (response ? response.status : "no response") + " for " + path);
    var envelope;
    try { envelope = await response.json(); } catch (error2) { fail("invalid JSON for " + path); }
    if (!envelope || String(envelope.status || "").toLowerCase() !== "success") {
      fail("API status failure for " + path + ": " + text(envelope && (envelope.message || envelope.error) || "unknown"));
    }
    return envelope;
  }
  async function list(path, query) {
    var envelope = await request(path, query);
    if (!Array.isArray(envelope.data)) fail("expected list data at " + path);
    return { items: envelope.data, pagination: envelope.pagination || {} };
  }
  async function objectData(path, query) {
    var envelope = await request(path, query);
    if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) fail("expected object data at " + path);
    return envelope.data;
  }
  function imageUrl(value) {
    var v = optional(value);
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.indexOf("//") === 0) return "https:" + v;
    return API + (v.charAt(0) === "/" ? v : "/" + v);
  }
  function titleOf(item, id) { return optional(item.title_ar) || optional(item.title_en) || optional(item.title_jp) || ("عنوان غير متوفر " + id); }
  function genresOf(item) {
    var value = item.genres;
    function genreName(entry) {
      if (typeof entry === "string") {
        var label = optional(entry);
        return label === "[object Object]" ? null : label;
      }
      // Oscar's live genre objects use `name` for the localized display value.
      // Never stringify an object: that would expose `[object Object]` in Details.
      if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string") {
        var name = optional(entry.name);
        return name === "[object Object]" ? null : name;
      }
      return null;
    }
    if (Array.isArray(value)) return value.map(genreName).filter(Boolean);
    if (typeof value === "string") return value.split(/[,،|]/).map(genreName).filter(Boolean);
    return [];
  }
  function externalIdsOf(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    var tmdbValue = raw.tmdb_id;
    var tmdbId = null;
    if (typeof tmdbValue === "number") tmdbId = positiveInt(tmdbValue);
    else if (typeof tmdbValue === "string" && /^\d+$/.test(tmdbValue.trim())) tmdbId = positiveInt(tmdbValue.trim());
    var imdbId = optional(raw.imdb_id);
    if (!imdbId || !/^tt[0-9]+$/i.test(imdbId)) imdbId = null;
    if (!tmdbId && !imdbId) return undefined;
    var externalIds = {};
    if (tmdbId) externalIds.tmdb = String(tmdbId);
    if (imdbId) externalIds.imdb = imdbId;
    return externalIds;
  }
  function mapMedia(raw, type) {
    var id = positiveInt(raw && raw.id);
    if (!id) return null;
    return {
      nativeId: nativeId(type, id), type: type, title: titleOf(raw, id),
      originalTitle: (type === "anime"
        ? optional(raw.title_jp) || optional(raw.title_en)
        : optional(raw.title_en) || optional(raw.title_jp)) || undefined,
      poster: imageUrl(raw.poster) || undefined, backdrop: imageUrl(raw.banner) || undefined,
      year: positiveInt(raw.release_year) || positiveInt(raw.season_year) || undefined,
      rating: isFinite(Number(raw.rating)) && optional(raw.rating) !== null ? Number(raw.rating) : undefined,
      externalIds: externalIdsOf(raw),
      description: optional(raw.story) || undefined, genres: genresOf(raw)
    };
  }
  function pageCount(page) {
    var p = page && page.pagination || {};
    return positiveInt(p.page_count) || positiveInt(p.total_pages) || positiveInt(p.last_page) || null;
  }
  var CATALOG_CONFIG = [
    { id: "movies", path: "/api/movies/", type: "movie" },
    { id: "series", path: "/api/series/", type: "series" },
    { id: "anime", path: "/api/anime/", type: "anime" }
  ];
  function catalogPageCount(page) {
    var count = pageCount(page);
    if (count) return count;
    var pagination = page && page.pagination || {};
    var total = positiveInt(pagination.total);
    var limit = positiveInt(pagination.per_page) || positiveInt(pagination.limit);
    return total && limit ? Math.ceil(total / limit) : null;
  }
  async function getCatalog(args) {
    args = args || {};
    var catalog = null;
    for (var i = 0; i < CATALOG_CONFIG.length; i++) {
      if (CATALOG_CONFIG[i].id === args.catalogId) { catalog = CATALOG_CONFIG[i]; break; }
    }
    if (!catalog) fail("unknown catalog");
    if (args.type !== catalog.type) fail("catalog type mismatch");
    var pageNo = 1;
    if (args.cursor !== undefined && args.cursor !== null) {
      var cursor = String(args.cursor);
      if (!/^[1-9][0-9]{0,3}$/.test(cursor) || Number(cursor) > MAX_PAGES) fail("invalid page cursor");
      pageNo = Number(cursor);
    }
    var limit = args.limit === undefined || args.limit === null ? 20 : Number(args.limit);
    if (!isFinite(limit) || Math.floor(limit) !== limit || limit < 1 || limit > 100) fail("invalid page limit");
    var query = { page: pageNo, limit: limit };
    var search = args.query == null ? "" : String(args.query);
    if (search.trim()) query.search = search;
    var result = await list(catalog.path, query);
    var current = positiveInt(result.pagination.page) || pageNo;
    var pages = catalogPageCount(result);
    var hasMore = !!pages && current < pages && current < MAX_PAGES;
    var total = positiveInt(result.pagination.total);
    return {
      catalogId: catalog.id,
      items: result.items.map(function (item) { return mapMedia(item, catalog.type); }).filter(Boolean),
      page: { nextCursor: hasMore ? String(current + 1) : null, hasMore: hasMore, total: total || undefined }
    };
  }
  function mapEpisode(raw, type, seasonFallback, posterFallback) {
    var id = positiveInt(raw && raw.id);
    if (!id) return null;
    var number = positiveInt(raw.episode_number) || undefined;
    var title = optional(raw.title) || (number ? "الحلقة " + number : "حلقة");
    return { nativeId: nativeId(type === "series" ? "series_episode" : "anime_episode", id),
      season: positiveInt(raw.season_number) || seasonFallback || undefined, episode: number,
      title: title, thumbnail: imageUrl(raw.thumbnail || raw.anime_poster || raw.series_poster || raw.poster || posterFallback) || undefined,
      description: optional(raw.description) || undefined, released: optional(raw.air_date) || undefined };
  }
  async function listWithRetry(path, query) {
    var lastError;
    for (var attempt = 0; attempt < 2; attempt++) {
      try { return await list(path, query); } catch (error) { lastError = error; }
    }
    throw lastError || new Error("request failed");
  }
  async function fetchAllEpisodes(path, seasonId, type, seasonNumber, poster) {
    var first = await listWithRetry(path, { season_id: seasonId, per_page: 100, page: 1 });
    var pages = positiveInt(first.pagination.page_count) || positiveInt(first.pagination.total_pages) || positiveInt(first.pagination.last_page) || 1;
    pages = Math.max(1, Math.min(pages, MAX_PAGES));
    var all = first.items.slice();
    // Match the reference implementation's page concurrency bound of four.
    for (var start = 2; start <= pages; start += 4) {
      var jobs = [];
      for (var page = start; page < start + 4 && page <= pages; page++) {
        (function (pageNo) { jobs.push(listWithRetry(path, { season_id: seasonId, per_page: 100, page: pageNo }).catch(function () { return null; })); })(page);
      }
      var loaded = await Promise.all(jobs);
      loaded.forEach(function (result) { if (result && result.items) all = all.concat(result.items); });
    }
    return all.map(function (raw) { return mapEpisode(raw, type, seasonNumber, poster); }).filter(Boolean);
  }
  async function getDetails(args) {
    var parsed = parseId(args && args.id);
    if (parsed.type === "movie") {
      var movie = await objectData("/api/movies/show.php", { id: parsed.id });
      return { item: detailsItem(movie, "movie", parsed.id), episodes: [] };
    }
    if (parsed.type !== "series" && parsed.type !== "anime") fail("details require a movie, series, or anime id");
    var path = parsed.type === "series" ? "/api/series/show.php" : "/api/anime/show.php";
    var raw = await objectData(path, { id: parsed.id });
    var item = detailsItem(raw, parsed.type, parsed.id);
    var seasons = Array.isArray(raw.seasons) ? raw.seasons.slice() : [];
    if (parsed.type === "series") {
      try {
        var seasonPage = await list("/api/seasons/", { series_id: parsed.id });
        if (seasonPage.items.length) seasons = seasonPage.items;
      } catch (_) { /* embedded seasons remain a valid source fallback */ }
    }
    seasons = seasons.filter(function (season) { return positiveInt(season.id) && positiveInt(season.season_number); })
      .sort(function (a, b) { return Number(a.season_number) - Number(b.season_number); });
    var episodes = [];
    for (var i = 0; i < seasons.length; i += 4) {
      var seasonGroup = seasons.slice(i, i + 4);
      var fetched = await Promise.all(seasonGroup.map(function (season) {
        var endpoint = parsed.type === "series" ? "/api/episodes/" : "/api/anime/episodes/";
        return fetchAllEpisodes(endpoint, Number(season.id), parsed.type, Number(season.season_number), item.poster).catch(function () { return []; });
      }));
      fetched.forEach(function (entries) { episodes = episodes.concat(entries); });
    }
    episodes.sort(function (a, b) { return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0); });
    return { item: item, episodes: episodes };
  }
  function detailsItem(raw, type, id) {
    var item = mapMedia(raw || {}, type);
    if (!item) item = { nativeId: nativeId(type, id), type: type, title: "عنوان غير متوفر " + id, genres: [] };
    item.nativeId = nativeId(type, id);
    return { nativeId: item.nativeId, type: item.type, title: item.title,
      originalTitle: item.originalTitle, poster: item.poster, backdrop: item.backdrop,
      description: item.description, year: item.year, rating: item.rating,
      genres: item.genres || [], externalIds: item.externalIds,
      hasParentStreams: Array.isArray(raw.watch_links) && raw.watch_links.some(function (link) {
        return isHttpUrl(link && link.url);
      }),
      runtime: positiveInt(raw.runtime) || positiveInt(raw.episode_duration) || undefined };
  }
  function qualityOf(value) {
    var source = text(value);
    var match = /(\d{3,4})\s*p/i.exec(source);
    return match ? match[1] + "p" : (source || undefined);
  }
  function serverTitle(link) {
    var name = text(link && link.server_name);
    return name && !/oscar/i.test(name) ? name : "Server";
  }
  function directMedia(url, contentType) {
    if (!isHttpUrl(url)) return false;
    var value = String(url || "").split(/[?#]/)[0];
    var mime = String(contentType || "").toLowerCase();
    if (/text\/html|application\/xhtml\+xml/.test(mime)) return false;
    return /\.(mp4|m3u8|webm|mkv)$/i.test(value) || /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i.test(mime);
  }
  function mediaContentType(contentType) {
    return /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i.test(String(contentType || "").toLowerCase());
  }
  function isHttpUrl(url) { return /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i.test(String(url || "").trim()); }
  function hostOf(url) {
    try { if (typeof URL !== "undefined") return new URL(String(url)).hostname.toLowerCase(); } catch (_) {}
    return String(url || "").replace(/^https?:\/\//i, "").split(/[/:?#]/)[0].toLowerCase();
  }
  function isSeriesMp4(url) {
    var host = hostOf(url);
    return host === "seriesmp4.com" || /\.seriesmp4\.com$/i.test(host);
  }
  function isYandex(url) { var host = hostOf(url); return /(^|\.)yandex\.(ru|net)$/i.test(host); }
  function mediaUa(link) {
    var deep = text(link && link.deep_link);
    var match = /(?:\?|&)(?:ua|user_agent)=([^&]+)/i.exec(deep);
    if (!match) return MEDIA_UA;
    try { return decodeURIComponent(match[1].replace(/\+/g, "%20")) || MEDIA_UA; } catch (_) { return match[1] || MEDIA_UA; }
  }
  function normalizeUrl(base, value) {
    var href = text(value);
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.indexOf("//") === 0) return "https:" + href;
    if (typeof URL !== "undefined") { try { return new URL(href, base).toString(); } catch (_) {} }
    if (href.charAt(0) === "/") return "https://" + hostOf(base) + href;
    return base.replace(/[^/]*$/, "") + href;
  }
  function obviousAd(url) {
    return /(?:\/ads?\/|\/advert(?:isement)?\/|adserver|doubleclick|googlesyndication|(?:^|[/.?&=_-])(?:tracking|analytics|pixel)(?:[/.?&=_-]|$))/i.test(String(url || ""));
  }
  function decodeHtmlAttribute(value) {
    return String(value || "")
      .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, hexValue) { return String.fromCharCode(parseInt(hexValue, 16)); })
      .replace(/&#([0-9]+);/g, function (_, numberValue) { return String.fromCharCode(parseInt(numberValue, 10)); });
  }
  function extractHtmlSources(html, tagPattern) {
    var source = String(html || "");
    var pattern = new RegExp("<(?:" + tagPattern + ")\\b[^>]*\\bsrc\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\s\\\"'=<>`]+))", "gi");
    var values = [];
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var value = decodeHtmlAttribute(match[1] || match[2] || match[3]);
      if (value && values.indexOf(value) < 0) values.push(value);
    }
    return values;
  }
  function extractAbsoluteHttpUrls(html) {
    var source = String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
    var matches = source.match(/https?:\/\/[^\s"'<>`]+/gi) || [];
    var values = [];
    matches.forEach(function (match) {
      var value = decodeHtmlAttribute(match).replace(/[),.\]]+$/, "");
      if (isHttpUrl(value) && values.indexOf(value) < 0) values.push(value);
    });
    return values;
  }
  function htmlResponse(contentType, body) {
    return /text\/html|application\/xhtml\+xml/i.test(String(contentType || "")) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(body || ""));
  }
  function responseAccepted(response) {
    if (!response) return false;
    var status = Number(response.status || 0);
    return response.ok !== false && status >= 200 && status < 300;
  }
  function uniqueResolved(entries) {
    var seen = {};
    return entries.filter(function (entry) {
      var key = entry && entry.url;
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function streamType(url, contentType) {
    return /\.m3u8(?:$|[?#])/i.test(String(url || "")) || /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(String(contentType || ""))
      ? "m3u8" : "video";
  }
  async function resolveWrapper(url, headers, depth, visited) {
    if (!isHttpUrl(url)) return [];
    if (depth > 4) return [];
    visited = visited || {};
    if (visited[url]) return [];
    visited[url] = true;
    var response;
    var requestHeaders = {};
    Object.keys(headers || {}).forEach(function (name) { requestHeaders[name] = headers[name]; });
    // Confirmed SeriesMP4 wrappers reject Range intermittently while their normal GET
    // returns a small HTML page. FetchBridge still caps every response body at 1 MiB.
    // Other targets retain the bounded Range probe used by the hardened resolver.
    var normalSeriesWrapperGet = isSeriesMp4(url) && (depth === 0 || !directMedia(url, ""));
    if (!requestHeaders.Range && !normalSeriesWrapperGet) requestHeaders.Range = "bytes=0-65535";
    try { response = await fetch(url, { method: "GET", headers: requestHeaders, redirect: "follow" }); }
    catch (_) { return []; }
    if (!responseAccepted(response)) return [];
    var finalUrl = response.url || url;
    var contentType = response.headers && response.headers.get ? response.headers.get("content-type") || "" : "";
    if (mediaContentType(contentType)) {
      var mediaHeaders = {};
      Object.keys(headers || {}).forEach(function (name) { mediaHeaders[name] = headers[name]; });
      return [{ url: finalUrl, headers: mediaHeaders, contentType: contentType }];
    }
    var html = "";
    try { html = typeof response.text === "function" ? await response.text() : ""; } catch (_) { return []; }
    if (directMedia(finalUrl, contentType) && !htmlResponse(contentType, html)) {
      var extensionMediaHeaders = {};
      Object.keys(headers || {}).forEach(function (name) { extensionMediaHeaders[name] = headers[name]; });
      return [{ url: finalUrl, headers: extensionMediaHeaders, contentType: contentType }];
    }
    if (isYandex(finalUrl) && !htmlResponse(contentType, html)) return [];
    if (!htmlResponse(contentType, html) && !/<(?:iframe|video|source)\b/i.test(html)) return [];
    var frames = extractHtmlSources(html, "iframe").map(function (src) { return normalizeUrl(finalUrl, src); }).filter(Boolean);
    frames = frames.filter(function (frame) { return !obviousAd(frame); });
    var found = [];
    for (var i = 0; i < frames.length; i++) {
      var frameUrl = frames[i];
      var frameHeaders = { "User-Agent": headers["User-Agent"] || MEDIA_UA };
      // Live S1F evidence shows Yandex rejects the SeriesMP4 Referer with 403,
      // while the same signed target succeeds without it. Keep this policy scoped
      // to a verified SeriesMP4 -> Yandex transition only.
      if (!(isSeriesMp4(finalUrl) && isYandex(frameUrl))) frameHeaders.Referer = finalUrl;
      var nested = await resolveWrapper(frameUrl, frameHeaders, depth + 1, visited);
      found = found.concat(nested);
    }
    if (found.length) return uniqueResolved(found);
    // Bounded site-specific fallback: extract explicit media declarations from the wrapper HTML.
    var mediaSources = extractHtmlSources(html, "video|source");
    for (var mediaIndex = 0; mediaIndex < mediaSources.length; mediaIndex++) {
      var src = mediaSources[mediaIndex];
      var resolved = normalizeUrl(finalUrl, src);
      if (resolved && !obviousAd(resolved) && directMedia(resolved)) {
        var mediaHeaders = { "User-Agent": headers["User-Agent"] || MEDIA_UA };
        if (!(isSeriesMp4(finalUrl) && isYandex(resolved))) mediaHeaders.Referer = finalUrl;
        var media = await resolveWrapper(resolved, mediaHeaders, depth + 1, visited);
        found = found.concat(media);
      }
    }
    if (!found.length && isSeriesMp4(url) && htmlResponse(contentType, html)) {
      // TDM's resolver confirms SeriesMP4 pages can expose an absolute final URL in the body.
      // Keep the fallback host-bounded: only the exact Yandex suffixes already recognized above
      // are followed, and each candidate must pass the same status/MIME/media checks recursively.
      var absoluteUrls = extractAbsoluteHttpUrls(html);
      for (var absoluteIndex = 0; absoluteIndex < absoluteUrls.length; absoluteIndex++) {
        var absoluteUrl = absoluteUrls[absoluteIndex];
        if (!isYandex(absoluteUrl) || obviousAd(absoluteUrl)) continue;
        var absoluteMedia = await resolveWrapper(absoluteUrl, {
          "User-Agent": headers["User-Agent"] || MEDIA_UA
        }, depth + 1, visited);
        found = found.concat(absoluteMedia);
      }
    }
    return uniqueResolved(found);
  }
  async function resolveLink(link) {
    var url = text(link.url);
    if (!isHttpUrl(url)) return [];
    var headers = { "User-Agent": mediaUa(link) };
    if (isSeriesMp4(url) || isYandex(url) || !directMedia(url, "")) {
      var resolved = await resolveWrapper(url, headers, 0);
      return resolved.map(function (entry) {
        return { url: entry.url, headers: entry.headers || headers, title: serverTitle(link),
          provider: "Source", quality: qualityOf(link.quality), type: streamType(entry.url, entry.contentType) };
      });
    }
    return [{ url: url, title: serverTitle(link), provider: "Source",
      quality: qualityOf(link.quality), type: streamType(url, ""), headers: headers }];
  }
  async function resolveLinks(links) {
    var resolvedByIndex = new Array(links.length);
    var nextIndex = 0;
    async function worker() {
      while (true) {
        var index = nextIndex++;
        if (index >= links.length) return;
        try { resolvedByIndex[index] = await resolveLink(links[index]); }
        catch (error) {
          resolvedByIndex[index] = [];
          if (typeof console !== "undefined" && console.warn) console.warn("OscarTV stream resolution failed:", error.message || error);
        }
      }
    }
    var workers = [];
    var workerCount = Math.min(MAX_CONCURRENT_STREAM_RESOLUTIONS, links.length);
    for (var i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
    var streams = [];
    for (var resultIndex = 0; resultIndex < resolvedByIndex.length; resultIndex++) {
      streams = streams.concat(resolvedByIndex[resultIndex] || []);
    }
    return streams;
  }

  async function watchLinksFor(parsed) {
    var links = [];
    if (parsed.type === "movie") {
      links = (await objectData("/api/movies/show.php", { id: parsed.id })).watch_links || [];
    } else if (parsed.type === "anime") {
      links = (await objectData("/api/anime/show.php", { id: parsed.id })).watch_links || [];
    } else if (parsed.type === "series_episode") {
      try { links = (await objectData("/api/episodes/show.php", { id: parsed.id })).watch_links || []; } catch (_) { links = []; }
      if (!links.length) {
        try { links = (await list("/api/watch_links/", { episode_id: parsed.id })).items; } catch (_) { links = []; }
      }
    } else if (parsed.type === "anime_episode") {
      links = (await objectData("/api/anime/episodes/show.php", { id: parsed.id })).watch_links || [];
    } else fail("streams require movie, anime, series_episode, or anime_episode id");
    return Array.isArray(links) ? links : [];
  }
  function streamOption(link, index) {
    var safeLink = {
      url: text(link && link.url),
      deep_link: text(link && link.deep_link) || undefined,
      type: text(link && link.type) || undefined,
      quality: text(link && link.quality) || undefined,
      server_name: text(link && link.server_name) || undefined
    };
    if (!isHttpUrl(safeLink.url)) return null;
    return { token: JSON.stringify({ version: 1, ordinal: Number(index) || 0, link: safeLink }), title: serverTitle(link),
      provider: "Source", quality: qualityOf(link && link.quality), type: text(link && link.type) || undefined };
  }
  function linkFromOptionToken(token) {
    var parsed;
    try { parsed = JSON.parse(String(token || "")); } catch (_) { return null; }
    if (!parsed || parsed.version !== 1 || !parsed.link || !isHttpUrl(parsed.link.url)) return null;
    return parsed.link;
  }
  async function resolveStreamOption(args) {
    parseId(args && args.id);
    var link = linkFromOptionToken(args && args.token);
    if (!link) fail("invalid stream option token");
    return { streams: await resolveLink(link) };
  }
  async function getStreams(args) {
    var parsed = parseId(args && args.id);
    var apiStartedAt = Date.now();
    var links = await watchLinksFor(parsed);
    var apiMs = Date.now() - apiStartedAt;
    if (args && args.mode === "options") {
      var parsingStartedAt = Date.now();
      var options = links.map(streamOption).filter(Boolean);
      return { options: options, timing: { apiMs: apiMs, parsingMs: Date.now() - parsingStartedAt } };
    }
    return { streams: await resolveLinks(links) };
  }

  var plugin = { getCatalog: getCatalog, getDetails: getDetails, getStreams: getStreams,
    resolveStreamOption: resolveStreamOption };
  if (root && root.module) root.module.exports = plugin;
  // The local node:test harness opts in; this property is absent in the Yume runtime.
  if (root && root.__YUME_OSCAR_TESTING__ && root.module) {
    root.module.exports.__test = { parseId: parseId, nativeId: nativeId, deriveIronKey: deriveIronKey,
      sign: sign, signedPath: signedPath, directMedia: directMedia, qualityOf: qualityOf,
      mapMedia: mapMedia, detailsItem: detailsItem, imageUrl: imageUrl, isSeriesMp4: isSeriesMp4,
      externalIdsOf: externalIdsOf,
      getCatalog: getCatalog, catalogConfig: CATALOG_CONFIG, serverTitle: serverTitle,
      normalizeUrl: normalizeUrl, extractHtmlSources: extractHtmlSources,
      extractAbsoluteHttpUrls: extractAbsoluteHttpUrls, isHttpUrl: isHttpUrl, isYandex: isYandex,
      streamType: streamType, resolveWrapper: resolveWrapper, resolveLink: resolveLink,
      resolveLinks: resolveLinks, streamOption: streamOption, linkFromOptionToken: linkFromOptionToken,
      resolveStreamOption: resolveStreamOption };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
