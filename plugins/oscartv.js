/* OscarTV Yume Plugin API v1. No Node/browser-only APIs and no third-party runtime imports. */
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

  function fail(message) { throw new Error("OscarTV: " + message); }
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
    } catch (error) {
      fail("network error for " + path + ": " + (error && error.message ? error.message : String(error)));
    }
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
  function titleOf(item, id) { return optional(item.title_ar) || optional(item.title_en) || optional(item.title_jp) || ("OscarTV #" + id); }
  function genresOf(item) {
    var value = item.genres;
    if (Array.isArray(value)) return value.map(text).filter(Boolean);
    if (typeof value === "string") return value.split(/[,،|]/).map(text).filter(Boolean);
    return [];
  }
  function mapMedia(raw, type) {
    var id = positiveInt(raw && raw.id);
    if (!id) return null;
    return {
      nativeId: nativeId(type, id), type: type, title: titleOf(raw, id),
      originalTitle: optional(raw.title_en) || optional(raw.title_jp) || undefined,
      poster: imageUrl(raw.poster) || undefined, backdrop: imageUrl(raw.banner) || undefined,
      year: positiveInt(raw.release_year) || positiveInt(raw.season_year) || undefined,
      rating: isFinite(Number(raw.rating)) && optional(raw.rating) !== null ? Number(raw.rating) : undefined,
      description: optional(raw.story) || undefined, genres: genresOf(raw)
    };
  }
  function pageHasMore(page) {
    var p = page && page.pagination || {};
    var count = positiveInt(p.page_count) || positiveInt(p.total_pages) || positiveInt(p.last_page);
    var current = positiveInt(p.page) || 1;
    return count ? current < count : false;
  }
  var HOME_CONFIG = [
    { id: "movies", title: "أحدث الأفلام", path: "/api/movies/", type: "movie" },
    { id: "series", title: "أحدث المسلسلات", path: "/api/series/", type: "series" },
    { id: "anime", title: "أحدث الأنمي", path: "/api/anime/", type: "anime" }
  ];
  async function getHome() {
    var pages = await Promise.all(HOME_CONFIG.map(function (section) {
      return list(section.path, { page: 1, limit: 20 }).then(function (result) { return { section: section, result: result }; });
    }));
    return { sections: pages.map(function (entry) {
      return { id: entry.section.id, title: entry.section.title,
        items: entry.result.items.map(function (item) { return mapMedia(item, entry.section.type); }).filter(Boolean),
        hasMore: pageHasMore(entry.result), nextPage: pageHasMore(entry.result) ? "2" : undefined };
    }) };
  }
  async function search(args) {
    var query = text(args && args.query);
    if (!query) return { items: [] };
    var configs = [HOME_CONFIG[2], HOME_CONFIG[0], HOME_CONFIG[1]];
    var results = await Promise.all(configs.map(function (section) {
      return list(section.path, { page: 1, limit: 20, search: query }).then(function (result) { return { section: section, result: result }; });
    }));
    var items = [];
    results.forEach(function (entry) { entry.result.items.forEach(function (raw) { var item = mapMedia(raw, entry.section.type); if (item) items.push(item); }); });
    return { items: items };
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
    if (!item) item = { nativeId: nativeId(type, id), type: type, title: "OscarTV #" + id, genres: [] };
    item.nativeId = nativeId(type, id);
    return { nativeId: item.nativeId, type: item.type, title: item.title,
      originalTitle: item.originalTitle, poster: item.poster, backdrop: item.backdrop,
      description: item.description, year: item.year, rating: item.rating,
      genres: item.genres || [], runtime: positiveInt(raw.runtime) || positiveInt(raw.episode_duration) || undefined };
  }
  function qualityOf(value) {
    var source = text(value);
    var match = /(\d{3,4})\s*p/i.exec(source);
    return match ? match[1] + "p" : (source || undefined);
  }
  function directMedia(url, contentType, declaredType) {
    var value = String(url || "").split(/[?#]/)[0];
    return String(declaredType || "").toLowerCase() === "direct" || /\.(mp4|m3u8|webm|mkv)$/i.test(value) || /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i.test(String(contentType || ""));
  }
  function hostOf(url) {
    try { if (typeof URL !== "undefined") return new URL(String(url)).hostname.toLowerCase(); } catch (_) {}
    return String(url || "").replace(/^https?:\/\//i, "").split(/[/:?#]/)[0].toLowerCase();
  }
  function isSeriesMp4(url) { return hostOf(url) === "cdn.seriesmp4.com"; }
  function isYandex(url) { var host = hostOf(url); return /(^|\.)yandex\.(ru|net)$/i.test(host); }
  function mediaUa(link) {
    var deep = text(link && link.deep_link);
    var match = /(?:\?|&)ua=([^&]+)/i.exec(deep);
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
  function obviousAd(url) { return /(?:\/ads?\/|\/advert(?:isement)?\/|adserver|doubleclick|googlesyndication)/i.test(url); }
  async function resolveWrapper(url, headers, depth) {
    if (depth > 4) return [];
    if (directMedia(url)) return [{ url: url, headers: headers }];
    var response;
    try { response = await fetch(url, { method: "GET", headers: headers, redirect: "follow" }); }
    catch (_) { return []; }
    var finalUrl = response.url || url;
    var contentType = response.headers && response.headers.get ? response.headers.get("content-type") || "" : "";
    if (directMedia(finalUrl, contentType)) return [{ url: finalUrl, headers: headers }];
    if (isYandex(finalUrl)) {
      if (/m3u8|video\//i.test(contentType) || /\.(mp4|m3u8|webm|mkv)(?:$|[?#])/i.test(finalUrl)) return [{ url: finalUrl, headers: headers }];
      return [];
    }
    var html = "";
    try { html = await response.text(); } catch (_) { return []; }
    if (typeof require !== "function") return [];
    var cheerio = require("cheerio");
    var $ = cheerio.load(html);
    var frames = [];
    $("iframe[src]").each(function (_, element) {
      var src = $(element).attr("src");
      var resolved = normalizeUrl(finalUrl, src);
      if (resolved && frames.indexOf(resolved) < 0) frames.push(resolved);
    });
    var cleanFrames = frames.filter(function (frame) { return !obviousAd(frame); });
    if (cleanFrames.length) frames = cleanFrames;
    var found = [];
    for (var i = 0; i < frames.length; i++) {
      var frameUrl = frames[i];
      // The prior resolver treated SeriesMP4 as a wrapper regardless of its URL suffix.
      var nested = await resolveWrapper(frameUrl, { "User-Agent": headers["User-Agent"] || MEDIA_UA, "Referer": finalUrl }, depth + 1);
      found = found.concat(nested);
    }
    if (found.length) return found;
    // Bounded site-specific fallback: extract explicit media declarations from the wrapper HTML.
    var mediaNodes = $("video[src], video source[src], source[src]");
    mediaNodes.each(function (_, element) {
      var src = $(element).attr("src");
      var resolved = normalizeUrl(finalUrl, src);
      if (resolved && directMedia(resolved)) found.push({ url: resolved, headers: { "User-Agent": headers["User-Agent"] || MEDIA_UA, "Referer": finalUrl } });
    });
    return found;
  }
  async function resolveLink(link) {
    var url = text(link.url);
    if (!url) return [];
    var headers = { "User-Agent": mediaUa(link) };
    if (isSeriesMp4(url) || !directMedia(url, "", link.type)) {
      var resolved = await resolveWrapper(url, headers, 0);
      return resolved.map(function (entry) {
        return { url: entry.url, headers: entry.headers || headers, title: text(link.server_name) || "OscarTV",
          provider: "OscarTV", quality: qualityOf(link.quality), type: /\.m3u8(?:$|[?#])/i.test(entry.url) ? "m3u8" : "video" };
      });
    }
    return [{ url: url, title: text(link.server_name) || "OscarTV", provider: "OscarTV",
      quality: qualityOf(link.quality), type: /\.m3u8(?:$|[?#])/i.test(url) ? "m3u8" : "video", headers: headers }];
  }
  async function getStreams(args) {
    var parsed = parseId(args && args.id);
    var links = [];
    if (parsed.type === "movie") {
      links = (await objectData("/api/movies/show.php", { id: parsed.id })).watch_links || [];
    } else if (parsed.type === "series_episode") {
      try { links = (await objectData("/api/episodes/show.php", { id: parsed.id })).watch_links || []; } catch (_) { links = []; }
      if (!links.length) {
        try { links = (await list("/api/watch_links/", { episode_id: parsed.id })).items; } catch (_) { links = []; }
      }
    } else if (parsed.type === "anime_episode") {
      links = (await objectData("/api/anime/episodes/show.php", { id: parsed.id })).watch_links || [];
    } else fail("streams require movie, series_episode, or anime_episode id");
    var streams = [];
    for (var i = 0; i < links.length; i++) {
      try { streams = streams.concat(await resolveLink(links[i])); }
      catch (error) { if (typeof console !== "undefined" && console.warn) console.warn("OscarTV stream resolution failed:", error.message || error); }
    }
    return { streams: streams };
  }

  var plugin = { getHome: getHome, search: search, getDetails: getDetails, getStreams: getStreams };
  if (root && root.module) root.module.exports = plugin;
  // The local node:test harness opts in; this property is absent in the Yume runtime.
  if (root && root.__YUME_OSCAR_TESTING__ && root.module) {
    root.module.exports.__test = { parseId: parseId, nativeId: nativeId, deriveIronKey: deriveIronKey,
      sign: sign, signedPath: signedPath, directMedia: directMedia, qualityOf: qualityOf,
      mapMedia: mapMedia, detailsItem: detailsItem, imageUrl: imageUrl, isSeriesMp4: isSeriesMp4 };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
