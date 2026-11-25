(function (root) {
  "use strict";

  var PLUGIN_ID = "5tv";
  var PLUGIN_VERSION = "0.2.0-rc.2";
  var BASE = "https://5tv.rest";
  var USER_AGENT = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36";
  var TIMEOUT_MS = 15000;
  var MAX_BODY = 4000000;
  var MAX_ITEMS = 100;
  var MAX_EPISODES = 2000;

  var CATALOGS = {
    "latest-series": { path: "/latest-series/", type: "series", card: "poster" },
    "latest-movies": { path: "/latest-movies/", type: "movie", card: "poster" },
    "asian-programs": { path: "/category/%D8%A7%D9%84%D8%A8%D8%B1%D8%A7%D9%85%D8%AC-%D8%A7%D9%84%D8%A3%D8%B3%D9%8A%D9%88%D9%8A%D8%A9/", type: "series", card: "poster" },
    "anime-series": { path: "/category/%D8%A3%D9%86%D9%85%D9%8A/", type: "series", card: "poster" },
    "korean-picks": { path: "/search/?q=&genre%5B%5D=32&country%5B%5D=7&category%5B%5D=15&category%5B%5D=60", type: "series", card: "poster" },
    "romance-series": { path: "/search/?q=&genre%5B%5D=23&category%5B%5D=18&category%5B%5D=15&category%5B%5D=60", type: "series", card: "poster" },
    "asian-drama": { path: "/search/?q=&category%5B%5D=24&category%5B%5D=87&category%5B%5D=93&category%5B%5D=12&category%5B%5D=69&category%5B%5D=18&category%5B%5D=80&category%5B%5D=15&category%5B%5D=60", type: "series", card: "poster" },
    "new-movies": { path: "/new-rows/", type: "movie", card: "poster" },
    "new-series": { path: "/new-rows/", type: "series", card: "poster" },
    "discover-movies": { path: "/latest-movies/", type: "movie", card: "poster", discover: true },
    "discover-series": { path: "/latest-series/", type: "series", card: "poster", discover: true }
  };
  var HOME_TITLES = {
    "جديد الدراما": "latest-series", "جديد الأفلام": "latest-movies",
    "تعرض قريبا ..": "upcoming-series", "تعرض قريباً ..": "upcoming-series",
    "جديد البرامج الأسيوية": "asian-programs", "جديد البرامج الآسيوية": "asian-programs",
    "جديد الأنمي": "anime-series", "غير موودك": "korean-picks", "غير مودك": "korean-picks",
    "رومانسية ؟": "romance-series", "رومانسية؟": "romance-series",
    "باقي الدراما الاسيوية": "asian-drama", "باقي الدراما الآسيوية": "asian-drama"
  };

  function fail(code) { throw new Error(code); }
  function text(value) { return value == null ? "" : String(value).replace(/\s+/g, " ").trim(); }
  function bounded(value, max) { var v = text(value); return v && v.length <= max ? v : ""; }
  function decodeEntities(value) {
    var map = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    return text(String(value || "").replace(/&#(x?[0-9a-f]+);|&([a-z]+);/gi, function (_, number, name) {
      if (number) { var n = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : parseInt(number, 10); return isFinite(n) ? String.fromCharCode(n) : _; }
      return map[String(name).toLowerCase()] || _;
    }).replace(/<[^>]*>/g, " "));
  }
  function attr(html, name) {
    var match = new RegExp("\\b" + name + "\\s*=\\s*([\\\"'])([\\s\\S]*?)\\1", "i").exec(html || "");
    return match ? decodeEntities(match[2]) : "";
  }
  function firstMatch(html, pattern) { var match = pattern.exec(html || ""); return match ? decodeEntities(match[1]) : ""; }
  function allBlocks(html, tag, className) {
    var pattern = new RegExp("<" + tag + "\\b[^>]*class=[\\\"'][^\\\"']*\\b" + className + "\\b[^\\\"']*[\\\"'][^>]*>[\\s\\S]*?<\\/" + tag + ">", "gi");
    return (html || "").match(pattern) || [];
  }
  function dedupe(items, keyOf) {
    var seen = Object.create(null), out = [];
    items.forEach(function (item) { var key = item && keyOf(item); if (key && !seen[key]) { seen[key] = true; out.push(item); } });
    return out;
  }
  function hostFromUrl(value) {
    var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(text(value));
    if (!match) return "";
    var host = match[1].replace(/:[0-9]{1,5}$/, "").toLowerCase();
    if (!host || host === "localhost" || /\.(?:local|internal|lan|home)$/.test(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) return "";
    return host;
  }
  function safePublicUrl(value) { var v = text(value); return /^https:\/\/[^\s@]+$/i.test(v) && hostFromUrl(v) ? v : ""; }
  function absoluteUrl(value) {
    var v = decodeEntities(value);
    if (/^\/\//.test(v)) v = "https:" + v;
    if (/^\//.test(v)) v = BASE + v;
    return safePublicUrl(v);
  }
  function siteUrl(value) {
    var v = absoluteUrl(value);
    return v && hostFromUrl(v) === "5tv.rest" ? v : "";
  }
  function imageUrl(value) { return absoluteUrl(value) || undefined; }
  function normalizeDigits(value) {
    return String(value || "").replace(/[٠-٩۰-۹]/g, function (d) { var code = d.charCodeAt(0); return String(code >= 1776 ? code - 1776 : code - 1632); });
  }
  function positiveInt(value) { var n = Number(normalizeDigits(value)); return isFinite(n) && n > 0 && Math.floor(n) === n ? n : null; }
  function pathParts(url) {
    var match = /^https:\/\/5tv\.rest\/(movie|series|episode)\/([^\/?#]+)\/?(?:[?#].*)?$/i.exec(siteUrl(url));
    if (!match) return null;
    var slug;
    try { slug = decodeURIComponent(match[2]); } catch (_) { return null; }
    if (!slug || slug.length > 220 || /[\s\u0000-\u001f]/.test(slug)) return null;
    return { kind: match[1].toLowerCase(), slug: slug };
  }
  function idFor(kind, slug) {
    var namespace = kind === "m" || kind === "movie" ? "movie" :
      (kind === "e" || kind === "episode" ? "episode" : "series");
    var value = kind === "a" ? "episode@" + slug : slug;
    return "5tv:" + namespace + ":" + value;
  }
  function parseId(value) {
    var match = /^5tv:(movie|series|episode):([^\s\u0000-\u001f]{1,240})$/.exec(text(value));
    if (!match) fail("5TV_INVALID_NATIVE_ID");
    if (match[1] === "movie") return { kind: "m", slug: match[2] };
    if (match[1] === "episode") return { kind: "e", slug: match[2] };
    if (match[2].indexOf("episode@") === 0 && match[2].length > 8) {
      return { kind: "a", slug: match[2].slice(8) };
    }
    return { kind: "s", slug: match[2] };
  }
  function urlForId(parsed) {
    var segment = parsed.kind === "m" ? "movie" : (parsed.kind === "s" ? "series" : "episode");
    return BASE + "/" + segment + "/" + encodeURIComponent(parsed.slug).replace(/%2D/gi, "-") + "/";
  }
  function diagnostic(stage, data) {
    if (typeof root.__yume_diagnostic !== "function") return;
    var safe = { pluginId: PLUGIN_ID, version: PLUGIN_VERSION, stage: stage }; data = data || {};
    ["host", "httpStatus", "responseKind", "itemCount", "episodeCount", "sourceCount", "streamCount", "failureCode", "elapsedMs"].forEach(function (key) { if (data[key] != null) safe[key] = data[key]; });
    try { root.__yume_diagnostic(JSON.stringify(safe)); } catch (_) {}
  }
  function isVerificationPage(body) {
    var value = String(body || "");
    return /please wait while your request is being verified|just a moment|cf-chl-|challenge-platform/i.test(value) &&
      !/ftv-(?:content-hero|home-section|latest-content-grid|discover)/i.test(value);
  }
  async function requestHtml(url, stage) {
    var started = Date.now();
    if (!siteUrl(url)) fail("5TV_UNTRUSTED_PAGE_URL");
    var response;
    try { response = await fetch(url, { timeoutMs: TIMEOUT_MS, headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" } }); }
    catch (_) { diagnostic(stage, { host: "5tv.rest", failureCode: "NETWORK_ERROR", elapsedMs: Date.now() - started }); fail("5TV_NETWORK_ERROR"); }
    var body = await response.text();
    if (!response.ok) fail("5TV_HTTP_" + response.status);
    if (body.length > MAX_BODY) fail("5TV_BODY_TOO_LARGE");
    if (isVerificationPage(body)) {
      diagnostic(stage, { host: "5tv.rest", httpStatus: response.status, responseKind: "verification", failureCode: "ACCESS_VERIFICATION_REQUIRED", elapsedMs: Date.now() - started });
      fail("5TV_ACCESS_VERIFICATION_REQUIRED");
    }
    if (!/<(?:html|section|article)\b/i.test(body)) fail("5TV_EXPECTED_HTML");
    diagnostic(stage, { host: "5tv.rest", httpStatus: response.status, responseKind: "html", elapsedMs: Date.now() - started });
    return { html: body, finalUrl: siteUrl(response.url) || url };
  }
  function posterCard(block, forcedType) {
    var href = siteUrl(attr(firstMatchRaw(block, /<a\b[^>]*class=["'][^"']*(?:ftv-home-poster-card__(?:image|title)|ftv-status-row__link)[^"']*["'][^>]*>/i), "href"));
    if (!href) href = firstSiteHref(block);
    var parts = pathParts(href); if (!parts || (parts.kind !== "movie" && parts.kind !== "series")) return null;
    var type = parts.kind === "movie" ? "movie" : "series";
    if (forcedType && type !== forcedType) return null;
    var title = firstMatch(block, /<(?:a|h3)\b[^>]*class=["'][^"']*(?:ftv-home-poster-card__title|ftv-status-row__link)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|h3)>/i) || firstMatch(block, /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i) || attr(firstMatchRaw(block, /<img\b[^>]*>/i), "alt");
    if (!title) return null;
    var img = firstMatchRaw(block, /<img\b[^>]*>/i);
    var year = positiveInt(firstMatch(block, /(?:ftv-poster-badge--year|ftv-tax-card__year)[^>]*>([\s\S]*?)<\/span>/i));
    return { pluginId: PLUGIN_ID, nativeId: idFor(type === "movie" ? "m" : "s", parts.slug), type: type, title: bounded(title, 180), poster: imageUrl(attr(img, "src")), year: year || undefined };
  }
  function firstMatchRaw(html, pattern) { var match = pattern.exec(html || ""); return match ? match[0] : ""; }
  function firstSiteHref(html) {
    var re = /<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1/gi, match;
    while ((match = re.exec(html || ""))) { var url = siteUrl(match[2]); if (pathParts(url)) return url; }
    return "";
  }
  function sectionBlocks(html) {
    var starts = [], re = /<section\b[^>]*class=["'][^"']*\bftv-home-section\b[^"']*["'][^>]*>/gi, m;
    while ((m = re.exec(html))) starts.push(m.index);
    return starts.map(function (start, index) { return html.slice(start, index + 1 < starts.length ? starts[index + 1] : html.length); });
  }
  function sectionTitle(block) { return firstMatch(block, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i) || firstMatch(block, /ftv-home-section__title[^>]*>([\s\S]*?)<\//i); }
  function mapHomeSection(block) {
    var rawTitle = sectionTitle(block), id = HOME_TITLES[rawTitle]; if (!id) return null;
    var config = CATALOGS[id], items;
    if (id === "upcoming-series") items = allBlocks(block, "article", "ftv-status-row__card").map(function (row) { return posterCard(row, "series"); });
    else items = allBlocks(block, "article", "ftv-home-poster-card").map(function (row) { return posterCard(row, config && config.type); });
    items = dedupe(items.filter(Boolean), function (item) { return item.nativeId; }).slice(0, MAX_ITEMS);
    if (!items.length) return null;
    return { id: id, title: rawTitle, items: items, hasMore: !!config };
  }
  async function getHome() {
    var page = await requestHtml(BASE + "/", "home");
    var sections = sectionBlocks(page.html).map(mapHomeSection).filter(Boolean);
    diagnostic("home_mapped", { itemCount: sections.reduce(function (n, section) { return n + section.items.length; }, 0) });
    return { sections: sections };
  }
  function pageNumber(cursor) { if (cursor == null || cursor === "") return 1; if (!/^[1-9][0-9]{0,3}$/.test(String(cursor))) fail("5TV_INVALID_CURSOR"); return Number(cursor); }
  function pagedUrl(path, page) {
    if (page === 1) return BASE + path;
    var query = path.indexOf("?") >= 0 ? path.slice(path.indexOf("?")) : "";
    var clean = path.split("?")[0].replace(/\/+$/, "");
    return BASE + clean + "/page/" + page + "/" + query;
  }
  function hasNextPage(html, page) {
    var re = /<a\b[^>]*class=["'][^"']*\b(?:next\s+)?page-numbers\b[^"']*["'][^>]*href=["']([^"']+)["']/gi, m;
    while ((m = re.exec(html || ""))) if (new RegExp("/page/" + (page + 1) + "/(?:[?\"']|$)").test(m[1])) return true;
    return false;
  }
  function selectedDiscoverRoute(filters) {
    filters = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
    var allowed = ["category", "genre", "country", "year"], selected = [];
    Object.keys(filters).forEach(function (key) {
      if (allowed.indexOf(key) < 0) fail("5TV_INVALID_FILTER");
      var value = text(filters[key]);
      if (!value) return;
      if (key === "year") {
        if (!/^(?:19|20)[0-9]{2}$/.test(value)) fail("5TV_INVALID_FILTER");
      } else if (!/^[^\s\/?#]{1,160}$/.test(value)) fail("5TV_INVALID_FILTER");
      selected.push({ key: key, value: value });
    });
    if (selected.length > 1) fail("5TV_FILTER_COMBINATION_UNSUPPORTED");
    if (!selected.length) return null;
    return "/" + selected[0].key + "/" + encodeURIComponent(selected[0].value).replace(/%2D/gi, "-") + "/";
  }
  function taxonomyOptions(html, key) {
    var re = new RegExp("<a\\b[^>]*href=[\\\"']https:\\/\\/5tv\\.rest\\/" + key + "\\/([^\\\"'\\/?#]+)\\/?[\\\"'][^>]*>([\\s\\S]*?)<\\/a>", "gi");
    var out = [], match;
    while ((match = re.exec(html || ""))) {
      var value;
      try { value = decodeURIComponent(match[1]); } catch (_) { continue; }
      var label = decodeEntities(match[2]).replace(/\s+[0-9٠-٩۰-۹٬,]+\s*←\s*$/, "");
      if (!value || !label || value.length > 160 || label.length > 120) continue;
      out.push({ value: value, label: label });
    }
    return dedupe(out, function (option) { return option.value; }).slice(0, 500);
  }
  function filterDefinition(key, label, options, role, priority) {
    var definition = { key: key, kind: "select", label: label, required: false, dynamic: true, dependsOn: [], options: options, discoverPresentation: { priority: priority } };
    if (role) definition.discoverPresentation.role = role;
    return definition;
  }
  async function getCatalog(args) {
    args = args || {}; var id = text(args.catalogId), config = CATALOGS[id]; if (!config) fail("5TV_UNKNOWN_CATALOG");
    if (text(args.type) !== config.type) fail("5TV_CATALOG_TYPE_MISMATCH");
    var path = config.path;
    if (config.discover) path = selectedDiscoverRoute(args.filters) || path;
    else if (args.filters && Object.keys(args.filters).length) fail("5TV_INVALID_FILTER");
    var page = pageNumber(args.cursor), response = await requestHtml(pagedUrl(path, page), "catalog");
    var blocks = allBlocks(response.html, "article", "ftv-home-poster-card").concat(allBlocks(response.html, "article", "ftv-tax-card"));
    var items = blocks.map(function (block) { return posterCard(block, config.type); }).filter(Boolean);
    items = dedupe(items, function (item) { return item.nativeId; }).slice(0, MAX_ITEMS);
    var more = hasNextPage(response.html, page);
    return { catalogId: id, items: items, page: { nextCursor: more ? String(page + 1) : null, hasMore: more } };
  }
  async function getCatalogFilters(args) {
    args = args || {}; var id = text(args.catalogId), config = CATALOGS[id];
    if (!config) fail("5TV_UNKNOWN_CATALOG");
    if (!config.discover) return { catalogId: id, filters: [] };
    selectedDiscoverRoute(args.selectedFilters);
    var page = await requestHtml(BASE + "/discover/", "catalog_filters");
    return {
      catalogId: id,
      filters: [
        filterDefinition("category", "التصنيف", taxonomyOptions(page.html, "category"), "category", 10),
        filterDefinition("genre", "النوع الفني", taxonomyOptions(page.html, "genre"), "genre", 20),
        filterDefinition("country", "الدولة", taxonomyOptions(page.html, "country"), null, 30),
        filterDefinition("year", "السنة", taxonomyOptions(page.html, "year"), null, 40)
      ]
    };
  }
  async function search(args) {
    args = args || {}; var query = bounded(args.query, 200); if (!query) fail("5TV_SEARCH_QUERY_REQUIRED");
    var group = text(args.groupId), type = group === "movies" ? "movie" : (group === "series" ? "series" : ""); if (!type) fail("5TV_UNKNOWN_SEARCH_GROUP");
    var page = await requestHtml(BASE + "/search/?q=" + encodeURIComponent(query), "search");
    var items = allBlocks(page.html, "article", "ftv-home-poster-card").map(function (block) { return posterCard(block, type); }).filter(Boolean);
    items = dedupe(items, function (item) { return item.nativeId; }).slice(0, MAX_ITEMS);
    return { groupId: group, items: items, page: { nextCursor: null, hasMore: false } };
  }
  function heroBlock(html) { var start = (html || "").search(/<section\b[^>]*class=["'][^"']*\bftv-content-hero\b/i); if (start < 0) return ""; var end = html.indexOf("</section>", start); return html.slice(start, end < 0 ? html.length : end + 10); }
  function parseDetailsPage(html, nativeId, type) {
    var hero = heroBlock(html); if (!hero) fail("5TV_DETAILS_SCHEMA_CHANGED");
    var title = firstMatch(hero, /ftv-content-hero__title[^>]*>([\s\S]*?)<\//i); if (!title) fail("5TV_DETAILS_TITLE_MISSING");
    var posterTag = firstMatchRaw(hero, /<img\b[^>]*>/i), styleTag = firstMatchRaw(hero, /<section\b[^>]*>/i);
    var backdrop = firstMatch(styleTag, /--ftv-backdrop\s*:\s*url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\)/i);
    var genres = [], genreRe = /ftv-content-chip--genre[^>]*>([\s\S]*?)<\/a>/gi, gm; while ((gm = genreRe.exec(hero))) genres.push(decodeEntities(gm[1]));
    var runtimeText = firstMatch(hero, /(?:المدة|الوقت|مدة العرض)[^0-9٠-٩۰-۹]{0,30}([0-9٠-٩۰-۹]{1,4})/i);
    return { pluginId: PLUGIN_ID, nativeId: nativeId, type: type, title: bounded(title, 300), poster: imageUrl(attr(posterTag, "src")), backdrop: imageUrl(backdrop), description: bounded(firstMatch(hero, /ftv-content-hero__description[^>]*>([\s\S]*?)<\/div>/i), 10000) || undefined, year: positiveInt(firstMatch(hero, /ftv-content-hero__year[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)) || undefined, genres: dedupe(genres.filter(Boolean), function (v) { return v; }).slice(0, 30), runtime: positiveInt(runtimeText) || undefined, hasParentStreams: type === "movie", episodes: [] };
  }
  function parseEpisodeNumber(value) { var match = /(?:الحلقة|episode|ep)\s*([0-9٠-٩۰-۹]{1,4})/i.exec(normalizeDigits(decodeEntities(value))); return match ? positiveInt(match[1]) : null; }
  function parseSeasonPanels(html) {
    var starts = [], re = /<div\b[^>]*class=["'][^"']*\bftv-season-panel\b[^"']*["'][^>]*data-season-panel=["']([^"']+)["'][^>]*>/gi, m;
    while ((m = re.exec(html || ""))) starts.push({ index: m.index, season: positiveInt(m[1]) });
    var out = [];
    starts.forEach(function (entry, index) {
      if (!entry.season) return;
      var panel = html.slice(entry.index, index + 1 < starts.length ? starts[index + 1].index : html.length);
      var itemRe = /<div\b[^>]*class=["'][^"']*\bftv-episode-completion-item\b[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bftv-episode-completion-item\b|<\/div>\s*<\/div>\s*<\/div>)/gi;
      var blocks = panel.match(itemRe) || [];
      blocks.forEach(function (block) {
        var href = firstSiteHref(block), parts = pathParts(href); if (!parts || parts.kind !== "episode" || out.length >= MAX_EPISODES) return;
        var strong = firstMatch(block, /<strong\b[^>]*>([\s\S]*?)<\/strong>/i), small = firstMatch(block, /<small\b(?![^>]*ftv-episode-(?:completion|next)-label)[^>]*>([\s\S]*?)<\/small>/i);
        var number = parseEpisodeNumber(strong) || parseEpisodeNumber(small);
        out.push({ pluginId: PLUGIN_ID, nativeId: idFor("e", parts.slug), season: entry.season, episode: number || undefined, title: bounded(strong || (number ? "الحلقة " + number : "حلقة خاصة"), 300) });
      });
    });
    out = dedupe(out, function (episode) { return episode.nativeId; });
    out.sort(function (a, b) { return (a.season || 9999) - (b.season || 9999) || (a.episode || 9999) - (b.episode || 9999); });
    return out;
  }
  async function getDetails(args) {
    var parsed = parseId(args && args.id), requestedId = text(args && args.id);
    if (parsed.kind === "m") { var movie = await requestHtml(urlForId(parsed), "details"); return { item: parseDetailsPage(movie.html, requestedId, "movie"), episodes: [] }; }
    var page = await requestHtml(urlForId(parsed), "details");
    if (parsed.kind === "a") {
      var back = firstMatchRaw(page.html, /<a\b[^>]*class=["'][^"']*\bftv-episode-poster-back\b[^"']*["'][^>]*>/i);
      var parentUrl = siteUrl(attr(back, "href")), parent = pathParts(parentUrl); if (!parent || parent.kind !== "series") fail("5TV_EPISODE_PARENT_MISSING");
      page = await requestHtml(parentUrl, "parent_details");
    } else if (parsed.kind !== "s") fail("5TV_EPISODE_DETAILS_UNSUPPORTED");
    var item = parseDetailsPage(page.html, requestedId, "series"); item.hasParentStreams = false;
    var episodes = parseSeasonPanels(page.html);
    diagnostic("episodes_mapped", { episodeCount: episodes.length });
    return { item: item, episodes: episodes };
  }
  function serverOptions(html, nativeId, pageUrl) {
    var out = [], seen = Object.create(null);
    function addOption(url, name, quality, kind) {
      url = absoluteUrl(url); if (!url || seen[url]) return;
      seen[url] = true;
      var ordinal = out.length, label = kind === "download" ? "رابط تنزيل " + (ordinal + 1) : "سيرفر " + (ordinal + 1);
      var token = JSON.stringify({ v: 1, id: nativeId, url: url, page: pageUrl, ordinal: ordinal, name: name, kind: kind });
      out.push({ pluginId: PLUGIN_ID, nativeId: nativeId, token: token, title: label, name: bounded(name, 100) || label, quality: bounded(quality, 40) || undefined, provider: "5TV" });
    }
    var iframe = firstMatchRaw(html, /<iframe\b[^>]*class=["'][^"']*\bftv-player-iframe\b[^"']*["'][^>]*>/i);
    if (iframe) addOption(attr(iframe, "src"), "المشغل الرئيسي", "", "player");
    var re = /<button\b[^>]*class=["'][^"']*\bftv-watch-tab\b[^"']*["'][^>]*>[\s\S]*?<\/button>/gi, blocks = (html || "").match(re) || [];
    blocks.forEach(function (block, index) {
      var name = firstMatch(block, /<strong\b[^>]*>([\s\S]*?)<\/strong>/i) || ("سيرفر " + (index + 1));
      var quality = firstMatch(block, /<small\b[^>]*>([\s\S]*?)<\/small>/i);
      addOption(attr(firstMatchRaw(block, /<button\b[^>]*>/i), "data-server-url"), name, quality, "server");
    });
    var downloads = allBlocks(html, "article", "ftv-download-server");
    downloads.forEach(function (block, index) {
      var link = firstMatchRaw(block, /<a\b[^>]*href\s*=\s*(["'])[\s\S]*?\1[^>]*>/i);
      var name = firstMatch(block, /<strong\b[^>]*>([\s\S]*?)<\/strong>/i) || ("تنزيل " + (index + 1));
      var quality = firstMatch(block, /<(?:small|span)\b[^>]*class=["'][^"']*(?:quality|size)[^"']*["'][^>]*>([\s\S]*?)<\/(?:small|span)>/i);
      addOption(attr(link, "href"), name, quality, "download");
    });
    return out;
  }
  async function getStreams(args) {
    var id = text(args && args.id), parsed = parseId(id); if (parsed.kind !== "m" && parsed.kind !== "e") fail("5TV_STREAM_ID_REQUIRED");
    var pageUrl = urlForId(parsed), page = await requestHtml(pageUrl, "stream_options"), options = serverOptions(page.html, id, page.finalUrl);
    if (!options.length) fail("5TV_NO_STREAM_OPTIONS");
    diagnostic("stream_options", { sourceCount: options.length }); return { options: options };
  }
  function parseToken(value, id) {
    var token; try { token = JSON.parse(text(value)); } catch (_) { fail("5TV_INVALID_STREAM_TOKEN"); }
    if (!token || token.v !== 1 || token.id !== id || !safePublicUrl(token.url) || !siteUrl(token.page) || !Number.isInteger(token.ordinal) || token.ordinal < 0 || token.ordinal > 50) fail("5TV_INVALID_STREAM_TOKEN");
    return token;
  }
  function mapExtracted(payload, title) {
    var rows = payload && Array.isArray(payload.streams) ? payload.streams : [];
    return rows.map(function (row) {
      if (!row || typeof row !== "object") return null; var url = safePublicUrl(row.url), type = text(row.type).toLowerCase();
      if (!url || ["hls", "mp4", "dash"].indexOf(type) < 0) return null;
      return { pluginId: PLUGIN_ID, url: url, type: type, title: title, name: title, provider: "5TV", quality: bounded(row.quality, 80) || undefined, headers: row.headers && typeof row.headers === "object" && !Array.isArray(row.headers) ? row.headers : {}, subtitles: Array.isArray(row.subtitles) ? row.subtitles : [] };
    }).filter(Boolean);
  }
  async function resolveStreamOption(args) {
    var id = text(args && args.id), parsed = parseId(id); if (parsed.kind !== "m" && parsed.kind !== "e") fail("5TV_STREAM_ID_REQUIRED");
    var token = parseToken(args && args.token, id); if (typeof root.__yume_extract_v1 !== "function") fail("5TV_EXTRACTOR_UNAVAILABLE");
    var raw; try { raw = await root.__yume_extract_v1(JSON.stringify({ scopeId: PLUGIN_ID, url: token.url, referrer: token.page, headers: { "User-Agent": USER_AGENT, "Referer": token.page }, timeoutMs: 20000, perAttemptTimeoutMs: 6000 })); } catch (_) { fail("5TV_EXTRACTION_FAILED"); }
    var payload; try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { fail("5TV_INVALID_EXTRACTOR_RESPONSE"); }
    var streams = mapExtracted(payload, "سيرفر " + (token.ordinal + 1)); if (!streams.length) fail("5TV_NO_PLAYABLE_STREAM");
    diagnostic("stream_resolved", { sourceCount: 1, streamCount: streams.length }); return { streams: streams };
  }

  var plugin = { getHome: getHome, getCatalog: getCatalog, getCatalogFilters: getCatalogFilters, search: search, getDetails: getDetails, getStreams: getStreams, resolveStreamOption: resolveStreamOption };
  if (root && root.module) root.module.exports = plugin;
  if (root && root.__YUME_5TV_TESTING__ && root.module) root.module.exports.__test = { decodeEntities: decodeEntities, normalizeDigits: normalizeDigits, pathParts: pathParts, idFor: idFor, parseId: parseId, posterCard: posterCard, mapHomeSection: mapHomeSection, parseDetailsPage: parseDetailsPage, parseSeasonPanels: parseSeasonPanels, serverOptions: serverOptions, parseToken: parseToken, mapExtracted: mapExtracted, hasNextPage: hasNextPage, isVerificationPage: isVerificationPage };
})(typeof globalThis !== "undefined" ? globalThis : this);
