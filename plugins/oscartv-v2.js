/* OscarTV Yume Plugin API v2. No Node/browser-only APIs and no third-party runtime imports. */
(function (root) {
  "use strict";

  // Bootstrap from the original OscarTV public domain configuration, then keep
  // the known-working Yume API origin as the final fallback.
  var API_FALLBACK = "https://ostv-11-11.xyz";
  var API = API_FALLBACK;
  var DOMAIN_CONFIG_URLS = [
    "https://raw.githubusercontent.com/MBoshkash/ostv-config/main/domains.json",
    "https://cdn.jsdelivr.net/gh/MBoshkash/ostv-config@main/domains.json"
  ];
  // Key fragments and nonce/tag layout match the original public feed decoder.
  var DOMAIN_CONFIG_KEY_PARTS = ["9f2c4a7e", "1b6d3f8c", "0a5e9b2d", "7f4c1a6e", "8b3d0f5c", "9a2e7b4d", "1f6c8a3e", "0b5d9f2c"];
  var DOMAIN_CONFIG_KEY_SEPARATOR = "";
  var DOMAIN_CONFIG_MAX_CHARS = 16384;
  var MAX_DOMAIN_CANDIDATES = 16;
  var DOMAIN_CONFIG_TIMEOUT_MS = 3000;
  var DOMAIN_PROBE_TIMEOUT_MS = 4000;
  var DOMAIN_DISCOVERY_BUDGET_MS = 20000;
  var MAX_DOMAIN_PROBES = 3;
  var domainCandidatesPromise = null;
  var apiDomainPromise = null;
  var selectedApiDomain = null;
  var PLUGIN_ID = "oscar";
  var CERT_SHA256 = "6e2fcda8631eb49ebcba4ca8ef4c597abe84654c7d3e8096db32bdd21ecf763f";
  var PACKAGE_NAME = "com.drama.mp4";
  var API_UA = "okhttp/4.12.0";
  var serverClockOffsetSeconds = 0;
  var MEDIA_UA = "TDMuaPlayer";
  var MAX_PAGES = 1000;
  var MAX_CONCURRENT_STREAM_RESOLUTIONS = 2;
  var MAX_CONCURRENT_HOME_CATALOGS = 3;
  var MAX_CONCURRENT_DETAIL_SEASONS = 2;
  var MAX_CONCURRENT_EPISODE_PAGES = 2;

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
  function bytesFromWordArray(value) {
    var out = [];
    for (var i = 0; i < value.sigBytes; i++) out.push((value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255);
    return out;
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
    var timestamp = Math.floor(Date.now() / 1000) + serverClockOffsetSeconds;
    var nonce = randomNonce();
    var headers = {
      "Accept": "application/json",
      "User-Agent": API_UA,
      "X-Iron-Sig": sign(url, timestamp, nonce),
      "X-Iron-Ts": String(timestamp),
      "X-Iron-Nonce": nonce
    };
    return headers;
  }
  function syncServerClock(response) {
    var rawDate = response && response.headers && response.headers.get ? response.headers.get("date") : null;
    if (!rawDate) return;
    var serverMillis = Date.parse(rawDate);
    if (!isFinite(serverMillis) || serverMillis <= 0) return;
    var offset = Math.floor(serverMillis / 1000) - Math.floor(Date.now() / 1000);
    // Bound an untrusted response header to one day before it can affect a signature.
    if (Math.abs(offset) <= 86400) serverClockOffsetSeconds = offset;
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
  function decodeDomainConfigPayload(payload) {
    var body = text(payload).replace(/^\uFEFF/, "").trim();
    if (!body) fail("empty OscarTV domain configuration");
    if (body.charAt(0) === "{" || body.charAt(0) === "[") return body;
    if (body.length > DOMAIN_CONFIG_MAX_CHARS || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
      fail("invalid OscarTV domain configuration encoding");
    }
    var encrypted = bytesFromWordArray(CryptoJS.enc.Base64.parse(body));
    if (encrypted.length < 29) fail("encrypted OscarTV domain configuration is too short");
    var nonce = encrypted.slice(0, 12);
    var cipherAndTag = encrypted.slice(12);
    var key = CryptoJS.enc.Hex.parse(DOMAIN_CONFIG_KEY_PARTS.join(DOMAIN_CONFIG_KEY_SEPARATOR));
    var decoded = CryptoJS.AES.decrypt({ ciphertext: wordArray(cipherAndTag) }, key, {
      iv: wordArray(nonce), mode: CryptoJS.mode.GCM, padding: CryptoJS.pad.NoPadding
    });
    return CryptoJS.enc.Utf8.stringify(decoded).trim();
  }
  function normalizeApiDomain(value) {
    if (typeof value !== "string") return null;
    var match = /^https:\/\/([^\/:?#]+)\/?$/i.exec(value.trim());
    if (!match) return null;
    var host = match[1].toLowerCase();
    if (host.length > 253 || host.indexOf(".") < 0) return null;
    var labels = host.split(".");
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(labels[i])) return null;
    }
    return "https://" + host;
  }
  function domainCandidatesFromConfig(value) {
    var config;
    try { config = JSON.parse(decodeDomainConfigPayload(value)); }
    catch (_) { return null; }
    var rawDomains = [];
    if (Array.isArray(config)) {
      rawDomains = config;
    } else if (config && typeof config === "object") {
      if (config.default_domain !== undefined && config.default_domain !== null && text(config.default_domain)) {
        rawDomains.push(config.default_domain);
      }
      if (config.backup_domains !== undefined && config.backup_domains !== null) {
        if (!Array.isArray(config.backup_domains) || config.backup_domains.length > 32) return null;
        rawDomains = rawDomains.concat(config.backup_domains);
      }
    } else {
      return null;
    }
    if (rawDomains.length > 32) return null;
    var domains = [];
    for (var i = 0; i < rawDomains.length; i++) {
      var domain = normalizeApiDomain(rawDomains[i]);
      if (domain && domains.indexOf(domain) < 0) domains.push(domain);
      if (domains.length >= MAX_DOMAIN_CANDIDATES) break;
    }
    if (!domains.length) return null;
    if (domains.indexOf(API_FALLBACK) < 0) {
      if (domains.length >= MAX_DOMAIN_CANDIDATES) domains = domains.slice(0, MAX_DOMAIN_CANDIDATES - 1);
      domains.push(API_FALLBACK);
    }
    return domains;
  }
  function remainingDiscoveryTimeout(deadline, perRequestLimit) {
    var remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) return 0;
    return Math.min(perRequestLimit, remaining);
  }
  function discoveryProbeCandidates(candidates) {
    var selected = [];
    for (var i = 0; i < candidates.length && selected.length < MAX_DOMAIN_PROBES - 1; i++) {
      if (candidates[i] !== API_FALLBACK && selected.indexOf(candidates[i]) < 0) selected.push(candidates[i]);
    }
    selected.push(API_FALLBACK);
    return selected;
  }
  async function loadDomainCandidates(deadline) {
    if (!domainCandidatesPromise) {
      domainCandidatesPromise = (async function () {
        for (var i = 0; i < DOMAIN_CONFIG_URLS.length; i++) {
          var sourceUrl = DOMAIN_CONFIG_URLS[i];
          try {
            var timeoutMs = remainingDiscoveryTimeout(deadline, DOMAIN_CONFIG_TIMEOUT_MS);
            if (!timeoutMs) break;
            var response = await fetch(sourceUrl, {
              method: "GET", headers: { "Accept": "text/plain, application/json" }, redirect: "manual",
              timeoutMs: timeoutMs
            });
            if (!response || !response.ok || response.status !== 200) continue;
            if (response.url && new URL(response.url).origin !== new URL(sourceUrl).origin) continue;
            var body = await response.text();
            if (typeof body !== "string" || body.length > DOMAIN_CONFIG_MAX_CHARS) continue;
            var domains = domainCandidatesFromConfig(body);
            if (domains && domains.length) return domains;
          } catch (_) {
            // Try the fixed jsDelivr mirror if GitHub Raw is unavailable or invalid.
          }
        }
        return [API_FALLBACK];
      })();
    }
    return domainCandidatesPromise;
  }
  function isValidDomainProbe(envelope) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        String(envelope.status || "").toLowerCase() !== "success") return false;
    if (!Array.isArray(envelope.data)) return false;
    return !envelope.pagination || (typeof envelope.pagination === "object" && !Array.isArray(envelope.pagination));
  }
  async function probeApiDomain(domain, deadline) {
    var url = domain + "/api/movies/?page=1&limit=1&sort_by=views_today";
    try {
      var timeoutMs = remainingDiscoveryTimeout(deadline, DOMAIN_PROBE_TIMEOUT_MS);
      if (!timeoutMs) return false;
      var response = await fetch(url, {
        method: "GET", headers: apiHeaders(url), redirect: "manual", timeoutMs: timeoutMs
      });
      syncServerClock(response);
      if (!response || !response.ok) return false;
      return isValidDomainProbe(await response.json());
    } catch (_) {
      return false;
    }
  }
  async function resolveApiDomain() {
    if (selectedApiDomain) return selectedApiDomain;
    if (!apiDomainPromise) {
      apiDomainPromise = (async function () {
        // Older hosts ignore timeoutMs and cannot safely run speculative discovery.
        if (typeof fetch !== "function" || fetch.supportsNativeTimeout !== true) {
          selectedApiDomain = API_FALLBACK;
          API = selectedApiDomain;
          return selectedApiDomain;
        }
        var deadline = Date.now() + DOMAIN_DISCOVERY_BUDGET_MS;
        var candidates = discoveryProbeCandidates(await loadDomainCandidates(deadline));
        for (var i = 0; i < candidates.length; i++) {
          if (remainingDiscoveryTimeout(deadline, DOMAIN_PROBE_TIMEOUT_MS) <= 0) break;
          if (await probeApiDomain(candidates[i], deadline)) {
            selectedApiDomain = candidates[i];
            API = selectedApiDomain;
            return selectedApiDomain;
          }
        }
        selectedApiDomain = API_FALLBACK;
        API = selectedApiDomain;
        return selectedApiDomain;
      })();
    }
    return apiDomainPromise;
  }
  async function waitForRetry(milliseconds) {
    if (typeof setTimeout !== "function") return;
    await new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }
  async function request(path, query) {
    await resolveApiDomain();
    var url = buildUrl(path, query);
    if (url.indexOf(API + "/") !== 0) fail("refusing to send API headers to an unrelated host");
    var response = null;
    var networkFailure = false;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        // Signing is performed locally using the compatibility implementation
        // covered by the deterministic reference vector; no external signer sees URLs.
        // Keep redirects manual so request signatures are never forwarded to another host.
        response = await fetch(url, { method: "GET", headers: apiHeaders(url), redirect: "manual" });
        syncServerClock(response);
        networkFailure = false;
      } catch (_) {
        response = null;
        networkFailure = true;
      }
      var retryableStatus = response && [502, 503, 504].indexOf(Number(response.status)) >= 0;
      if (attempt >= 2 || (!networkFailure && !retryableStatus)) break;
      await waitForRetry(attempt === 0 ? 500 : 1000);
    }
    if (networkFailure) fail("Oscar API network error for " + path);
    if (!response || !response.ok) fail("HTTP " + (response ? response.status : "no response") + " for " + path);
    var envelope;
    try { envelope = await response.json(); } catch (error2) { fail("invalid JSON for " + path); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("invalid JSON for " + path);
    if (!envelope || String(envelope.status || "").toLowerCase() !== "success") {
      fail("API status failure for " + path + ": " + text(envelope && (envelope.message || envelope.error) || "unknown"));
    }
    return envelope;
  }
  async function list(path, query) {
    var envelope = await request(path, query);
    var data = envelope.data;
    var items = Array.isArray(data) ? data : data && (data.items || data.results) || envelope.items || envelope.results;
    if (!Array.isArray(items)) fail("expected list data at " + path);
    return { items: items, pagination: normalizePagination(envelope.pagination || envelope.meta || data && data.pagination || {}) };
  }
  async function objectData(path, query) {
    var envelope = await request(path, query);
    var data = envelope.data;
    if (data && typeof data === "object" && !Array.isArray(data) && data.data && typeof data.data === "object" && !Array.isArray(data.data)) data = data.data;
    if ((!data || typeof data !== "object" || Array.isArray(data)) && envelope.result && typeof envelope.result === "object") data = envelope.result;
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("expected object data at " + path);
    return data;
  }
  function firstPositive(source, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = positiveInt(source && source[keys[i]]);
      if (value) return value;
    }
    return null;
  }
  function normalizePagination(value) {
    var p = value && typeof value === "object" ? value : {};
    var normalized = {};
    var page = firstPositive(p, ["page", "current_page", "currentPage"]);
    var count = firstPositive(p, ["page_count", "total_pages", "totalPages", "last_page", "lastPage", "pages"]);
    var total = firstPositive(p, ["total", "total_items", "totalItems"]);
    var limit = firstPositive(p, ["per_page", "perPage", "limit", "page_size", "pageSize"]);
    if (page) normalized.page = page;
    if (count) normalized.page_count = count;
    if (total) normalized.total = total;
    if (limit) normalized.per_page = limit;
    return normalized;
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
      poster: imageUrl(raw.poster) || undefined, backdrop: imageUrl(raw.banner || raw.bg_image) || undefined,
      logo: imageUrl(raw.logo || raw.logo_image) || undefined,
      year: positiveInt(raw.release_year) || positiveInt(raw.season_year) || undefined,
      rating: isFinite(Number(raw.rating)) && optional(raw.rating) !== null ? Number(raw.rating) : undefined,
      externalIds: externalIdsOf(raw),
      description: optional(raw.story) || undefined, genres: genresOf(raw)
    };
  }
  function pageCount(page) {
    var p = normalizePagination(page && page.pagination || {});
    return positiveInt(p.page_count) || null;
  }
  var CATALOG_CONFIG = [
    { id: "movies", path: "/api/movies/", type: "movie" },
    { id: "series", path: "/api/series/", type: "series" },
    { id: "movies_top", path: "/api/movies/", type: "movie", query: { sort_by: "views_today" } },
    { id: "foreign_movies", path: "/api/movies/", type: "movie", query: { category: 18, sort_by: "newest" } },
    { id: "foreign_series", path: "/api/series/", type: "series", query: { category: 4, sort_by: "most_viewed" } },
    { id: "foreign_latest", path: "/api/series/", type: "series", query: { category: 4, sort_by: "newest" } },
    { id: "foreign_airing", path: "/api/series/", type: "series", query: { category: 4, status: "ongoing", sort_by: "latest_episode" } },
    { id: "asian_series", path: "/api/series/", type: "series", query: { category: 5, sort_by: "most_viewed" } },
    { id: "asian_latest", path: "/api/series/", type: "series", query: { category: 5, sort_by: "newest" } },
    { id: "asian_airing", path: "/api/series/", type: "series", query: { category: 5, status: "ongoing", sort_by: "latest_episode" } },
    { id: "anime_picks", path: "/api/anime/", type: "anime", query: { sort_by: "rating" } },
    { id: "anime", path: "/api/anime/", type: "anime", query: { sort_by: "newest" } },
    { id: "anime_movies", path: "/api/anime/", type: "anime", query: { anime_type: "movie", sort_by: "newest" } },
    { id: "anime_series", path: "/api/anime/", type: "anime", query: { anime_type: "tv,ova,ona,special", sort_by: "newest" } }
  ];
  var CATALOG_FILTER_KEYS = {
    movie: ["status", "year", "country", "genre_id", "language", "category", "content_type", "age_rating",
      "collection_id", "quality_source", "has_links", "featured", "awards", "sort_by"],
    series: ["status", "year", "country", "genre_id", "language", "is_colored", "sort_by", "age_rating",
      "type", "category", "content_type"],
    anime: ["anime_type", "studio_id", "genre_id", "status", "season_period", "season_year", "year",
      "content_type", "age_rating", "featured", "sort_by"]
  };
  var CATALOG_FILTER_CONFIG = {
    movies: {
      path: "/api/movies/filters.php",
      fields: [
        ["category", "فئة الفيلم", "categories"], ["genre_id", "النوع الفني", "genres"],
        ["year", "السنة", "years"], ["country", "الدولة", "countries"],
        ["language", "اللغة", "languages"], ["quality_source", "المصدر", "sources"],
        ["content_type", "نوع المحتوى", "content_types"], ["age_rating", "التصنيف العمري", "age_ratings"],
        ["status", "الحالة", "statuses"], ["awards", "الجوائز", "awards"],
        ["sort_by", "الترتيب", "sort_options"]
      ]
    },
    series: {
      path: "/api/series/filters.php",
      fields: [
        ["category", "فئة المسلسل", "categories"], ["genre_id", "النوع الفني", "genres", ["category"]],
        ["year", "السنة", "years", ["category"]], ["country", "الدولة", "countries", ["category"]],
        ["language", "اللغة", "languages", ["category"]], ["status", "الحالة", "statuses", ["category"]],
        ["content_type", "نوع المحتوى", "content_types", ["category"]],
        ["age_rating", "التصنيف العمري", "age_ratings", ["category"]]
      ]
    },
    anime_movies: {
      path: "/api/anime/filters.php",
      fields: [
        ["genre_id", "النوع الفني", "genres"], ["studio_id", "الاستوديو", "studios"],
        ["status", "الحالة", "statuses"], ["season_period", "الموسم", "season_periods"],
        ["season_year", "سنة الموسم", "season_years"], ["year", "السنة", "years"],
        ["content_type", "نوع المحتوى", "content_types"], ["age_rating", "التصنيف العمري", "age_ratings"]
      ]
    },
    anime_series: {
      path: "/api/anime/filters.php",
      fields: [
        ["genre_id", "النوع الفني", "genres"], ["studio_id", "الاستوديو", "studios"],
        ["status", "الحالة", "statuses"], ["season_period", "الموسم", "season_periods"],
        ["season_year", "سنة الموسم", "season_years"], ["year", "السنة", "years"],
        ["content_type", "نوع المحتوى", "content_types"], ["age_rating", "التصنيف العمري", "age_ratings"]
      ]
    }
  };
  var KNOWN_FILTER_LABELS = {
    arabic: "مسلسلات عربية",
    turkish_series: "المسلسلات التركية",
    foreign_series: "المسلسلات الأجنبية",
    asian_series: "المسلسلات الآسيوية",
    talk_show: "البرامج الحوارية"
  };
  function humanizeFilterLabel(value, localizeKnownCategory) {
    var normalized = optional(value);
    if (!normalized) return null;
    var mapped = localizeKnownCategory ? KNOWN_FILTER_LABELS[normalized.toLowerCase()] : null;
    if (mapped) return mapped;
    return normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/\b[a-z]/g, function (letter) {
      return letter.toUpperCase();
    });
  }
  function filterDisplayLabel(raw, value, filterKey) {
    var localizeKnownCategory = filterKey === "category";
    var arabicLabelKeys = ["title_ar", "name_ar", "label", "title", "name"];
    for (var i = 0; i < arabicLabelKeys.length; i++) {
      var candidate = optional(raw[arabicLabelKeys[i]]);
      if (candidate && /[\u0600-\u06ff]/.test(candidate)) return candidate;
    }
    var knownKeys = ["slug", "code", "value", "key", "name", "title", "label", "id"];
    for (var j = 0; j < knownKeys.length; j++) {
      var knownValue = optional(raw[knownKeys[j]]);
      if (localizeKnownCategory && knownValue && KNOWN_FILTER_LABELS[knownValue.toLowerCase()]) {
        return KNOWN_FILTER_LABELS[knownValue.toLowerCase()];
      }
    }
    var labelKeys = ["title_ar", "name_ar", "label", "title", "name", "value", "key", "code", "slug", "id"];
    for (var k = 0; k < labelKeys.length; k++) {
      var labelValue = optional(raw[labelKeys[k]]);
      if (labelValue) return humanizeFilterLabel(labelValue, localizeKnownCategory);
    }
    return humanizeFilterLabel(value, localizeKnownCategory);
  }
  function filterOption(raw, filterKey) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      var primitive = optional(raw);
      return primitive ? { value: primitive, label: humanizeFilterLabel(primitive, filterKey === "category") || primitive } : null;
    }
    var valueKeys = ["value", "key", "code", "id", "slug", "name"];
    var value = null;
    for (var i = 0; i < valueKeys.length && !value; i++) value = optional(raw[valueKeys[i]]);
    var label = filterDisplayLabel(raw, value, filterKey);
    if (!value || !label || value.length > 128 || label.length > 160) return null;
    return { value: value, label: label };
  }
  function filterOptions(raw, filterKey) {
    if (!Array.isArray(raw)) return [];
    var seen = {};
    return raw.map(function (entry) { return filterOption(entry, filterKey); }).filter(function (entry) {
      if (!entry || seen[entry.value]) return false;
      seen[entry.value] = true;
      return true;
    }).slice(0, 500);
  }
  async function getCatalogFilters(args) {
    args = args || {};
    var config = CATALOG_FILTER_CONFIG[args.catalogId];
    var catalog = null;
    for (var i = 0; i < CATALOG_CONFIG.length; i++) {
      if (CATALOG_CONFIG[i].id === args.catalogId) { catalog = CATALOG_CONFIG[i]; break; }
    }
    if (!catalog || !config) fail("catalog does not provide dynamic filters");
    if (args.contentType !== catalog.type) fail("catalog filter type mismatch");
    var selected = args.selectedFilters && typeof args.selectedFilters === "object" ? args.selectedFilters : {};
    var query = {};
    if (args.catalogId === "series" && /^(4|5)$/.test(String(selected.category || ""))) {
      query.category = String(selected.category);
    }
    var data = await objectData(config.path, query);
    return {
      catalogId: catalog.id,
      filters: config.fields.map(function (definition) {
        return {
          key: definition[0], kind: "select", label: definition[1], required: false, dynamic: true,
          dependsOn: definition[3] || [], options: filterOptions(data[definition[2]], definition[0])
        };
      })
    };
  }
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
    var query = {};
    Object.keys(catalog.query || {}).forEach(function (key) { query[key] = catalog.query[key]; });
    var allowedFilters = CATALOG_FILTER_KEYS[catalog.type] || [];
    var filters = args.filters && typeof args.filters === "object" ? args.filters : {};
    Object.keys(filters).forEach(function (key) {
      if (allowedFilters.indexOf(key) < 0) return;
      var value = filters[key];
      if (value === undefined || value === null) return;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
      var normalizedValue = String(value).trim();
      if (!normalizedValue || normalizedValue.length > 128 || /[\u0000-\u001f\u007f]/.test(normalizedValue)) return;
      query[key] = normalizedValue;
    });
    query.page = pageNo;
    query.limit = limit;
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
  var SEARCH_CONFIG = [
    { id: "movies", path: "/api/movies/", type: "movie" },
    { id: "series", path: "/api/series/", type: "series" },
    { id: "anime_movies", path: "/api/anime/", type: "anime", query: { anime_type: "movie" } },
    { id: "anime_series", path: "/api/anime/", type: "anime", query: { anime_type: "tv,ova,ona,special" } }
  ];
  async function search(args) {
    args = args || {};
    var queryText = String(args.query == null ? "" : args.query).trim();
    if (!queryText) fail("search query is required");
    var group = null;
    for (var i = 0; i < SEARCH_CONFIG.length; i++) {
      if (SEARCH_CONFIG[i].id === args.groupId) { group = SEARCH_CONFIG[i]; break; }
    }
    if (!group) fail("unknown search group");
    var pageNo = 1;
    if (args.cursor !== undefined && args.cursor !== null) {
      var cursor = String(args.cursor);
      if (!/^[1-9][0-9]{0,3}$/.test(cursor) || Number(cursor) > MAX_PAGES) fail("invalid page cursor");
      pageNo = Number(cursor);
    }
    var limit = args.limit === undefined || args.limit === null ? 20 : Number(args.limit);
    if (!isFinite(limit) || Math.floor(limit) !== limit || limit < 1 || limit > 100) fail("invalid page limit");
    var searchQuery = { search: queryText, page: pageNo, limit: limit };
    Object.keys(group.query || {}).forEach(function (key) { searchQuery[key] = group.query[key]; });
    var result = await list(group.path, searchQuery);
    var current = positiveInt(result.pagination.page) || pageNo;
    var pages = catalogPageCount(result);
    var hasMore = !!pages && current < pages && current < MAX_PAGES;
    var total = positiveInt(result.pagination.total);
    return {
      groupId: group.id,
      items: result.items.map(function (item) { return mapMedia(item, group.type); }).filter(Boolean),
      page: { nextCursor: hasMore ? String(current + 1) : null, hasMore: hasMore, total: total || undefined }
    };
  }
  var HOME_CATALOGS = [
    { id: "movies_top", title: "رائج اليوم", type: "movie" },
    { id: "foreign_movies", title: "أفلام أجنبية", type: "movie" },
    { id: "foreign_series", title: "مسلسلات أجنبية", type: "series" },
    { id: "foreign_latest", title: "أحدث الأجنبي", type: "series" },
    { id: "foreign_airing", title: "يعرض الآن", type: "series" },
    { id: "asian_series", title: "مسلسلات آسيوية", type: "series" },
    { id: "asian_latest", title: "أحدث الآسيوي", type: "series" },
    { id: "asian_airing", title: "يعرض الآن آسيوي", type: "series" },
    { id: "anime_picks", title: "اخترنا لك", type: "anime" },
    { id: "anime", title: "أحدث الأنمي", type: "anime" },
    { id: "anime_movies", title: "أفلام أنمي", type: "anime" }
  ];
  function usableCardPoster(value) {
    if (typeof value !== "string") return false;
    var url = value.trim();
    if (!url || url === "[object Object]" || /\s/.test(url)) return false;
    if (!/^https?:\/\/[^/]+\/[^?#\s]+/i.test(url)) return false;
    return !/^https?:\/\/[^/]+\/(?:javascript|data|file):/i.test(url);
  }
  async function getHome() {
    var sections = new Array(HOME_CATALOGS.length);
    var nextCatalogIndex = 0;
    async function loadNextCatalog() {
      while (true) {
        var index = nextCatalogIndex++;
        if (index >= HOME_CATALOGS.length) return;
        var catalog = HOME_CATALOGS[index];
        try {
          var page = await getCatalog({ catalogId: catalog.id, type: catalog.type, limit: 18, filters: {} });
          var items = page.items.filter(function (item) { return usableCardPoster(item.poster); });
          // Hide a row when its source page is mostly unusable for the portrait card layout.
          if (items.length === 0 || items.length * 2 < page.items.length) continue;
          sections[index] = {
            id: catalog.id,
            title: catalog.title,
            items: items,
            hasMore: page.page.hasMore,
            nextPage: page.page.nextCursor || undefined
          };
        } catch (_) {
          // A failed catalog must not hide healthy Home rows.
          sections[index] = null;
        }
      }
    }
    var workerCount = Math.min(MAX_CONCURRENT_HOME_CATALOGS, HOME_CATALOGS.length);
    var workers = [];
    for (var workerIndex = 0; workerIndex < workerCount; workerIndex++) workers.push(loadNextCatalog());
    await Promise.all(workers);
    return { sections: sections.filter(Boolean) };
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
  async function fetchAllEpisodes(path, seasonId, type, seasonNumber, poster) {
    var first = await list(path, { season_id: seasonId, per_page: 100, page: 1 });
    var pages = positiveInt(first.pagination.page_count) || positiveInt(first.pagination.total_pages) || positiveInt(first.pagination.last_page) || 1;
    pages = Math.max(1, Math.min(pages, MAX_PAGES));
    var all = first.items.slice();
    // Keep each season's episode-page fanout small; getDetails processes only
    // two seasons at a time, limiting the combined page burst to four requests.
    for (var start = 2; start <= pages; start += MAX_CONCURRENT_EPISODE_PAGES) {
      var jobs = [];
      for (var page = start; page < start + MAX_CONCURRENT_EPISODE_PAGES && page <= pages; page++) {
        (function (pageNo) { jobs.push(list(path, { season_id: seasonId, per_page: 100, page: pageNo }).catch(function () { return null; })); })(page);
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
    for (var i = 0; i < seasons.length; i += MAX_CONCURRENT_DETAIL_SEASONS) {
      var seasonGroup = seasons.slice(i, i + MAX_CONCURRENT_DETAIL_SEASONS);
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
        return !!playbackTarget(link);
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
  function queryParameter(uri, name) {
    var question = String(uri || "").indexOf("?");
    if (question < 0) return null;
    var query = String(uri).slice(question + 1).split("#")[0].split("&");
    for (var i = 0; i < query.length; i++) {
      var equals = query[i].indexOf("=");
      if (equals < 0) continue;
      var key = query[i].slice(0, equals);
      var value = query[i].slice(equals + 1);
      try { key = decodeURIComponent(key.replace(/\+/g, "%20")); } catch (_) {}
      if (key !== name) continue;
      try { value = decodeURIComponent(value.replace(/\+/g, "%20")); } catch (_) { return null; }
      return value;
    }
    return null;
  }
  function safeHeaderValue(value, maxLength) {
    var result = text(value).trim();
    if (!result || result.length > maxLength || /[\x00-\x1f\x7f]/.test(result)) return null;
    return result;
  }
  function safeHttpUrl(value) {
    var url = text(value).trim();
    if (!isHttpUrl(url)) return null;
    try {
      var parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
      parsed.hash = "";
      return parsed.toString();
    } catch (_) { return url; }
  }
  function originOf(value) {
    try {
      var parsed = new URL(String(value || ""));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed.origin.toLowerCase();
    } catch (_) {
      var match = /^(https?):\/\/([^/?#]+)/i.exec(String(value || "").trim());
      if (!match) return null;
      return match[1].toLowerCase() + "://" + match[2].toLowerCase();
    }
  }
  function sameOrigin(left, right) {
    var leftOrigin = originOf(left);
    var rightOrigin = originOf(right);
    return !!leftOrigin && leftOrigin === rightOrigin;
  }
  function playbackMetadata(link, targetUrl) {
    var deep = text(link && link.deep_link);
    var rawUa = queryParameter(deep, "ua") || queryParameter(deep, "user_agent");
    var userAgent = safeHeaderValue(rawUa, 1024) || MEDIA_UA;
    var metadata = { "User-Agent": userAgent };
    var mediaUrl = text(link && link.url);
    // Oscar's playback metadata is carried beside the URL in deep_link. Keep
    // session headers bound to the WatchLink URL's origin; a TDM URL on a
    // different origin must not inherit that Cookie.
    if (sameOrigin(targetUrl, mediaUrl)) {
      var cookie = safeHeaderValue(queryParameter(deep, "cookies"), 8192);
      var referer = safeHttpUrl(queryParameter(deep, "referer") || queryParameter(deep, "ref"));
      if (cookie) metadata.Cookie = cookie;
      if (referer) metadata.Referer = referer;
    }
    return metadata;
  }
  function tdmVideoUrl(uri) {
    if (!/^tdmvideo:\/\//i.test(String(uri || ""))) return null;
    var embedded = queryParameter(uri, "url");
    return isHttpUrl(embedded) ? embedded : null;
  }
  function playbackTarget(link) {
    var url = text(link && link.url);
    var deep = text(link && link.deep_link);
    var type = text(link && link.type).toLowerCase();
    var tdmUrl = tdmVideoUrl(deep);
    // Oscar's WatchLink.url is the player candidate; deep_link may carry the
    // TDM URL and request metadata. This follows the upstream CDN-cookie fix.
    if (type === "direct" && isHttpUrl(url)) return { url: url, source: "url" };
    if (tdmUrl) return { url: tdmUrl, source: "deep_link.url" };
    // Oscar hands embed-like sources to ACTION_VIEW. A plain HTTP(S) deep link
    // can be resolved by Yume's bounded wrapper resolver, while direct links keep
    // their media URL unless the deep link itself is recognized as media.
    if (/^(embed|iframe|wrapper|external|web)$/.test(type) && isHttpUrl(deep)) {
      return { url: deep, source: "deep_link-http" };
    }
    if (type === "direct" && isHttpUrl(deep) && directMedia(deep, "")) {
      return { url: deep, source: "deep_link-media" };
    }
    if (isHttpUrl(url)) return { url: url, source: "url" };
    if (isHttpUrl(deep)) return { url: deep, source: "deep_link-http-fallback" };
    return null;
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
  async function boundedResponseText(response, maxBytes) {
    var limit = positiveInt(maxBytes) || 1048576;
    var body = response && response.body;
    if (body && typeof body.getReader === "function" && typeof TextDecoder !== "undefined") {
      var reader = body.getReader();
      var chunks = [];
      var total = 0;
      try {
        while (total < limit) {
          var part = await reader.read();
          if (part.done) break;
          var bytes = part.value || new Uint8Array(0);
          var remaining = limit - total;
          var accepted = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
          chunks.push(accepted);
          total += accepted.length;
          if (accepted.length < bytes.length) break;
        }
      } finally {
        if (total >= limit && reader.cancel) {
          try { await reader.cancel(); } catch (_) {}
        }
      }
      var merged = new Uint8Array(total);
      var offset = 0;
      chunks.forEach(function (chunk) { merged.set(chunk, offset); offset += chunk.length; });
      return new TextDecoder("utf-8").decode(merged);
    }
    // Yume's fetch bridge caps text response bodies. This fallback keeps the
    // same character bound for runtimes that do not expose a Web ReadableStream.
    try { return String(await response.text()).slice(0, limit); } catch (_) { return ""; }
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
    var html = await boundedResponseText(response, 1048576);
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
    var selected = playbackTarget(link);
    if (!selected) return [];
    var url = selected.url;
    var headers = playbackMetadata(link, url);
    var resolverHeaders = { "User-Agent": headers["User-Agent"] };
    if (isSeriesMp4(url) || isYandex(url) || !directMedia(url, "")) {
      // Do not put session cookies or provider Referer values on wrapper
      // requests: fetch may follow redirects before the final media origin is known.
      var resolved = await resolveWrapper(url, resolverHeaders, 0);
      return resolved.map(function (entry) {
        var mediaHeaders = {};
        Object.keys(entry.headers || resolverHeaders).forEach(function (name) {
          mediaHeaders[name] = (entry.headers || resolverHeaders)[name];
        });
        mediaHeaders["User-Agent"] = headers["User-Agent"];
        if (sameOrigin(url, entry.url)) {
          if (headers.Cookie) mediaHeaders.Cookie = headers.Cookie;
          if (headers.Referer) mediaHeaders.Referer = headers.Referer;
        } else {
          delete mediaHeaders.Cookie;
        }
        return { url: entry.url, headers: mediaHeaders, title: serverTitle(link),
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
  function streamOption(link, index, sourceNativeId) {
    var selected = playbackTarget(link);
    if (!selected) return null;
    var watchLinkId = positiveInt(link && link.id);
    if (watchLinkId) {
      // Keep signed URLs out of new option tokens. The selected action will
      // fetch a fresh WatchLink and match its stable provider ID.
      var identifiedLink = {
        watch_link_id: watchLinkId,
        source_ordinal: Number(index) || 0,
        selected_field: selected.source,
        type: text(link && link.type) || undefined,
        quality: text(link && link.quality) || undefined,
        server_name: text(link && link.server_name) || undefined
      };
      return { token: JSON.stringify({ version: 3, nativeId: sourceNativeId, link: identifiedLink }), title: serverTitle(link),
        provider: "Source", quality: qualityOf(link && link.quality), type: text(link && link.type) || undefined };
    }
    if (sourceNativeId) {
      var fallbackIdentity = {
        source_ordinal: Number(index) || 0,
        selected_field: selected.source,
        server_name: text(link && link.server_name) || undefined,
        type: text(link && link.type) || undefined,
        quality: text(link && link.quality) || undefined
      };
      if (!fallbackIdentity.server_name && !fallbackIdentity.type && !fallbackIdentity.quality) return null;
      return { token: JSON.stringify({ version: 4, nativeId: sourceNativeId, link: fallbackIdentity }), title: serverTitle(link),
        provider: "Source", quality: qualityOf(link && link.quality), type: text(link && link.type) || undefined };
    }
    // Retain the internal legacy helper path for old v1/v2 tokens. Production
    // option lists always provide sourceNativeId and use the refreshable v3/v4 forms.
    var safeLink = {
      url: text(link && link.url),
      deep_link: text(link && link.deep_link) || undefined,
      selected_url: selected.url,
      selected_field: selected.source,
      type: text(link && link.type) || undefined,
      quality: text(link && link.quality) || undefined,
      server_name: text(link && link.server_name) || undefined
    };
    return { token: JSON.stringify({ version: 2, ordinal: Number(index) || 0, link: safeLink }), title: serverTitle(link),
      provider: "Source", quality: qualityOf(link && link.quality), type: text(link && link.type) || undefined };
  }
  function linkFromOptionToken(token) {
    var parsed;
    try { parsed = JSON.parse(String(token || "")); } catch (_) { return null; }
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !parsed.link) return null;
    // Recompute from the original fields so older v1 options remain usable and
    // a serialized selected_url cannot turn a custom scheme into a media URL.
    var selected = playbackTarget(parsed.link);
    if (!selected) return null;
    var link = {};
    Object.keys(parsed.link).forEach(function (key) { link[key] = parsed.link[key]; });
    link.url = selected.url;
    return link;
  }
  async function resolveStreamOption(args) {
    var parsedId = parseId(args && args.id);
    var parsedToken;
    try { parsedToken = JSON.parse(String(args && args.token || "")); } catch (_) { parsedToken = null; }
    if (parsedToken && parsedToken.version === 3) {
      var expectedNativeId = nativeId(parsedId.type, parsedId.id);
      var selectedLinkId = positiveInt(parsedToken.link && parsedToken.link.watch_link_id);
      if (parsedToken.nativeId !== expectedNativeId || !selectedLinkId) fail("invalid stream option identity");
      var freshLinks = await watchLinksFor(parsedId);
      var freshLink = freshLinks.find(function (entry) { return positiveInt(entry && entry.id) === selectedLinkId; });
      if (!freshLink) fail("selected WatchLink changed; refresh the stream list");
      return { streams: await resolveLink(freshLink) };
    }
    if (parsedToken && parsedToken.version === 4) {
      var expectedNativeIdWithoutLink = nativeId(parsedId.type, parsedId.id);
      if (parsedToken.nativeId !== expectedNativeIdWithoutLink) fail("invalid stream option identity");
      var identity = parsedToken.link || {};
      var sourceOrdinal = Number(identity.source_ordinal);
      if (!isFinite(sourceOrdinal) || sourceOrdinal < 0 || Math.floor(sourceOrdinal) !== sourceOrdinal) {
        fail("invalid stream option identity");
      }
      var refreshedLinks = await watchLinksFor(parsedId);
      var freshMatches = refreshedLinks.filter(function (entry) {
        return text(entry && entry.server_name) === text(identity.server_name) &&
          text(entry && entry.type) === text(identity.type) &&
          text(entry && entry.quality) === text(identity.quality);
      });
      if (freshMatches.length !== 1) {
        fail("selected WatchLink changed or is ambiguous at source ordinal " + sourceOrdinal + "; refresh the stream list");
      }
      return { streams: await resolveLink(freshMatches[0]) };
    }
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
      var sourceNativeId = nativeId(parsed.type, parsed.id);
      var options = links.map(function (link, index) { return streamOption(link, index, sourceNativeId); }).filter(Boolean);
      return { options: options, timing: { apiMs: apiMs, parsingMs: Date.now() - parsingStartedAt } };
    }
    return { streams: await resolveLinks(links) };
  }

  var plugin = { getHome: getHome, getCatalog: getCatalog, getCatalogFilters: getCatalogFilters, search: search,
    getDetails: getDetails, getStreams: getStreams, resolveStreamOption: resolveStreamOption };
  if (root && root.module) root.module.exports = plugin;
  // The local node:test harness opts in; this property is absent in the Yume runtime.
  if (root && root.__YUME_OSCAR_TESTING__ && root.module) {
    root.module.exports.__test = { parseId: parseId, nativeId: nativeId, deriveIronKey: deriveIronKey,
      sign: sign, signedPath: signedPath, apiHeaders: apiHeaders, clockOffset: function () { return serverClockOffsetSeconds; },
      decodeDomainConfigPayload: decodeDomainConfigPayload, domainCandidatesFromConfig: domainCandidatesFromConfig,
      loadDomainCandidates: loadDomainCandidates, discoveryProbeCandidates: discoveryProbeCandidates,
      remainingDiscoveryTimeout: remainingDiscoveryTimeout, resolveApiDomain: resolveApiDomain,
      discoveryPolicy: { configTimeoutMs: DOMAIN_CONFIG_TIMEOUT_MS, probeTimeoutMs: DOMAIN_PROBE_TIMEOUT_MS,
        budgetMs: DOMAIN_DISCOVERY_BUDGET_MS, maxProbes: MAX_DOMAIN_PROBES },
      apiDomain: function () { return API; }, selectedApiDomain: function () { return selectedApiDomain; },
      directMedia: directMedia, qualityOf: qualityOf,
      mapMedia: mapMedia, detailsItem: detailsItem, imageUrl: imageUrl, isSeriesMp4: isSeriesMp4,
      externalIdsOf: externalIdsOf,
      getHome: getHome, homeCatalogs: HOME_CATALOGS, getCatalog: getCatalog,
      getCatalogFilters: getCatalogFilters, catalogConfig: CATALOG_CONFIG, catalogFilterConfig: CATALOG_FILTER_CONFIG,
      search: search, searchConfig: SEARCH_CONFIG, serverTitle: serverTitle,
      normalizeUrl: normalizeUrl, extractHtmlSources: extractHtmlSources,
      extractAbsoluteHttpUrls: extractAbsoluteHttpUrls, isHttpUrl: isHttpUrl, isYandex: isYandex,
      streamType: streamType, queryParameter: queryParameter, tdmVideoUrl: tdmVideoUrl, playbackTarget: playbackTarget,
      normalizePagination: normalizePagination, boundedResponseText: boundedResponseText,
      resolveWrapper: resolveWrapper, resolveLink: resolveLink,
      resolveLinks: resolveLinks, streamOption: streamOption, linkFromOptionToken: linkFromOptionToken,
      resolveStreamOption: resolveStreamOption };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
