(function (root) {
  "use strict";

  var PLUGIN_ID = "cimacloud";
  var CONFIG_URL = "https://cloud-day.online/v1.4/CloudDay/uploads/config_v1.4.json";
  var FALLBACK_BASE = "https://1654865.xyz";
  var API_PATH = "/v1.3/api/";
  var USER_AGENT = "okhttp/4.10.0";
  var REQUEST_TIMEOUT_MS = 15000;
  var MAX_BODY_CHARS = 3000000;
  var MAX_ITEMS = 100;
  var MAX_EPISODES = 1500;
  var MAX_PAGES = 1000;
  var cachedBase = null;

  var CATALOGS = {
    "latest-movies": { type: "movie", apiType: "1", category: null },
    "latest-series": { type: "series", apiType: "2", category: null },
    "foreign-movies": { type: "movie", apiType: "1", category: "4" },
    "foreign-series": { type: "series", apiType: "2", category: "3" },
    "turkish-series": { type: "series", apiType: "2", category: "1" },
    "korean-series": { type: "series", apiType: "2", category: "7" },
    "anime-series": { type: "series", apiType: "2", category: "5" },
    "indian-series": { type: "series", apiType: "2", category: "9" },
    "asian-series": { type: "series", apiType: "2", category: "11" },
    "discover-movies": { type: "movie", apiType: "1", category: null },
    "discover-series": { type: "series", apiType: "2", category: null }
  };

  var HOME_SECTION_CATALOGS = {
    "احدث الأفلام": "latest-movies",
    "احدث المسلسلات": "latest-series",
    "احدث الأعمال الأجنبية": "foreign-series",
    "احدث الأعمال التركية": "turkish-series",
    "احدث الأعمال الكورية": "korean-series",
    "احدث الأنميات والكرتون": "anime-series",
    "احدث الأعمال الهندية": "indian-series",
    "احدث الأعمال الآسيوية": "asian-series"
  };

  var CATEGORY_OPTIONS = {
    movie: [
      { value: "4", label: "أجنبي" }, { value: "2", label: "تركي" },
      { value: "8", label: "كوري" }, { value: "6", label: "أنمي وكرتون" },
      { value: "10", label: "هندي" }, { value: "12", label: "آسيوي" }
    ],
    series: [
      { value: "3", label: "أجنبي" }, { value: "1", label: "تركي" },
      { value: "7", label: "كوري" }, { value: "5", label: "أنمي وكرتون" },
      { value: "9", label: "هندي" }, { value: "11", label: "آسيوي" }
    ]
  };

  function fail(code) { throw new Error(code); }
  function text(value) { return value === undefined || value === null ? "" : String(value).trim(); }
  function positiveInt(value) {
    var number = Number(value);
    return isFinite(number) && Math.floor(number) === number && number > 0 ? number : null;
  }
  function safeRating(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 && number <= 10 ? number : undefined;
  }
  function boundedString(value, max) {
    var result = text(value);
    return result && result.length <= max ? result : "";
  }
  function dedupeBy(items, keyOf) {
    var seen = Object.create(null);
    return items.filter(function (item) {
      var key = keyOf(item);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function hostFromUrl(value) {
    var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(text(value));
    if (!match) return "";
    var authority = match[1].replace(/:[0-9]{1,5}$/, "").toLowerCase();
    if (!authority || authority.length > 253 || authority === "localhost" || /\.(?:local|localhost|internal|lan|home)$/.test(authority)) return "";
    if (/^[0-9.]+$/.test(authority)) {
      var parts = authority.split(".").map(Number);
      if (parts.length !== 4 || parts.some(function (part) { return !isFinite(part) || part < 0 || part > 255; })) return "";
      if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
          (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)) return "";
    } else if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(authority)) {
      return "";
    }
    return authority;
  }
  function publicHttpsBase(value) {
    var normalized = text(value).replace(/\/+$/, "");
    return /^https:\/\//i.test(normalized) && hostFromUrl(normalized) ? normalized : "";
  }
  function imageUrl(value) {
    var url = text(value);
    if (/^http:\/\/image\.tmdb\.org\//i.test(url)) url = "https" + url.slice(4);
    return /^https:\/\/[^\s]+$/i.test(url) && hostFromUrl(url) ? url : undefined;
  }
  function diagnostic(stage, data) {
    if (typeof root.__yume_diagnostic !== "function") return;
    var safe = { pluginId: PLUGIN_ID, stage: stage };
    data = data || {};
    ["host", "httpStatus", "responseKind", "itemCount", "episodeCount", "sourceCount", "streamCount", "failureCode", "elapsedMs"].forEach(function (key) {
      if (data[key] !== undefined && data[key] !== null) safe[key] = data[key];
    });
    try { root.__yume_diagnostic(JSON.stringify(safe)); } catch (_) { /* diagnostics never affect actions */ }
  }
  function encodeForm(values) {
    return Object.keys(values).filter(function (key) { return values[key] !== undefined && values[key] !== null && values[key] !== ""; })
      .map(function (key) { return encodeURIComponent(key) + "=" + encodeURIComponent(String(values[key])); }).join("&");
  }

  async function requestJson(url, options, stage) {
    var started = Date.now();
    if (!/^https:\/\//i.test(url) || !hostFromUrl(url)) fail("CIMACLOUD_INVALID_HTTPS_HOST");
    var response;
    try {
      response = await fetch(url, Object.assign({ timeoutMs: REQUEST_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } }, options || {}));
    } catch (_) {
      diagnostic(stage, { host: hostFromUrl(url), failureCode: "NETWORK_ERROR", elapsedMs: Date.now() - started });
      fail("CIMACLOUD_NETWORK_ERROR");
    }
    var contentType = text(response.headers && response.headers.get("content-type")).toLowerCase();
    var body = await response.text();
    if (body.length > MAX_BODY_CHARS) fail("CIMACLOUD_BODY_TOO_LARGE");
    if (!response.ok) {
      diagnostic(stage, { host: hostFromUrl(url), httpStatus: response.status, responseKind: contentType, failureCode: "HTTP_ERROR", elapsedMs: Date.now() - started });
      fail("CIMACLOUD_HTTP_" + response.status);
    }
    if (/text\/html|application\/xhtml/.test(contentType) || /^\s*</.test(body)) fail("CIMACLOUD_EXPECTED_JSON");
    var parsed;
    try { parsed = JSON.parse(body); } catch (_) { fail("CIMACLOUD_INVALID_JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("CIMACLOUD_INVALID_JSON");
    diagnostic(stage, { host: hostFromUrl(url), httpStatus: response.status, responseKind: "json", elapsedMs: Date.now() - started });
    return parsed;
  }

  async function resolveApiBase() {
    if (cachedBase) return cachedBase;
    try {
      var config = await requestJson(CONFIG_URL, null, "config");
      var rows = Array.isArray(config.data) ? config.data : [];
      for (var i = 0; i < rows.length; i++) {
        var candidate = publicHttpsBase(rows[i] && rows[i].cloudday);
        if (candidate) { cachedBase = candidate; return candidate; }
      }
    } catch (_) { /* verified fallback below */ }
    cachedBase = publicHttpsBase(FALLBACK_BASE);
    if (!cachedBase) fail("CIMACLOUD_NO_SAFE_API_HOST");
    return cachedBase;
  }
  async function api(path, form, stage) {
    if (!/^[a-z0-9_\/-]+$/i.test(path) || path.indexOf("..") >= 0) fail("CIMACLOUD_INVALID_API_PATH");
    var base = await resolveApiBase();
    var options = null;
    if (form) {
      options = { method: "POST", headers: { "User-Agent": USER_AGENT, "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: encodeForm(form) };
    }
    var result = await requestJson(base + API_PATH + path, options, stage);
    if (result.blocked === true || result.status === false) {
      diagnostic(stage, { host: hostFromUrl(base), failureCode: result.blocked === true ? "ACCESS_BLOCKED" : "API_REJECTED" });
      fail(result.blocked === true ? "CIMACLOUD_ACCESS_BLOCKED" : "CIMACLOUD_API_REJECTED");
    }
    return result;
  }

  function parseId(value) {
    var match = /^cc:(movie|series|episode):([1-9][0-9]{0,11})$/.exec(text(value));
    if (!match) fail("CIMACLOUD_INVALID_NATIVE_ID");
    return { kind: match[1], id: match[2] };
  }
  function nativeId(kind, id) { return "cc:" + kind + ":" + String(id); }
  function contentType(raw) {
    var value = text(raw && raw.type).toLowerCase();
    return value === "movie" ? "movie" : (value === "series" || value === "serie" ? "series" : "");
  }
  function categories(raw) {
    return (Array.isArray(raw && raw.categories) ? raw.categories : []).map(function (entry) { return positiveInt(entry && entry.id); }).filter(Boolean);
  }
  function genres(raw) {
    return dedupeBy((Array.isArray(raw && raw.genres) ? raw.genres : []).map(function (entry) { return boundedString(entry && entry.name, 80); }).filter(Boolean), function (value) { return value; }).slice(0, 30);
  }
  function trustedExternalIds(raw) {
    var tmdb = positiveInt(raw && raw.tmdb_id);
    var imdb = /^tt[0-9]{5,12}$/.test(text(raw && raw.imdb_id)) ? text(raw.imdb_id) : undefined;
    return tmdb || imdb ? { tmdb: tmdb ? String(tmdb) : undefined, imdb: imdb } : undefined;
  }
  function mapMedia(raw, forcedType) {
    if (!raw || typeof raw !== "object") return null;
    var id = positiveInt(raw.id);
    var type = forcedType || contentType(raw);
    if (!id || (type !== "movie" && type !== "series")) return null;
    var title = boundedString(raw.name || raw.title, 300);
    if (!title) return null;
    var item = {
      pluginId: PLUGIN_ID,
      nativeId: nativeId(type, id),
      type: type,
      title: title,
      originalTitle: boundedString(raw.original_title || raw.original_name, 300) || undefined,
      poster: imageUrl(raw.poster || raw.cover),
      backdrop: imageUrl(raw.backdrop),
      year: positiveInt(raw.year) || positiveInt(text(raw.release_date).slice(0, 4)) || undefined,
      rating: safeRating(raw.vote_average),
      description: boundedString(raw.overview, 10000) || undefined,
      genres: genres(raw),
      externalIds: trustedExternalIds(raw)
    };
    var rawDub = raw.dub;
    if (rawDub && rawDub !== "false") item.badges = [{ text: boundedString(rawDub, 40), kind: "dub" }];
    return item;
  }
  function mapHomeItem(raw) {
    if (text(raw && raw.type).toLowerCase() === "episode") {
      var parentId = positiveInt(raw.tv_show_id);
      var parentTitle = boundedString(raw.tv_show_name, 300);
      if (!parentId || !parentTitle) return null;
      return {
        pluginId: PLUGIN_ID, nativeId: nativeId("series", parentId), type: "series", title: parentTitle,
        poster: imageUrl(raw.poster || raw.cover || raw.image), genres: genres(raw),
        badges: [{ text: boundedString(raw.name || raw.title, 80) || "حلقة جديدة", kind: "episode" }]
      };
    }
    return mapMedia(raw);
  }
  function pageNumber(cursor) {
    if (cursor === undefined || cursor === null || cursor === "") return 1;
    if (!/^[1-9][0-9]{0,3}$/.test(String(cursor))) fail("CIMACLOUD_INVALID_CURSOR");
    var page = Number(cursor);
    if (page > MAX_PAGES) fail("CIMACLOUD_INVALID_CURSOR");
    return page;
  }
  function pageResult(payload, requestedPage) {
    var rows = Array.isArray(payload.results) ? payload.results.slice(0, MAX_ITEMS) : null;
    if (!rows) fail("CIMACLOUD_INVALID_LIST_SCHEMA");
    var current = positiveInt(payload.page) || requestedPage;
    var totalPages = positiveInt(payload.total_pages) || 1;
    var hasMore = payload.has_more === true || (current < totalPages);
    return { rows: rows, current: current, hasMore: hasMore && current < MAX_PAGES, total: positiveInt(payload.total) };
  }

  async function getHome() {
    var payload = await api("home", null, "home");
    var rawSections = Array.isArray(payload.sections) ? payload.sections.slice(0, 20) : null;
    if (!rawSections) fail("CIMACLOUD_INVALID_HOME_SCHEMA");
    var sections = rawSections.map(function (section, index) {
      var title = boundedString(section && section.section_name, 160);
      var rawItems = Array.isArray(section && section.section_items) ? section.section_items : [];
      var items = dedupeBy(rawItems.map(mapHomeItem).filter(Boolean), function (item) { return item.nativeId; }).slice(0, 18);
      if (!title || !items.length) return null;
      var normalizedTitle = title.replace(/\s+/g, " ").trim();
      var catalogId = HOME_SECTION_CATALOGS[normalizedTitle];
      return { id: catalogId || ("home-" + String(section.section_id || index + 1)), title: normalizedTitle, items: items, hasMore: !!catalogId };
    }).filter(Boolean);
    diagnostic("home_mapped", { itemCount: sections.reduce(function (sum, section) { return sum + section.items.length; }, 0) });
    return { sections: sections };
  }

  async function getCatalog(args) {
    args = args || {};
    var config = CATALOGS[text(args.catalogId)];
    if (!config) fail("CIMACLOUD_UNKNOWN_CATALOG");
    if (text(args.type) !== config.type) fail("CIMACLOUD_CATALOG_TYPE_MISMATCH");
    var page = pageNumber(args.cursor);
    var filters = args.filters && typeof args.filters === "object" ? args.filters : {};
    var category = config.category;
    if (!category && filters.category !== undefined && filters.category !== null && filters.category !== "") {
      var allowed = CATEGORY_OPTIONS[config.type].map(function (option) { return option.value; });
      category = allowed.indexOf(String(filters.category)) >= 0 ? String(filters.category) : null;
      if (!category) fail("CIMACLOUD_INVALID_CATEGORY_FILTER");
    }
    var order = filters.order === "oldest" ? "2" : "1";
    if (filters.order && filters.order !== "newest" && filters.order !== "oldest") fail("CIMACLOUD_INVALID_ORDER_FILTER");
    var year = filters.year ? String(filters.year) : "";
    if (year && !/^(?:19|20)[0-9]{2}$/.test(year)) fail("CIMACLOUD_INVALID_YEAR_FILTER");
    var payload = await api("all", { type: config.apiType, sort: order, page: page, category: category || undefined, year: year || undefined }, "catalog");
    var parsed = pageResult(payload, page);
    var items = dedupeBy(parsed.rows.map(function (raw) { return mapMedia(raw, config.type); }).filter(Boolean), function (item) { return item.nativeId; });
    diagnostic("catalog_mapped", { itemCount: items.length });
    return { catalogId: text(args.catalogId), items: items, page: { nextCursor: parsed.hasMore ? String(parsed.current + 1) : null, hasMore: parsed.hasMore, total: parsed.total || undefined } };
  }

  async function getCatalogFilters(args) {
    args = args || {};
    var config = CATALOGS[text(args.catalogId)];
    if (!config || (args.catalogId !== "discover-movies" && args.catalogId !== "discover-series")) fail("CIMACLOUD_FILTERS_UNAVAILABLE");
    if (text(args.contentType) !== config.type) fail("CIMACLOUD_CATALOG_TYPE_MISMATCH");
    var currentYear = new Date().getUTCFullYear();
    var years = [];
    for (var year = currentYear; year >= 1950; year--) years.push({ value: String(year), label: String(year) });
    return { catalogId: text(args.catalogId), filters: [
      { key: "category", kind: "select", label: "التصنيف", required: false, dynamic: true, options: CATEGORY_OPTIONS[config.type] },
      { key: "order", kind: "select", label: "الترتيب", required: false, dynamic: true, options: [{ value: "newest", label: "الأحدث" }, { value: "oldest", label: "الأقدم" }] },
      { key: "year", kind: "select", label: "السنة", required: false, dynamic: true, options: years }
    ] };
  }

  async function search(args) {
    args = args || {};
    var query = boundedString(args.query, 200);
    if (!query) fail("CIMACLOUD_SEARCH_QUERY_REQUIRED");
    var group = text(args.groupId);
    var apiType = group === "movies" ? "1" : (group === "series" ? "2" : "");
    if (!apiType) fail("CIMACLOUD_UNKNOWN_SEARCH_GROUP");
    var page = pageNumber(args.cursor);
    var payload = await api("search", { title: query, type: apiType, sort: "1", page: page }, "search");
    var parsed = pageResult(payload, page);
    var type = group === "movies" ? "movie" : "series";
    var items = dedupeBy(parsed.rows.map(function (raw) { return mapMedia(raw, type); }).filter(Boolean), function (item) { return item.nativeId; });
    diagnostic("search_mapped", { itemCount: items.length });
    return { groupId: group, items: items, page: { nextCursor: parsed.hasMore ? String(parsed.current + 1) : null, hasMore: parsed.hasMore, total: parsed.total || undefined } };
  }

  function episodeNumber(raw, index) {
    var explicit = positiveInt(raw && (raw.episode_number || raw.number));
    if (explicit) return explicit;
    var match = /(?:الحلقة|episode|ep)\s*([0-9]{1,4})/i.exec(text(raw && (raw.title || raw.name)));
    return match ? positiveInt(match[1]) : index + 1;
  }
  function mapEpisodes(payload) {
    var seasons = Array.isArray(payload && payload.seasons) ? payload.seasons : null;
    if (!seasons) fail("CIMACLOUD_INVALID_EPISODES_SCHEMA");
    var output = [];
    seasons.forEach(function (season, seasonIndex) {
      var seasonNumber = positiveInt(season && season.season_number) || seasonIndex + 1;
      var rows = Array.isArray(season && season.episodes) ? season.episodes : [];
      rows.forEach(function (raw, episodeIndex) {
        var id = positiveInt(raw && raw.id);
        if (!id || output.length >= MAX_EPISODES) return;
        output.push({ pluginId: PLUGIN_ID, nativeId: nativeId("episode", id), season: seasonNumber,
          episode: episodeNumber(raw, episodeIndex), title: boundedString(raw.title || raw.name, 300) || ("الحلقة " + (episodeIndex + 1)),
          thumbnail: imageUrl(raw.cover || raw.image), description: boundedString(raw.overview, 4000) || undefined,
          released: boundedString(raw.air_date, 40) || undefined });
      });
    });
    output = dedupeBy(output, function (episode) { return episode.nativeId; });
    output.sort(function (a, b) { return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0); });
    diagnostic("episodes_mapped", { episodeCount: output.length });
    return output;
  }
  function detailsItem(raw, parsed) {
    var mapped = mapMedia(raw, parsed.kind);
    if (!mapped || mapped.nativeId !== nativeId(parsed.kind, parsed.id)) fail("CIMACLOUD_DETAILS_IDENTITY_MISMATCH");
    return {
      pluginId: PLUGIN_ID, nativeId: mapped.nativeId, type: mapped.type, title: mapped.title,
      originalTitle: mapped.originalTitle, poster: mapped.poster, backdrop: mapped.backdrop,
      description: mapped.description, year: mapped.year, rating: mapped.rating, genres: mapped.genres,
      runtime: positiveInt(raw.runtime) || undefined, externalIds: mapped.externalIds,
      hasParentStreams: parsed.kind === "movie", episodes: []
    };
  }
  async function getDetails(args) {
    var parsed = parseId(args && args.id);
    if (parsed.kind === "episode") fail("CIMACLOUD_EPISODE_DETAILS_UNSUPPORTED");
    var payload = await api(parsed.kind + "/" + parsed.id, null, "details");
    var raw = payload[parsed.kind];
    if (!raw || typeof raw !== "object") fail("CIMACLOUD_INVALID_DETAILS_SCHEMA");
    var item = detailsItem(raw, parsed);
    if (parsed.kind === "series") {
      var episodesPayload = await api("series/" + parsed.id + "/episodes", null, "episodes");
      item.episodes = mapEpisodes(episodesPayload);
    }
    return { item: item, episodes: item.episodes };
  }

  async function getStreams(args) {
    var parsed = parseId(args && args.id);
    if (parsed.kind === "series") fail("CIMACLOUD_SERIES_HAS_NO_PARENT_STREAM");
    var path = parsed.kind === "movie" ? "movie/" + parsed.id + "/servers" : "episode/" + parsed.id + "/servers";
    try {
      var payload = await api(path, null, "streams");
      var servers = Array.isArray(payload.servers) ? payload.servers : [];
      if (!servers.length) fail("CIMACLOUD_NO_AUTHORIZED_SERVERS");
      // A readable server list is not accepted automatically. It must first be
      // reviewed and represented by stable, source-bound option tokens.
      diagnostic("streams", { sourceCount: servers.length, streamCount: 0, failureCode: "UNREVIEWED_SERVER_SCHEMA" });
      fail("CIMACLOUD_UNREVIEWED_SERVER_SCHEMA");
    } catch (error) {
      if (error && error.message === "CIMACLOUD_ACCESS_BLOCKED") fail("CIMACLOUD_AUTHORIZED_SERVER_ACCESS_REQUIRED");
      throw error;
    }
  }
  async function resolveStreamOption() { fail("CIMACLOUD_AUTHORIZED_SERVER_ACCESS_REQUIRED"); }

  var plugin = { getHome: getHome, getCatalog: getCatalog, getCatalogFilters: getCatalogFilters, search: search,
    getDetails: getDetails, getStreams: getStreams, resolveStreamOption: resolveStreamOption };
  if (root && root.module) root.module.exports = plugin;
  if (root && root.__YUME_CIMACLOUD_TESTING__ && root.module) {
    root.module.exports.__test = { hostFromUrl: hostFromUrl, publicHttpsBase: publicHttpsBase, imageUrl: imageUrl,
      parseId: parseId, nativeId: nativeId, mapMedia: mapMedia, mapHomeItem: mapHomeItem, mapEpisodes: mapEpisodes,
      pageResult: pageResult, detailsItem: detailsItem, resetBase: function () { cachedBase = null; } };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
