"use strict";

// The route components below are the public constants used by the maintained
// CloudStream DramaWorld client. They are API route identifiers, not session
// credentials. Firebase remains optional and only updates the content hosts.
var PLUGIN_ID = "dramaworld";
var FIREBASE_PROJECT_ID = "alamaldrama2022v2";
var API_ROUTE_KEY = "4F5A9C3D9A86FA54EACEDDD635185";
var API_ROUTE_ID = "d506abfd-9fe2-4b71-b979-feff21bcad13";
var MAX_SOURCE_BODY_CHARS = 2 * 1024 * 1024;
var MAX_SOURCES = 100;
var MAX_SUBTITLES = 100;
var MAX_HTTP_BODY_CHARS = 1024 * 1024;
var MAX_REDIRECTS = 3;
var REQUEST_TIMEOUT_MS = 15000;
var ALLOWED_API_SUFFIX = ".arabypros.com";
var KNOWN_WORKING_API = "https://dwapp.arabypros.com/api";
var KNOWN_FALLBACK_APIS = [
  "https://test.arabypros.com/api",
  "https://app.arabypros.com/api",
  "https://dr.arabypros.com/api"
];
var REMOTE_CONFIG_KEYS = ["API_URL", "API_URL2"];

function fail(code, message) {
  var error = new Error(code + ": " + message);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  if (typeof value !== "string") return null;
  var result = value.trim();
  return result.length ? result : null;
}

function sourceId(value) {
  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0 || Math.floor(value) !== value) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  var result = value.trim();
  return /^[1-9][0-9]*$/.test(result) ? result : null;
}

function normalizeType(value) {
  if (typeof value !== "string") return null;
  var normalized = value.trim().toLowerCase();
  if (normalized === "movie") return "movie";
  if (normalized === "serie" || normalized === "series" || normalized === "tv") return "series";
  return null;
}

function isPrivateIpv4(host) {
  if (!/^[0-9.]+$/.test(host)) return false;
  var pieces = host.split(".");
  if (pieces.length !== 4 || !pieces.every(function (part) { return /^[0-9]{1,3}$/.test(part); })) return true;
  var octets = pieces.map(function (part) { return Number(part); });
  if (octets.some(function (part) { return part < 0 || part > 255; })) return true;
  return octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
    octets[0] >= 224;
}

function publicHttpUrl(value) {
  var url = text(value);
  if (!url || /[\u0000-\u0020\\]/.test(url)) return null;
  var match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url);
  if (!match) return null;
  var authority = match[2];
  var authorityMatch = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
  if (!authorityMatch) return null; // Reject user-info and IPv6 literals by default.
  var host = authorityMatch[1].toLowerCase();
  var port = authorityMatch[2] ? Number(authorityMatch[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (!host || host.length > 253 || host.charAt(0) === "." || host.charAt(host.length - 1) === ".") return null;
  if (host === "localhost" || /\.localhost$/.test(host) || /\.local$/.test(host)) return null;
  if (isPrivateIpv4(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.indexOf("..") >= 0) return null;
  return url;
}

function stringArray(values) {
  if (!Array.isArray(values)) return [];
  var found = Object.create(null);
  var result = [];
  values.forEach(function (value) {
    var candidate = typeof value === "string" ? text(value) : (isObject(value) ? text(value.title) : null);
    if (candidate && !found[candidate]) {
      found[candidate] = true;
      result.push(candidate);
    }
  });
  return result;
}

function parseYear(value) {
  if (typeof value === "number" && isFinite(value) && Math.floor(value) === value) return value;
  if (typeof value !== "string") return null;
  var match = /^\s*([0-9]{4})\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

function parseRating(value) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  return value;
}

function mediaItem(poster) {
  if (!isObject(poster)) return null;
  var id = sourceId(poster.id);
  var type = normalizeType(poster.type);
  var title = text(poster.title);
  if (!id || !type || !title) return null;
  var item = {
    pluginId: PLUGIN_ID,
    nativeId: "dw:" + type + ":" + id,
    type: type,
    title: title,
    poster: publicHttpUrl(poster.image) || publicHttpUrl(poster.cover),
    backdrop: publicHttpUrl(poster.cover),
    year: parseYear(poster.year),
    rating: parseRating(poster.rating),
    description: text(poster.description),
    genres: stringArray(Array.isArray(poster.genres)
      ? poster.genres
      : (typeof poster.classification === "string" ? poster.classification.split(",") : []))
  };
  Object.keys(item).forEach(function (key) {
    if (item[key] === null) delete item[key];
  });
  return item;
}

function unwrapData(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return {};
  return isObject(value.data) || Array.isArray(value.data) ? value.data : value;
}

function uniqueItems(posters, requiredType) {
  if (!Array.isArray(posters)) return [];
  var seen = Object.create(null);
  var items = [];
  posters.forEach(function (poster) {
    var item = mediaItem(poster);
    if (!item || (requiredType && item.type !== requiredType) || seen[item.nativeId]) return;
    seen[item.nativeId] = true;
    items.push(item);
  });
  return items;
}

function slideMediaItem(slide) {
  if (!isObject(slide)) return null;
  var poster = slide.poster;
  if (typeof poster === "string") {
    try { poster = JSON.parse(poster); } catch (_) { return null; }
  }
  return mediaItem(poster);
}

// Yume HOME sections are bound to declared catalog types. Only slides with a
// complete embedded Poster identity are promoted; channel/actor/slide IDs are
// never treated as movie or series IDs.
function mapHome(value) {
  var data = unwrapData(value);
  var featured = { movie: [], series: [] };
  var catalog = { movie: [], series: [] };
  var seen = Object.create(null);

  if (Array.isArray(data.slides)) {
    data.slides.forEach(function (slide) {
      var item = slideMediaItem(slide);
      if (!item || seen[item.nativeId]) return;
      seen[item.nativeId] = true;
      featured[item.type].push(item);
    });
  }

  if (Array.isArray(data.genres)) {
    data.genres.forEach(function (genre) {
      if (!isObject(genre) || !Array.isArray(genre.posters)) return;
      genre.posters.forEach(function (poster) {
        var item = mediaItem(poster);
        if (!item || seen[item.nativeId]) return;
        seen[item.nativeId] = true;
        catalog[item.type].push(item);
      });
    });
  }

  var sections = [];
  [
    { id: "featured-movies", type: "movie", items: featured.movie, title: "أفلام DramaWorld المميزة" },
    { id: "featured-series", type: "series", items: featured.series, title: "مسلسلات DramaWorld المميزة" },
    { id: "movies", type: "movie", items: catalog.movie, title: "أفلام DramaWorld" },
    { id: "series", type: "series", items: catalog.series, title: "مسلسلات DramaWorld" }
  ].forEach(function (descriptor) {
    if (descriptor.items.length) {
      sections.push({ id: descriptor.id, title: descriptor.title, items: descriptor.items });
    }
  });
  return { sections: sections };
}

function mapCatalog(value, catalogId) {
  var type = catalogId === "movies" ? "movie" : (catalogId === "series" ? "series" : null);
  if (!type) fail("DRAMAWORLD_INVALID_CATALOG", "unknown catalog id");
  var data = unwrapData(value);
  return {
    catalogId: catalogId,
    items: uniqueItems(data.posters, type),
    page: { hasMore: false }
  };
}

function catalogGenres(value, catalogId) {
  var type = catalogId === "movies" ? "movie" : (catalogId === "series" ? "series" : null);
  if (!type) fail("DRAMAWORLD_INVALID_CATALOG", "unknown catalog id");
  var data = unwrapData(value);
  if (!isObject(data) || !Array.isArray(data.genres)) return [];
  var seen = Object.create(null);
  return data.genres.map(function (genre) {
    if (!isObject(genre)) return null;
    var label = text(genre.title);
    if (!label || seen[label] || uniqueItems(genre.posters, type).length === 0) return null;
    seen[label] = true;
    return { value: label, label: label };
  }).filter(Boolean);
}

function mapCatalogByGenre(value, catalogId, genreName) {
  var type = catalogId === "movies" ? "movie" : (catalogId === "series" ? "series" : null);
  if (!type) fail("DRAMAWORLD_INVALID_CATALOG", "unknown catalog id");
  var data = unwrapData(value);
  if (!isObject(data) || !Array.isArray(data.genres)) fail("DRAMAWORLD_HOME_INVALID", "HOME has no genres array");
  var selected = text(genreName);
  if (!selected) {
    return { catalogId: catalogId, items: homeCatalogItems(mapHome(value), catalogId), page: { hasMore: false } };
  }
  var matching = data.genres.filter(function (genre) {
    return isObject(genre) && text(genre.title) === selected;
  });
  if (!matching.length) fail("DRAMAWORLD_INVALID_FILTER", "selected source category is not present in HOME");
  var posters = [];
  matching.forEach(function (genre) {
    if (Array.isArray(genre.posters)) posters = posters.concat(genre.posters);
  });
  return { catalogId: catalogId, items: uniqueItems(posters, type), page: { hasMore: false } };
}

function mapSearch(value, groupId) {
  var type = groupId === "movies" ? "movie" : (groupId === "series" ? "series" : null);
  if (!type) fail("DRAMAWORLD_INVALID_SEARCH_GROUP", "unknown search group");
  var data = unwrapData(value);
  return {
    groupId: groupId,
    items: uniqueItems(data.posters, type),
    page: { hasMore: false }
  };
}

function parseExplicitNumber(value, labels) {
  var title = text(value);
  if (!title) return null;
  var western = title.match(/(?:^|[^0-9])([0-9]{1,3})(?:$|[^0-9])/);
  if (western) return Number(western[1]);
  var arabicDigits = title.match(/[٠-٩۰-۹]{1,3}/);
  if (arabicDigits) {
    var normalized = arabicDigits[0].replace(/[٠-٩]/g, function (digit) {
      return String("٠١٢٣٤٥٦٧٨٩".indexOf(digit));
    }).replace(/[۰-۹]/g, function (digit) {
      return String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit));
    });
    return Number(normalized);
  }
  if (labels) {
    var words = [
      ["الحادي عشر", 11], ["الثاني عشر", 12], ["الثالث عشر", 13], ["الرابع عشر", 14],
      ["الخامس عشر", 15], ["السادس عشر", 16], ["السابع عشر", 17], ["الثامن عشر", 18],
      ["التاسع عشر", 19], ["العشرون", 20], ["العشرين", 20], ["الأول", 1], ["الاول", 1],
      ["الثاني", 2], ["الثالث", 3], ["الرابع", 4], ["الخامس", 5], ["السادس", 6],
      ["السابع", 7], ["الثامن", 8], ["التاسع", 9], ["العاشر", 10]
    ];
    for (var index = 0; index < words.length; index += 1) {
      if (title.indexOf(words[index][0]) >= 0) return words[index][1];
    }
  }
  return null;
}

function seasonNumber(season) {
  if (!isObject(season)) return null;
  var explicit = season.seasonNumber;
  if (typeof explicit === "number" && isFinite(explicit) && explicit >= 0 && Math.floor(explicit) === explicit) return explicit;
  var title = text(season.title);
  if (!title || !/(?:season|الموسم|موسم)/i.test(title)) return null;
  return parseExplicitNumber(title, true);
}

function episodeNumber(episode) {
  if (!isObject(episode)) return null;
  var explicit = episode.episodeNumber;
  if (typeof explicit === "number" && isFinite(explicit) && explicit > 0 && Math.floor(explicit) === explicit) return explicit;
  var title = text(episode.title);
  if (!title) return null;
  var label = /(?:الحلقة|حلقة|episode|ep\.?)/i.exec(title);
  if (!label) return null;
  return parseExplicitNumber(title.slice(label.index + label[0].length), true);
}

function episodeItem(episode, number, season) {
  if (!isObject(episode)) return null;
  var id = sourceId(episode.id);
  var title = text(episode.title);
  if (!id || !title) return null;
  var result = {
    pluginId: PLUGIN_ID,
    nativeId: "dw:episode:" + id,
    title: title,
    thumbnail: publicHttpUrl(episode.image),
    description: text(episode.description),
    season: season,
    episode: number
  };
  Object.keys(result).forEach(function (key) {
    if (result[key] === null) delete result[key];
  });
  return result;
}

function mapDetails(poster, seasons) {
  var item = mediaItem(poster);
  if (!item) fail("DRAMAWORLD_INVALID_DETAILS", "poster requires a supported type, numeric source id, and title");
  var episodes = [];
  var seen = Object.create(null);
  if (item.type === "series" && Array.isArray(seasons)) {
    var orderedSeasons = seasons.map(function (season, index) {
      return { season: season, index: index, number: seasonNumber(season) };
    });
    if (orderedSeasons.every(function (entry) { return entry.number !== null; })) {
      orderedSeasons.sort(function (left, right) { return left.number - right.number || left.index - right.index; });
    }
    orderedSeasons.forEach(function (entry) {
      var season = entry.season;
      if (!isObject(season) || !Array.isArray(season.episodes)) return;
      var orderedEpisodes = season.episodes.map(function (sourceEpisode, index) {
        return { source: sourceEpisode, index: index, number: episodeNumber(sourceEpisode) };
      });
      if (orderedEpisodes.every(function (entry) { return entry.number !== null; })) {
        orderedEpisodes.sort(function (left, right) { return left.number - right.number || left.index - right.index; });
      }
      orderedEpisodes.forEach(function (episodeEntry) {
        var episode = episodeItem(episodeEntry.source, episodeEntry.number, entry.number);
        if (!episode || seen[episode.nativeId]) return;
        seen[episode.nativeId] = true;
        episodes.push(episode);
      });
    });
  }
  return { item: item, episodes: episodes };
}

function decodeSourceBody(body) {
  if (Array.isArray(body)) {
    if (body.length > MAX_SOURCES) fail("DRAMAWORLD_SOURCE_LIMIT", "too many source entries");
    return body;
  }
  if (typeof body !== "string") fail("DRAMAWORLD_SOURCE_INVALID", "source body must be a string or array");
  var value = body.trim();
  if (!value || value.length > MAX_SOURCE_BODY_CHARS) {
    fail("DRAMAWORLD_SOURCE_LIMIT", "source body is empty or too large");
  }
  var encoded = value;
  var decoded = value;
  if (value.charAt(0) !== "[") {
    // CloudStream's source adapter finds the Base64 encoding of the first JSON
    // object after an opaque response prefix. Accept only that bounded suffix.
    var marker = value.indexOf("W3s");
    if (marker >= 0) encoded = value.slice(marker);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || typeof atob !== "function") {
      fail("DRAMAWORLD_SOURCE_INVALID", "source body is neither a JSON array nor strict Base64");
    }
    var binary;
    try {
      binary = atob(encoded);
      if (binary.length > MAX_SOURCE_BODY_CHARS) fail("DRAMAWORLD_SOURCE_LIMIT", "decoded source body is too large");
      if (typeof Uint8Array !== "function" || typeof TextDecoder !== "function") {
        fail("DRAMAWORLD_SOURCE_UNSUPPORTED", "UTF-8 decoding is unavailable in this runtime");
      }
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error && error.code) throw error;
      fail("DRAMAWORLD_SOURCE_INVALID", "Base64 or UTF-8 decoding failed");
    }
  }
  var parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (_) {
    fail("DRAMAWORLD_SOURCE_INVALID", "source JSON is malformed");
  }
  if (!Array.isArray(parsed)) fail("DRAMAWORLD_SOURCE_INVALID", "source JSON must be an array");
  if (parsed.length > MAX_SOURCES) fail("DRAMAWORLD_SOURCE_LIMIT", "too many source entries");
  return parsed;
}

function classifySource(source) {
  if (!isObject(source) || source.external === true) return null;
  var url = publicHttpUrl(source.url);
  if (!url || !/^https:\/\//i.test(url)) return null;
  var path = url.split(/[?#]/)[0].toLowerCase();
  var hint = (text(source.type) || "").toLowerCase();
  if (hint.indexOf("embed") >= 0 || hint.indexOf("iframe") >= 0 || hint.indexOf("player") >= 0) return null;
  // The live DramaWorld response labels embed pages with source types such as
  // "m3u8" and "webm". Treat a source as direct only when its URL itself has
  // a recognized media extension, matching the published client behavior.
  if (/\.m3u8$/.test(path)) {
    return { url: url, type: "hls" };
  }
  if (/\.mp4$/.test(path)) {
    return { url: url, type: "mp4" };
  }
  return null;
}

function mapSubtitles(value) {
  var data = unwrapData(value);
  var rows = Array.isArray(value) ? value : (Array.isArray(data) ? data : null);
  if (!rows) fail("DRAMAWORLD_SUBTITLES_INVALID", "DramaWorld subtitle response must be an array");
  var seen = Object.create(null);
  var subtitles = [];
  rows.forEach(function (languageGroup) {
    if (!isObject(languageGroup) || !Array.isArray(languageGroup.subtitles)) return;
    var groupLanguage = text(languageGroup.language) || "Unknown";
    languageGroup.subtitles.forEach(function (source) {
      if (!isObject(source) || subtitles.length >= MAX_SUBTITLES) return;
      var url = publicHttpUrl(source.url);
      if (!url || !/^https:\/\//i.test(url) || seen[url]) return;
      seen[url] = true;
      var language = text(source.language) || groupLanguage;
      subtitles.push({
        url: url,
        language: language,
        name: language
      });
    });
  });
  subtitles.sort(function (left, right) {
    var leftArabic = /^(ar|ara|arabic|العربية|عربي)$/i.test(left.language);
    var rightArabic = /^(ar|ara|arabic|العربية|عربي)$/i.test(right.language);
    return Number(rightArabic) - Number(leftArabic);
  });
  return subtitles;
}

function mapStreams(sourceBody, subtitles) {
  var sources = decodeSourceBody(sourceBody);
  var seen = Object.create(null);
  var streams = [];
  sources.forEach(function (source) {
    var direct = classifySource(source);
    if (!direct || seen[direct.url]) return;
    seen[direct.url] = true;
    var quality = text(source.quality);
    var serverName = quality ? "سيرفر · " + quality : "سيرفر " + (streams.length + 1);
    var stream = {
      url: direct.url,
      type: direct.type,
      title: serverName,
      name: serverName,
      provider: "DramaWorld",
      subtitles: Array.isArray(subtitles) ? subtitles : []
    };
    var size = text(source.size);
    if (quality) stream.quality = quality;
    if (size) stream.size = size;
    streams.push(stream);
  });
  return { streams: streams };
}

function approvedBaseUrl(value, settingName) {
  var candidate = text(value);
  if (!candidate) return null;
  if (/[\u0000-\u0020\\?#@]/.test(candidate)) {
    fail("DRAMAWORLD_CONFIG_INVALID", settingName + " must be an HTTPS API base URL");
  }
  var match = /^https:\/\/([a-z0-9.-]+)(?:\/api)?\/?$/i.exec(candidate);
  if (!match) fail("DRAMAWORLD_CONFIG_INVALID", settingName + " must use an approved HTTPS API origin");
  var host = match[1].toLowerCase();
  if (host.indexOf("..") >= 0 || host.charAt(0) === "." || host.charAt(host.length - 1) === "." ||
      (host !== "arabypros.com" && !host.endsWith(ALLOWED_API_SUFFIX))) {
    fail("DRAMAWORLD_CONFIG_INVALID", settingName + " is outside the approved DramaWorld API domain");
  }
  return { origin: "https://" + host, baseUrl: "https://" + host + "/api" };
}

function publishedPathComponent(value, kind) {
  var candidate = text(value);
  if (!candidate || candidate.length > 256) {
    fail("DRAMAWORLD_ROUTE_CONFIG_INVALID", "published API route component is invalid");
  }
  var valid = kind === "key"
    ? /^[A-Za-z0-9_-]{16,100}$/.test(candidate)
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate);
  if (!valid) {
    fail("DRAMAWORLD_ROUTE_CONFIG_INVALID", "published API route component has an invalid format");
  }
  return candidate;
}

function firebasePublicClientSettings(settings) {
  var apiKey = text(settings.firebaseApiKey);
  var appId = text(settings.firebaseAppId);
  if (!apiKey && !appId) return null;
  if (!apiKey || !appId) fail("DRAMAWORLD_FIREBASE_CONFIG_INVALID", "both owner-approved Firebase client fields are required to refresh Remote Config");
  if (!/^AIza[0-9A-Za-z_-]{20,100}$/.test(apiKey)) {
    fail("DRAMAWORLD_FIREBASE_CONFIG_INVALID", "Firebase public API key format is invalid");
  }
  if (!/^1:[0-9]+:(?:web|android):[0-9a-f]+$/i.test(appId)) {
    fail("DRAMAWORLD_FIREBASE_CONFIG_INVALID", "Firebase app ID must be an owner-approved Android or Web client ID");
  }
  return { projectId: FIREBASE_PROJECT_ID, apiKey: apiKey, appId: appId };
}

async function fetchRemoteConfig(settings) {
  var client;
  try { client = firebasePublicClientSettings(settings); } catch (_) { return null; }
  if (!client) return null;
  if (typeof __native_plugin_request !== "function") {
    return null;
  }
  var raw;
  try {
    raw = await __native_plugin_request("DRAMAWORLD_REMOTE_CONFIG", JSON.stringify(client));
  } catch (_) {
    return null;
  }
  var response;
  try { response = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) {
    return null;
  }
  if (!isObject(response) || !isObject(response.values)) {
    return null;
  }
  var values = {};
  REMOTE_CONFIG_KEYS.forEach(function (key) {
    var value = response.values[key];
    if (isObject(value) && typeof value.value === "string") value = value.value;
    if (typeof value === "string" && text(value)) values[key] = text(value);
  });
  return {
    values: values,
    stale: response.stale === true,
    lastSuccessfulHost: text(response.lastSuccessfulHost)
  };
}

async function readCachedNativeConfig() {
  if (typeof __native_plugin_request !== "function") return null;
  try {
    var raw = await __native_plugin_request("DRAMAWORLD_CACHED_CONFIG", "{}");
    var response = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isObject(response) || !isObject(response.values)) return null;
    var values = {};
    REMOTE_CONFIG_KEYS.forEach(function (key) {
      var value = response.values[key];
      if (isObject(value) && typeof value.value === "string") value = value.value;
      if (typeof value === "string" && text(value)) values[key] = text(value);
    });
    return {
      values: values,
      stale: response.stale === true,
      lastSuccessfulHost: text(response.lastSuccessfulHost)
    };
  } catch (_) {
    return null;
  }
}

function decodeRemoteHostValue(value, key) {
  var candidate = text(value);
  if (!candidate) return null;
  if (key !== "API_URL" && key !== "API_URL2") return candidate;
  if ((key === "API_URL" || key === "API_URL2") && /^https:\/\//i.test(candidate)) return candidate;
  if (!/^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}==|[A-Za-z0-9+/_-]{3}=)?$/.test(candidate) || typeof atob !== "function") {
    return candidate;
  }
  try {
    var decoded = atob(candidate);
    var ascii = "";
    for (var index = 0; index < decoded.length; index += 1) {
      if (decoded.charCodeAt(index) < 0x20 || decoded.charCodeAt(index) > 0x7e) return candidate;
      ascii += decoded.charAt(index);
    }
    if (key === "API_URL" || key === "API_URL2") return /^https:\/\//i.test(ascii) ? ascii : candidate;
    return ascii || candidate;
  } catch (_) {
    return candidate;
  }
}

async function readConfig() {
  var settings = typeof SCRAPER_SETTINGS !== "undefined" && isObject(SCRAPER_SETTINGS)
    ? SCRAPER_SETTINGS
    : {};
  var cached = await readCachedNativeConfig();
  var remote = await fetchRemoteConfig(settings);
  // The published CloudStream contract supplies the route components. Remote
  // Config is only a dynamic host source, so unavailable Firebase must not
  // block the known working API host.
  var remoteValues = remote && remote.values || {};
  var cachedValues = cached && cached.values || {};
  var bases = [];
  function appendBase(candidate, label) {
    if (!candidate) return;
    try {
      var decoded = label === "API_URL" || label === "API_URL2"
        ? decodeRemoteHostValue(candidate, label)
        : candidate;
      var base = approvedBaseUrl(decoded, label);
      if (base && !bases.some(function (existing) { return existing.origin === base.origin; })) bases.push(base);
    } catch (_) {
      // A rejected candidate must not prevent another approved host from being tried.
    }
  }
  var lastSuccessfulHost = cached && cached.lastSuccessfulHost || remote && remote.lastSuccessfulHost || null;
  if (lastSuccessfulHost) {
    appendBase("https://" + lastSuccessfulHost + "/api", "lastSuccessfulHost");
  }
  appendBase(KNOWN_WORKING_API, "knownWorkingApi");
  [remoteValues.API_URL, remoteValues.API_URL2, cachedValues.API_URL, cachedValues.API_URL2].forEach(function (candidate, index) {
    appendBase(candidate, index % 2 === 0 ? "API_URL" : "API_URL2");
  });
  KNOWN_FALLBACK_APIS.forEach(function (candidate, index) {
    appendBase(candidate, "knownFallback" + index);
  });
  if (!bases.length) fail("DRAMAWORLD_FIREBASE_CONFIG_INVALID", "Remote Config contained no approved DramaWorld API host");
  var pathPartA = publishedPathComponent(API_ROUTE_KEY, "key");
  var pathPartB = publishedPathComponent(API_ROUTE_ID, "id");
  return {
    bases: bases,
    pathPartA: pathPartA,
    pathPartB: pathPartB,
    configStale: remote ? remote.stale === true : cached ? cached.stale === true : true,
    lastSuccessfulHost: lastSuccessfulHost
  };
}

async function rememberSuccessfulHomeHost(base) {
  if (typeof __native_plugin_request !== "function" || !base || !base.origin) return;
  try {
    await __native_plugin_request("DRAMAWORLD_RECORD_HOME_HOST", JSON.stringify({ host: base.origin.slice("https://".length) }));
  } catch (_) {
    // Host preference is an optimization; a successful HOME remains usable if persistence is unavailable.
  }
}

function endpointPath(config, path) {
  return "/" + path + "/" + config.pathPartA + "/" + config.pathPartB + "/";
}

function urlOrigin(value) {
  if (typeof value !== "string") return null;
  var match = /^(https:\/\/[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/|$)/i.exec(value);
  if (!match) return null;
  return match[1].toLowerCase() + (match[2] && Number(match[2]) !== 443 ? ":" + match[2] : "");
}

function redirectUrl(location, currentUrl, allowedOrigin) {
  var value = text(location);
  if (!value || /[\u0000-\u0020\\]/.test(value)) {
    fail("DRAMAWORLD_REDIRECT_REJECTED", "API redirect did not provide a safe HTTPS location");
  }
  var target;
  if (/^https:\/\//i.test(value)) {
    target = value;
  } else if (value.charAt(0) === "/" && value.charAt(1) !== "/") {
    target = allowedOrigin + value;
  } else {
    fail("DRAMAWORLD_REDIRECT_REJECTED", "only absolute or root-relative API redirects are supported");
  }
  if (urlOrigin(target) !== allowedOrigin || !/^https:\/\//i.test(target)) {
    fail("DRAMAWORLD_REDIRECT_REJECTED", "API redirect left the configured HTTPS origin");
  }
  return target;
}

function isHtmlOrChallengeBody(body) {
  var head = typeof body === "string" ? body.replace(/^\s+/, "").slice(0, 4096) : "";
  if (/^(?:<!doctype\s+html|<html|<head|<body|<title|<form)\b/i.test(head)) return true;
  if (/^[\[{]/.test(head)) return false;
  return /(?:cf-mitigated|challenge-platform|__cf_chl|just a moment|checking your browser)/i.test(head);
}

function isCancellation(error) {
  return !!error && /^(AbortError|CancellationError|CancelledError)$/.test(error.name || "");
}

async function requestTextAtBase(base, path) {
  var url = base.baseUrl + path;
  for (var redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    var response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain;q=0.9, */*;q=0.1",
          "User-Agent": "okhttp/4.12.0"
        },
        redirect: "manual",
        timeoutMs: REQUEST_TIMEOUT_MS
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (error && error.name === "TimeoutError") {
        fail("DRAMAWORLD_TIMEOUT", "DramaWorld request timed out");
      }
      fail("DRAMAWORLD_NETWORK_ERROR", "DramaWorld request failed at the transport layer");
    }

    if (urlOrigin(response.url || url) !== base.origin) {
      fail("DRAMAWORLD_REDIRECT_REJECTED", "API response left the configured HTTPS origin");
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) {
        fail("DRAMAWORLD_REDIRECT_LIMIT", "too many API redirects");
      }
      url = redirectUrl(response.headers && response.headers.get("location"), url, base.origin);
      continue;
    }
    if (!response.ok) {
      if (response.status === 401) fail("DRAMAWORLD_AUTH_REQUIRED", "DramaWorld rejected the configured client with HTTP 401");
      if (response.status === 403) fail("DRAMAWORLD_ACCESS_DENIED", "DramaWorld denied this client with HTTP 403");
      fail("DRAMAWORLD_HTTP_ERROR", "DramaWorld returned HTTP " + response.status);
    }

    var body = await response.text();
    if (typeof body !== "string") fail("DRAMAWORLD_RESPONSE_INVALID", "DramaWorld returned no text body");
    if (body.length > MAX_HTTP_BODY_CHARS || body.indexOf("...[truncated]") >= 0) {
      fail("DRAMAWORLD_RESPONSE_TOO_LARGE", "DramaWorld response exceeded the FetchBridge body limit");
    }
    if (isHtmlOrChallengeBody(body)) {
      fail("DRAMAWORLD_NON_JSON_RESPONSE", "DramaWorld returned HTML instead of API data");
    }
    return body;
  }
  fail("DRAMAWORLD_REDIRECT_LIMIT", "too many API redirects");
}

async function requestText(config, path) {
  var lastError = null;
  for (var index = 0; index < config.bases.length; index += 1) {
    try {
      return await requestTextAtBase(config.bases[index], path);
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  fail("DRAMAWORLD_NETWORK_ERROR", "no configured DramaWorld API host was available");
}

async function requestJson(config, path) {
  var lastError = null;
  for (var index = 0; index < config.bases.length; index += 1) {
    try {
      var body = await requestTextAtBase(config.bases[index], path);
      var parsed;
      try { parsed = JSON.parse(body); } catch (_) {
        fail("DRAMAWORLD_INVALID_JSON", "DramaWorld response was not valid JSON");
      }
      if (!isObject(parsed) && !Array.isArray(parsed)) {
        fail("DRAMAWORLD_INVALID_JSON", "DramaWorld JSON root must be an object or array");
      }
      return parsed;
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  fail("DRAMAWORLD_NETWORK_ERROR", "no configured DramaWorld API host was available");
}

async function requestDecodedSources(config, path) {
  var lastError = null;
  for (var index = 0; index < config.bases.length; index += 1) {
    try {
      var body = await requestTextAtBase(config.bases[index], path);
      return decodeSourceBody(body);
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  fail("DRAMAWORLD_NETWORK_ERROR", "no configured DramaWorld API host was available");
}

async function requestValidatedJson(config, path, validator, errorCode, errorMessage, onAccepted) {
  var lastError = null;
  for (var index = 0; index < config.bases.length; index += 1) {
    try {
      var body = await requestTextAtBase(config.bases[index], path);
      var parsed;
      try { parsed = JSON.parse(body); } catch (_) {
        fail("DRAMAWORLD_INVALID_JSON", "DramaWorld response was not valid JSON");
      }
      if (!isObject(parsed) && !Array.isArray(parsed)) {
        fail("DRAMAWORLD_INVALID_JSON", "DramaWorld JSON root must be an object or array");
      }
      if (validator && !validator(parsed)) fail(errorCode, errorMessage);
      if (onAccepted) await onAccepted(config.bases[index]);
      return parsed;
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  fail("DRAMAWORLD_NETWORK_ERROR", "no configured DramaWorld API host was available");
}

function parseNativeId(value, allowedKinds) {
  var id = text(value);
  var match = id && /^dw:(movie|series|episode):([1-9][0-9]*)$/.exec(id);
  if (!match || allowedKinds.indexOf(match[1]) < 0) {
    fail("DRAMAWORLD_INVALID_ID", "a DramaWorld native content or episode ID is required");
  }
  return { kind: match[1], id: match[2] };
}

function homeCatalogItems(home, catalogId) {
  var wanted = catalogId === "movies" ? "movie" : "series";
  var allowedSections = wanted === "movie" ? ["featured-movies", "movies"] : ["featured-series", "series"];
  var seen = Object.create(null);
  var items = [];
  home.sections.forEach(function (section) {
    if (allowedSections.indexOf(section.id) < 0) return;
    section.items.forEach(function (item) {
      if (item.type !== wanted || seen[item.nativeId]) return;
      seen[item.nativeId] = true;
      items.push(item);
    });
  });
  return items;
}

function onSettings() {
  return [
    { type: "header", label: "اتصال DramaWorld" },
    { type: "info", label: "يعمل الاتصال بالمضيف المعروف دون إعداد Firebase. أدخل بيانات عميل Firebase العامة المعتمدة اختيارياً لتحديث عناوين المضيفين؛ لا تُستخدم قيم Remote Config لبناء مسار API." },
    { type: "text", key: "firebaseApiKey", label: "Firebase public API key (اختياري)", placeholder: "مفتاح العميل العام المعتمد" },
    { type: "text", key: "firebaseAppId", label: "Firebase Android/Web App ID", placeholder: "1:…:android:… أو 1:…:web:…", description: "استخدم إعداداً عاماً أذن به مالك المشروع. لا تدخل رمز جلسة أو مفتاحاً خاصاً." },
    { type: "info", label: "تُحفظ رموز Firebase مشفرة داخل Android ولا تُمرر إلى JavaScript أو السجلات. يبدأ اختيار المضيف بآخر HOME صالح ثم dwapp المعروف." }
  ];
}

function homeSchemaIsValid(value) {
  var data = unwrapData(value);
  if (!isObject(data)) return false;
  var validSlideItems = Array.isArray(data.slides) ? data.slides.filter(function (slide) {
    return !!slideMediaItem(slide);
  }).length : 0;
  var validGenreItems = Array.isArray(data.genres) ? data.genres.reduce(function (count, genre) {
    if (!isObject(genre) || !Array.isArray(genre.posters)) return count;
    return count + uniqueItems(genre.posters).length;
  }, 0) : 0;
  var directPosters = Array.isArray(data.posters) ? uniqueItems(data.posters).length : 0;
  return validSlideItems + validGenreItems + directPosters > 0;
}

function requestHomeData(config) {
  return requestValidatedJson(config, endpointPath(config, "first"), homeSchemaIsValid,
    "DRAMAWORLD_HOME_INVALID", "DramaWorld HOME JSON contained no valid movie or series content",
    rememberSuccessfulHomeHost);
}

async function getHome() {
  var config = await readConfig();
  var raw = await requestHomeData(config);
  return mapHome(raw);
}

async function getCatalog(args) {
  args = isObject(args) ? args : {};
  var catalogId = text(args.catalogId);
  if (catalogId !== "movies" && catalogId !== "series") {
    fail("DRAMAWORLD_INVALID_CATALOG", "unknown DramaWorld catalog");
  }
  var config = await readConfig();
  var raw = await requestHomeData(config);
  var filters = isObject(args.filters) ? args.filters : {};
  Object.keys(filters).forEach(function (key) {
    if (key !== "genre") fail("DRAMAWORLD_INVALID_FILTER", "unknown DramaWorld catalog filter");
  });
  return mapCatalogByGenre(raw, catalogId, filters.genre);
}

async function getCatalogFilters(args) {
  args = isObject(args) ? args : {};
  var catalogId = text(args.catalogId);
  if (catalogId !== "movies" && catalogId !== "series") {
    fail("DRAMAWORLD_INVALID_CATALOG", "unknown DramaWorld catalog");
  }
  var config = await readConfig();
  var raw = await requestHomeData(config);
  var options = catalogGenres(raw, catalogId);
  return {
    catalogId: catalogId,
    filters: options.length ? [{ key: "genre", label: "التصنيف", options: options }] : []
  };
}

async function search(args) {
  args = isObject(args) ? args : {};
  var query = text(args.query);
  var groupId = text(args.groupId);
  if (!query) fail("DRAMAWORLD_INVALID_SEARCH", "search query must not be blank");
  if (groupId !== "movies" && groupId !== "series") {
    fail("DRAMAWORLD_INVALID_SEARCH_GROUP", "unknown DramaWorld search group");
  }
  var config = await readConfig();
  var path = "search/" + encodeURIComponent(query) + "/0";
  var raw = await requestValidatedJson(config, endpointPath(config, path), function (value) {
    var data = unwrapData(value);
    return Array.isArray(data.posters) || Array.isArray(data.channels);
  }, "DRAMAWORLD_SEARCH_INVALID", "DramaWorld search JSON did not contain results");
  return mapSearch(raw, groupId);
}

async function getDetails(args) {
  args = isObject(args) ? args : {};
  var identity = parseNativeId(args.id || args.nativeId, ["movie", "series"]);
  var config = await readConfig();
  var rawPoster = await requestValidatedJson(config, endpointPath(config, "movie/by/" + identity.id), function (value) {
    var poster = unwrapData(value);
    var item = mediaItem(poster);
    return !!item && item.nativeId === "dw:" + identity.kind + ":" + identity.id;
  }, "DRAMAWORLD_DETAILS_ID_MISMATCH", "DramaWorld details did not match the requested source ID and type");
  var poster = unwrapData(rawPoster);
  var item = mediaItem(poster);
  if (!item || item.nativeId !== "dw:" + identity.kind + ":" + identity.id) {
    fail("DRAMAWORLD_DETAILS_ID_MISMATCH", "DramaWorld details did not match the requested source ID and type");
  }
  var seasons = [];
  if (identity.kind === "series") {
    var rawSeasons = await requestValidatedJson(config, endpointPath(config, "season/by/serie/" + identity.id), function (value) {
      var seasonsData = unwrapData(value);
      return Array.isArray(seasonsData) || (isObject(seasonsData) && Array.isArray(seasonsData.seasons));
    }, "DRAMAWORLD_SEASONS_INVALID", "DramaWorld returned an invalid seasons response");
    var seasonData = unwrapData(rawSeasons);
    seasons = Array.isArray(seasonData) ? seasonData : (isObject(seasonData) && Array.isArray(seasonData.seasons) ? seasonData.seasons : null);
    if (!seasons) fail("DRAMAWORLD_SEASONS_INVALID", "DramaWorld returned an invalid seasons response");
  }
  return mapDetails(poster, seasons);
}

async function getStreams(args) {
  args = isObject(args) ? args : {};
  var identity = parseNativeId(args.id || args.nativeId, ["movie", "episode"]);
  var config = await readConfig();
  var route = identity.kind === "movie" ? "movie/source/by/" : "episode/source/by/";
  var sourceRows = await requestDecodedSources(config, endpointPath(config, route + identity.id));
  var subtitleRoute = identity.kind === "movie"
    ? "subtitles/by/movie/" + identity.id
    : "subtitles/by/episode/" + identity.id;
  var subtitles = [];
  try {
    var rawSubtitles = await requestValidatedJson(config, endpointPath(config, subtitleRoute), function (value) {
      var data = unwrapData(value);
      return Array.isArray(value) || Array.isArray(data);
    }, "DRAMAWORLD_SUBTITLES_INVALID", "DramaWorld returned invalid subtitle data");
    subtitles = mapSubtitles(rawSubtitles);
  } catch (subtitleError) {
    if (isCancellation(subtitleError)) throw subtitleError;
    if (typeof console !== "undefined" && console.warn) console.warn("DramaWorld subtitle list unavailable");
  }
  return mapStreams(sourceRows, subtitles);
}

function resolveStreamOption() {
  fail("DRAMAWORLD_STREAM_RESOLUTION_UNSUPPORTED", "only direct HLS and MP4 sources are supported; embed resolution is not implemented");
}

module.exports = {
  getHome: getHome,
  getCatalog: getCatalog,
  getCatalogFilters: getCatalogFilters,
  search: search,
  getDetails: getDetails,
  getStreams: getStreams,
  resolveStreamOption: resolveStreamOption,
  onSettings: onSettings,
  __test: {
    mediaItem: mediaItem,
    mapHome: mapHome,
    mapCatalog: mapCatalog,
    catalogGenres: catalogGenres,
    mapCatalogByGenre: mapCatalogByGenre,
    mapSearch: mapSearch,
    mapDetails: mapDetails,
    decodeSourceBody: decodeSourceBody,
    classifySource: classifySource,
    mapStreams: mapStreams,
    mapSubtitles: mapSubtitles,
    parseExplicitNumber: parseExplicitNumber,
    publicHttpUrl: publicHttpUrl,
    approvedBaseUrl: approvedBaseUrl,
    endpointPath: endpointPath,
    readConfig: readConfig,
    decodeRemoteHostValue: decodeRemoteHostValue,
    homeSchemaIsValid: homeSchemaIsValid,
    isHtmlOrChallengeBody: isHtmlOrChallengeBody
  }
};
