"use strict";

// The route components below are the public constants used by the maintained
// CloudStream DramaWorld client. They are API route identifiers, not session
// credentials. Firebase remains optional and only updates the content hosts.
var PLUGIN_ID = "dramaworld";
var PLUGIN_VERSION = "0.3.7";
var FIREBASE_PROJECT_ID = "alamaldrama2022v2";
var API_ROUTE_KEY = "4F5A9C3D9A86FA54EACEDDD635185";
var API_ROUTE_ID = "d506abfd-9fe2-4b71-b979-feff21bcad13";
var MAX_SOURCE_BODY_CHARS = 2 * 1024 * 1024;
var MAX_SOURCES = 100;
var MAX_SUBTITLES = 100;
var MAX_HTTP_BODY_CHARS = 1024 * 1024;
var MAX_EMBED_BODY_CHARS = 512 * 1024;
var MAX_REDIRECTS = 3;
var REQUEST_TIMEOUT_MS = 15000;
var EMBED_RESOLVE_TIMEOUT_MS = 10000;
var EMBED_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
var EMBED_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
var ALLOWED_API_SUFFIX = ".arabypros.com";
var KNOWN_WORKING_API = "https://dwapp.arabypros.com/api";
var KNOWN_FALLBACK_APIS = [
  "https://test.arabypros.com/api",
  "https://app.arabypros.com/api",
  "https://dr.arabypros.com/api"
];
var REMOTE_CONFIG_KEYS = ["API_URL", "API_URL2"];
var CATALOG_HOME_PREVIEW_LIMIT = 18;
var CATALOG_HOME_CONCURRENCY = 2;
var MAX_CATALOG_PAGE = 10000;
var CATALOG_DEFINITIONS = [
  { id: "latest-movies", title: "وصلت للتو", type: "movie", routeKind: "filter", sourceKind: "movie", order: "created", home: true },
  { id: "latest-series", title: "جديد الدراما", type: "series", routeKind: "filter", sourceKind: "serie", order: "created", home: true },
  { id: "top-imdb-movies", title: "روائع السينما", type: "movie", routeKind: "filter", sourceKind: "movie", order: "imdb", home: true },
  { id: "top-imdb-series", title: "دراما في القمة", type: "series", routeKind: "filter", sourceKind: "serie", order: "imdb", home: true },
  { id: "most-viewed-movies", title: "الأكثر مشاهدة", type: "movie", routeKind: "filter", sourceKind: "movie", order: "views", home: true },
  { id: "current-year-movies", title: "سينما هذا العام", type: "movie", routeKind: "year", sourceKind: "movie", order: "year", home: true }
];
// This display-only tier prioritizes hosts with verified resolver support. It
// never removes a source or changes the source-array index encoded in the
// option token. Hosts within the tier retain the API's original order.
var PROVEN_SERVER_PRIORITY_LABELS = ["71stream", "hanerix", "ult4vid", "okstream", "vidmoly"];

function fail(code, message) {
  var error = new Error(code + ": " + message);
  error.code = code;
  throw error;
}

function traceStreams(stage, counts, failureCode, diagnostic) {
  if (typeof console === "undefined" || !console.log) return;
  diagnostic = isObject(diagnostic) ? diagnostic : {};
  var event = {
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    stage: String(stage || "UNKNOWN").replace(/[^A-Z0-9_]/g, "").slice(0, 40),
    quickJsReached: true,
    sourceRows: Math.max(0, Number(counts && counts.sourceRows) || 0),
    options: Math.max(0, Number(counts && counts.options) || 0),
    streams: Math.max(0, Number(counts && counts.streams) || 0)
  };
  if (failureCode) event.failureCode = String(failureCode).replace(/[^A-Z0-9_]/g, "").slice(0, 64);
  var host = safeDiagnosticHost(diagnostic.host) || sourceHost(diagnostic.hostUrl);
  if (host) event.host = host;
  var status = Number(diagnostic.httpStatus);
  if (diagnostic.responseReceived !== false && isFinite(status) && status >= 100 && status <= 599) {
    event.httpStatus = Math.floor(status);
  }
  if (typeof diagnostic.responseReceived === "boolean") event.responseReceived = diagnostic.responseReceived;
  if (typeof diagnostic.videoExtracted === "boolean") event.videoExtracted = diagnostic.videoExtracted;
  if (diagnosticsEnabled()) {
    var mediaHost = safeDiagnosticHost(diagnostic.mediaHost || diagnostic.host);
    if (mediaHost) event.mediaHost = mediaHost;
    var mediaStatus = diagnosticNumber(diagnostic.mediaHttpStatus, 100, 599);
    if (mediaStatus !== null) event.mediaHttpStatus = mediaStatus;
    var contentType = diagnosticContentType(diagnostic.contentType);
    if (contentType) event.contentType = contentType;
    var mediaContentType = diagnosticContentType(diagnostic.mediaContentType);
    if (mediaContentType) event.mediaContentType = mediaContentType;
    var responseKind = diagnosticResponseKind(diagnostic.responseKind);
    if (responseKind) event.responseKind = responseKind;
    var mediaResponseKind = diagnosticResponseKind(diagnostic.mediaResponseKind);
    if (mediaResponseKind) event.mediaResponseKind = mediaResponseKind;
    ["candidateCount", "verifiedCount", "candidateIndex", "elapsedMs", "mediaElapsedMs"]
      .forEach(function (key) {
        var max = key.indexOf("Count") >= 0 ? MAX_SOURCES : key.indexOf("Index") >= 0 ? MAX_SOURCES - 1 : 600000;
        var value = diagnosticNumber(diagnostic[key], 0, max);
        if (value !== null) event[key] = value;
      });
    if (Array.isArray(diagnostic.parserIds)) {
      var allowedParserIds = ["uqload", "json", "jwplayer", "packer", "direct-text"];
      var parserIds = diagnostic.parserIds.filter(function (id) { return allowedParserIds.indexOf(id) >= 0; });
      if (parserIds.length) event.parserIds = parserIds.slice(0, allowedParserIds.length);
    }
    if (/^c[1-9][0-9]?$/.test(String(diagnostic.acceptedCandidateId || ""))) {
      event.acceptedCandidateId = String(diagnostic.acceptedCandidateId);
    }
    if (["uqload", "json", "jwplayer", "packer", "direct-text"].indexOf(diagnostic.acceptedParserId) >= 0) {
      event.acceptedParserId = diagnostic.acceptedParserId;
    }
    if (diagnostic.candidateFailureCode) {
      event.candidateFailureCode = String(diagnostic.candidateFailureCode).replace(/[^A-Z0-9_]/g, "").slice(0, 64);
    }
  }
  console.log("DRAMAWORLD_STREAM_TRACE " + JSON.stringify(event));
}

function diagnosticsEnabled() {
  var settings = typeof SCRAPER_SETTINGS !== "undefined" && isObject(SCRAPER_SETTINGS)
    ? SCRAPER_SETTINGS : {};
  return settings.debugResolverDiagnostics === true;
}

function diagnosticNumber(value, minimum, maximum) {
  var number = Number(value);
  return isFinite(number) && number >= minimum && number <= maximum ? Math.floor(number) : null;
}

function safeDiagnosticHost(value) {
  if (typeof value !== "string") return null;
  var host = value.toLowerCase().replace(/\.$/, "");
  return host.length <= 253 && /^[a-z0-9.-]+$/.test(host) && host.indexOf("..") < 0 ? host : null;
}

function diagnosticContentType(value) {
  if (typeof value !== "string") return null;
  var mime = value.split(";")[0].trim().toLowerCase();
  var allowed = ["text/html", "application/xhtml+xml", "application/json", "text/plain",
    "application/vnd.apple.mpegurl", "application/x-mpegurl", "video/mp4", "application/octet-stream"];
  return allowed.indexOf(mime) >= 0 ? mime : (mime ? "other" : null);
}

function diagnosticResponseKind(value) {
  return ["html", "json", "hls", "mp4", "dash", "unknown"].indexOf(value) >= 0 ? value : null;
}

function responseKindFromBody(contentType, body) {
  if (/^(?:text\/html|application\/xhtml\+xml)$/i.test(diagnosticContentType(contentType) || "") ||
      (typeof body === "string" && /^\s*(?:<!doctype\s+html|<html|<body)\b/i.test(body.slice(0, 1024)))) return "html";
  if (typeof body === "string" && /^\s*#EXTM3U(?:\s|$)/i.test(body)) return "hls";
  if (typeof body === "string" && body.length >= 8 && body.slice(4, 8) === "ftyp") return "mp4";
  if (body && typeof body.byteLength === "number" && typeof Uint8Array !== "undefined") {
    var bytes = new Uint8Array(body, 0, Math.min(body.byteLength, 1024));
    var prefix = "";
    for (var index = 0; index < Math.min(bytes.length, 1024); index += 1) prefix += String.fromCharCode(bytes[index]);
    if (/^\s*(?:<!doctype\s+html|<html|<body)\b/i.test(prefix)) return "html";
    if (/^\s*#EXTM3U(?:\s|$)/i.test(prefix)) return "hls";
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "mp4";
  }
  return "unknown";
}

function traceDetailed(stage, counts, failureCode, diagnostic) {
  if (!diagnosticsEnabled()) return;
  traceStreams(stage, counts, failureCode, diagnostic);
}

function failStream(code, message, diagnostic) {
  var error = new Error(code + ": " + message);
  error.code = code;
  if (isObject(diagnostic)) {
    error.diagnostic = {
      hostUrl: text(diagnostic.hostUrl),
      httpStatus: Number.isFinite(Number(diagnostic.httpStatus)) ? Number(diagnostic.httpStatus) : null,
      responseReceived: diagnostic.responseReceived === true
    };
    ["contentType", "responseKind", "mediaHost", "mediaContentType", "mediaResponseKind",
      "candidateCount", "verifiedCount", "candidateIndex", "elapsedMs", "mediaElapsedMs", "mediaHttpStatus"]
      .forEach(function (key) {
        if (diagnostic[key] !== undefined && diagnostic[key] !== null) error.diagnostic[key] = diagnostic[key];
      });
  }
  throw error;
}

function traceStreamFailure(error, stage, counts, fallbackHostUrl) {
  var diagnostic = error && isObject(error.diagnostic) ? error.diagnostic : {};
  traceStreams(stage, counts, error && error.code || "DRAMAWORLD_STREAM_RESOLVE_FAILED", {
    hostUrl: diagnostic.hostUrl || fallbackHostUrl,
    httpStatus: diagnostic.httpStatus,
    responseReceived: diagnostic.responseReceived === true,
    videoExtracted: false,
    contentType: diagnostic.contentType,
    responseKind: diagnostic.responseKind,
    mediaHost: diagnostic.mediaHost,
    mediaHttpStatus: diagnostic.mediaHttpStatus,
    mediaContentType: diagnostic.mediaContentType,
    mediaResponseKind: diagnostic.mediaResponseKind,
    candidateCount: diagnostic.candidateCount,
    verifiedCount: diagnostic.verifiedCount,
    candidateIndex: diagnostic.candidateIndex,
    candidateFailureCode: error && error.code,
    elapsedMs: diagnostic.elapsedMs,
    mediaElapsedMs: diagnostic.mediaElapsedMs
  });
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

function catalogDefinition(catalogId) {
  for (var index = 0; index < CATALOG_DEFINITIONS.length; index += 1) {
    if (CATALOG_DEFINITIONS[index].id === catalogId) return CATALOG_DEFINITIONS[index];
  }
  return null;
}

function catalogRows(value) {
  var data = unwrapData(value);
  if (Array.isArray(data)) return data;
  if (isObject(data) && Array.isArray(data.posters)) return data.posters;
  return null;
}

function catalogItemsFingerprint(items) {
  var material = items.map(function (item) { return item.nativeId; }).sort().join("|");
  var hash = 2166136261;
  for (var index = 0; index < material.length; index += 1) {
    hash = Math.imul(hash ^ material.charCodeAt(index), 16777619) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function parseCatalogCursor(value) {
  var cursor = text(value);
  if (!cursor) return { page: 0, previousFingerprint: null };
  var match = /^p:([0-9]{1,5}):([0-9a-f]{8})$/i.exec(cursor);
  if (!match || Number(match[1]) > MAX_CATALOG_PAGE) {
    fail("DRAMAWORLD_INVALID_CURSOR", "catalog cursor is invalid or outside the supported range");
  }
  return { page: Number(match[1]), previousFingerprint: match[2].toLowerCase() };
}

function catalogRoute(definition, page) {
  if (definition.routeKind === "filter") {
    return definition.sourceKind + "/by/filtres/0/" + definition.order + "/" + page;
  }
  if (definition.routeKind === "year") {
    var currentYear = new Date().getUTCFullYear();
    if (currentYear < 1900 || currentYear > 2100) {
      fail("DRAMAWORLD_YEAR_INVALID", "current year is outside the supported range");
    }
    return "poster/by/year/" + currentYear + "/" + definition.sourceKind + "/" + page;
  }
  fail("DRAMAWORLD_INVALID_CATALOG", "catalog route is not supported");
}

function traceCatalogPage(catalogId, page, itemCount, hasMore, elapsedMs, failureCode) {
  if (!diagnosticsEnabled() || typeof console === "undefined" || !console.log) return;
  var event = {
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    catalogId: catalogId,
    page: page,
    itemCount: itemCount,
    hasMore: hasMore === true,
    elapsedMs: Math.max(0, Math.floor(Number(elapsedMs) || 0))
  };
  if (failureCode) event.failureCode = String(failureCode).replace(/[^A-Z0-9_]/g, "").slice(0, 64);
  console.log("DRAMAWORLD_CATALOG_TRACE " + JSON.stringify(event));
}

async function requestCatalogPage(config, definition, cursorValue) {
  var cursor = parseCatalogCursor(cursorValue);
  var path = catalogRoute(definition, cursor.page);
  var startedAt = Date.now();
  try {
    var raw = await requestValidatedJson(config, endpointPath(config, path), function (value) {
      return catalogRows(value) !== null;
    }, "DRAMAWORLD_CATALOG_INVALID", "DramaWorld catalog JSON did not match the expected list contract");
    var rows = catalogRows(raw);
    var items = uniqueItems(rows, definition.type);
    if (rows.length && !items.length) {
      fail("DRAMAWORLD_CATALOG_INVALID", "DramaWorld catalog rows contained no valid items of the declared type");
    }
    var fingerprint = catalogItemsFingerprint(items);
    if (items.length && cursor.previousFingerprint === fingerprint) {
      traceCatalogPage(definition.id, cursor.page, 0, false, Date.now() - startedAt, "DRAMAWORLD_REPEATED_PAGE");
      return { catalogId: definition.id, items: [], page: { hasMore: false } };
    }
    var hasMore = items.length > 0;
    var page = { hasMore: hasMore };
    if (hasMore) page.nextCursor = "p:" + (cursor.page + 1) + ":" + fingerprint;
    traceCatalogPage(definition.id, cursor.page, items.length, hasMore, Date.now() - startedAt, null);
    return { catalogId: definition.id, items: items, page: page };
  } catch (error) {
    traceCatalogPage(definition.id, cursor.page, 0, false, Date.now() - startedAt,
      error && error.code || "DRAMAWORLD_CATALOG_FAILED");
    throw error;
  }
}

async function catalogHomeSections(config) {
  var definitions = CATALOG_DEFINITIONS.filter(function (definition) { return definition.home === true; });
  var sections = new Array(definitions.length);
  var failures = [];
  var nextIndex = 0;
  async function worker() {
    while (nextIndex < definitions.length) {
      var index = nextIndex++;
      var definition = definitions[index];
      try {
        var result = await requestCatalogPage(config, definition, null);
        if (result.items.length) {
          sections[index] = {
            id: definition.id,
            title: definition.title,
            items: result.items.slice(0, CATALOG_HOME_PREVIEW_LIMIT),
            hasMore: result.page.hasMore,
            nextPage: result.page.nextCursor
          };
        }
      } catch (_) {
        failures.push(definition.id);
      }
    }
  }
  var workers = [];
  for (var workerIndex = 0; workerIndex < Math.min(CATALOG_HOME_CONCURRENCY, definitions.length); workerIndex += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (failures.length) {
    fail("DRAMAWORLD_HOME_CATALOG_FAILED", "one or more DramaWorld Home catalogs could not be loaded");
  }
  return sections.filter(Boolean);
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

async function fetchSubtitlesForIdentity(config, identity) {
  var startedAt = Date.now();
  var subtitleRoute = identity.kind === "movie"
    ? "subtitles/by/movie/" + identity.id
    : "subtitles/by/episode/" + identity.id;
  try {
    var rawSubtitles = await requestValidatedJson(config, endpointPath(config, subtitleRoute), function (value) {
      var data = unwrapData(value);
      return Array.isArray(value) || Array.isArray(data);
    }, "DRAMAWORLD_SUBTITLES_INVALID", "DramaWorld returned invalid subtitle data");
    return { subtitles: mapSubtitles(rawSubtitles), elapsedMs: Date.now() - startedAt, available: true };
  } catch (subtitleError) {
    if (isCancellation(subtitleError)) throw subtitleError;
    if (typeof console !== "undefined" && console.warn) console.warn("DramaWorld subtitle list unavailable");
    return { subtitles: [], elapsedMs: Date.now() - startedAt, available: false };
  }
}

function attachSubtitles(streams, subtitles) {
  if (!Array.isArray(streams) || !Array.isArray(subtitles) || !subtitles.length) return streams;
  streams.forEach(function (stream) {
    if (isObject(stream)) stream.subtitles = subtitles;
  });
  return streams;
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
      headers: safeSourceHeaders(source),
      subtitles: Array.isArray(subtitles) ? subtitles : []
    };
    var size = text(source.size);
    if (quality) stream.quality = quality;
    if (size) stream.size = size;
    streams.push(stream);
  });
  return { streams: streams };
}

function safeSourceIdentifier(source) {
  if (!isObject(source) || source.id === null || source.id === undefined) return "";
  var value = typeof source.id === "number" && isFinite(source.id) ? String(source.id) : text(source.id);
  return value && value.length <= 96 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : "";
}

function sourceHost(url) {
  var match = /^https:\/\/([a-z0-9.-]+)(?::[0-9]{1,5})?(?:\/|$)/i.exec(text(url) || "");
  return match ? match[1].toLowerCase() : "";
}

function serverPriorityEnabled() {
  var settings = typeof SCRAPER_SETTINGS !== "undefined" && isObject(SCRAPER_SETTINGS)
    ? SCRAPER_SETTINGS : {};
  return settings.prioritizeVerifiedServers !== false;
}

function isProvenPriorityHost(url) {
  var host = sourceHost(url);
  if (!host) return false;
  var labels = host.split(".");
  return PROVEN_SERVER_PRIORITY_LABELS.some(function (label) {
    return labels.indexOf(label) >= 0;
  });
}

function stableSourceFingerprint(source, identity, index) {
  var material = [
    identity.kind,
    identity.id,
    String(index),
    safeSourceIdentifier(source),
    sourceHost(source.url),
    text(source.type) || "",
    text(source.name) || text(source.server) || text(source.title) || ""
  ].join("|");
  var hash = 2166136261;
  for (var cursor = 0; cursor < material.length; cursor += 1) {
    hash = Math.imul(hash ^ material.charCodeAt(cursor), 16777619) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function sourceOptionToken(source, identity, index) {
  return "dwopt1:" + identity.kind + ":" + identity.id + ":" + index + ":" +
    stableSourceFingerprint(source, identity, index);
}

function parseSourceOptionToken(value) {
  var token = text(value);
  var match = token && /^dwopt1:(movie|episode):([1-9][0-9]*):([0-9]{1,3}):([0-9a-f]{8})$/i.exec(token);
  if (!match || Number(match[3]) >= MAX_SOURCES) {
    fail("DRAMAWORLD_OPTION_TOKEN_INVALID", "selected DramaWorld server is invalid or expired");
  }
  return { kind: match[1], id: match[2], index: Number(match[3]), fingerprint: match[4].toLowerCase() };
}

function mapStreamOptions(sourceRows, identity) {
  var sources = decodeSourceBody(sourceRows);
  var seen = Object.create(null);
  var entries = [];
  sources.forEach(function (source, index) {
    if (!isObject(source) || source.external === true || entries.length >= MAX_SOURCES) return;
    var url = publicHttpUrl(source.url);
    if (!url || !/^https:\/\//i.test(url) || seen[url]) return;
    seen[url] = true;
    var direct = classifySource(source);
    // Keep the original server number and token index even when its card is
    // promoted. resolveStreamOption therefore still resolves the exact row the
    // user selected after the source list is fetched again.
    entries.push({
      priority: isProvenPriorityHost(url),
      option: {
        token: sourceOptionToken(source, identity, index),
        title: "سيرفر " + (index + 1),
        name: "سيرفر " + (index + 1),
        type: direct ? direct.type : "embed",
        quality: direct ? direct.quality : null
      }
    });
  });
  if (!serverPriorityEnabled()) return entries.map(function (entry) { return entry.option; });
  return entries.filter(function (entry) { return entry.priority; })
    .concat(entries.filter(function (entry) { return !entry.priority; }))
    .map(function (entry) { return entry.option; });
}

function qualityRank(value) {
  var match = /([0-9]{3,4})\s*p?/i.exec(text(value) || "");
  return match ? Number(match[1]) : 0;
}

function collectMediaCandidate(value, quality, output) {
  var rawUrl = typeof value === "string" ? value : (isObject(value) ? text(value.file) || text(value.url) : null);
  var url = text(rawUrl);
  if (!url) return;
  url = url.replace(/\\\//g, "/").replace(/&amp;/gi, "&").replace(/[),;]+$/, "");
  var direct = classifySource({ url: url, type: "direct" });
  if (!direct) return;
  if (output.some(function (entry) { return entry.url === direct.url; })) return;
  output.push({ url: direct.url, type: direct.type, quality: text(quality) || null, rank: qualityRank(quality) });
}

function parseMediaJson(value, output, depth) {
  if (depth > 2 || (!isObject(value) && !Array.isArray(value))) return;
  if (Array.isArray(value)) {
    value.forEach(function (entry) { collectMediaCandidate(entry, isObject(entry) ? entry.label || entry.quality : null, output); });
    return;
  }
  if (Array.isArray(value.availableQualities)) {
    value.availableQualities.forEach(function (entry) {
      if (isObject(entry)) collectMediaCandidate(entry.url || entry.file, entry.quality || entry.label, output);
    });
  }
  var content = Array.isArray(value.filtered_content) ? value.filtered_content : null;
  var qualities = Array.isArray(value.Quality) ? value.Quality : (Array.isArray(value.qualities) ? value.qualities : []);
  if (content) content.forEach(function (entry, index) {
    collectMediaCandidate(entry, qualities[index] || (isObject(entry) ? entry.label || entry.quality : null), output);
  });
  [value.sources, value.links].forEach(function (collection) {
    if (Array.isArray(collection)) collection.forEach(function (entry) {
      collectMediaCandidate(entry, isObject(entry) ? entry.label || entry.quality : null, output);
    });
  });
  collectMediaCandidate(value.file || value.url, value.quality || value.label, output);
  if (isObject(value.data) || Array.isArray(value.data)) parseMediaJson(value.data, output, depth + 1);
}

function parseDirectMediaCandidates(body) {
  if (typeof body !== "string" || !body.trim() || body.length > MAX_EMBED_BODY_CHARS) return [];
  if (/(?:cf-mitigated|challenge-platform|__cf_chl|just a moment|checking your browser)/i.test(body.slice(0, 8192))) {
    fail("DRAMAWORLD_HOST_CHALLENGE", "selected server returned a browser or access challenge");
  }
  var output = [];
  var trimmed = body.replace(/\\\//g, "/").replace(/&amp;/gi, "&").trim();
  if (/^[\[{]/.test(trimmed)) {
    try { parseMediaJson(JSON.parse(trimmed), output, 0); } catch (error) {
      if (error && error.code) throw error;
    }
  }
  var filePattern = /(?:file|url)\s*[:=]\s*["'](https:\/\/[^"']+)["']/ig;
  var match;
  while ((match = filePattern.exec(trimmed)) !== null) collectMediaCandidate(match[1], null, output);
  var urlPattern = /(https:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?)/ig;
  while ((match = urlPattern.exec(trimmed)) !== null) collectMediaCandidate(match[1], null, output);
  return output.sort(function (left, right) {
    return right.rank - left.rank;
  });
}

function safeEmbedRedirect(location, currentUrl) {
  var value = text(location);
  if (!value || /[\u0000-\u0020\\]/.test(value)) {
    fail("DRAMAWORLD_EMBED_REDIRECT_REJECTED", "selected server redirected to an invalid address");
  }
  var target;
  if (/^https:\/\//i.test(value)) target = value;
  else if (value.charAt(0) === "/" && value.charAt(1) !== "/") target = urlOrigin(currentUrl) + value;
  else fail("DRAMAWORLD_EMBED_REDIRECT_REJECTED", "selected server used an unsupported redirect");
  if (!publicHttpUrl(target) || !/^https:\/\//i.test(target)) {
    fail("DRAMAWORLD_EMBED_REDIRECT_REJECTED", "selected server redirect was not a public HTTPS address");
  }
  return target;
}

async function fetchEmbedBody(url) {
  var stageStartedAt = Date.now();
  var currentUrl = url;
  traceDetailed("EMBED_FETCH_START", { options: 1, streams: 0 }, null, { hostUrl: currentUrl, elapsedMs: 0 });
  for (var redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    var response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
          "User-Agent": EMBED_USER_AGENT,
          "Accept-Language": EMBED_ACCEPT_LANGUAGE
        },
        redirect: "manual",
        timeoutMs: EMBED_RESOLVE_TIMEOUT_MS
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      var networkCode = error && error.name === "TimeoutError"
        ? "DRAMAWORLD_EMBED_TIMEOUT"
        : "DRAMAWORLD_EMBED_NETWORK_ERROR";
      failStream(networkCode,
        networkCode === "DRAMAWORLD_EMBED_TIMEOUT" ? "selected server request timed out" : "selected server could not be reached",
        { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, elapsedMs: Date.now() - stageStartedAt,
          responseKind: "unknown" });
    }
    var status = Number(response && response.status) || 0;
    var location = response && response.headers && response.headers.get("location");
    if (status >= 300 && status < 400) {
      if (redirectCount >= MAX_REDIRECTS) {
        failStream("DRAMAWORLD_EMBED_REDIRECT_LIMIT", "selected server redirected too many times",
          { hostUrl: currentUrl, httpStatus: status, responseReceived: true, elapsedMs: Date.now() - stageStartedAt });
      }
      try {
        currentUrl = safeEmbedRedirect(location, currentUrl);
      } catch (error) {
        if (error && !error.diagnostic) {
          error.diagnostic = { hostUrl: currentUrl, httpStatus: status, responseReceived: true,
            elapsedMs: Date.now() - stageStartedAt };
        }
        throw error;
      }
      continue;
    }
    if (response && response.networkError) {
      failStream("DRAMAWORLD_EMBED_NETWORK_ERROR", "selected server could not be reached",
        { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, elapsedMs: Date.now() - stageStartedAt,
          responseKind: "unknown" });
    }
    if (status === 401 || status === 403) {
      failStream("DRAMAWORLD_EMBED_ACCESS_DENIED", "selected server denied the request",
        { hostUrl: currentUrl, httpStatus: status, responseReceived: true, elapsedMs: Date.now() - stageStartedAt,
          contentType: response.headers && response.headers.get("content-type"), responseKind: "unknown" });
    }
    if (!response || response.ok === false || status < 200 || status >= 300) {
      failStream("DRAMAWORLD_EMBED_HTTP_ERROR", "selected server returned HTTP " + (status || "error"),
        { hostUrl: currentUrl, httpStatus: status, responseReceived: status > 0, elapsedMs: Date.now() - stageStartedAt,
          contentType: response && response.headers && response.headers.get("content-type"), responseKind: "unknown" });
    }
    var finalUrl = publicHttpUrl(response.url || currentUrl);
    if (!finalUrl || !/^https:\/\//i.test(finalUrl)) {
      failStream("DRAMAWORLD_EMBED_REDIRECT_REJECTED", "selected server returned an unsafe address",
        { hostUrl: currentUrl, httpStatus: status, responseReceived: true, elapsedMs: Date.now() - stageStartedAt });
    }
    var body = await response.text();
    var contentType = text(response.headers && response.headers.get("content-type")) || "";
    var responseKind = responseKindFromBody(contentType, body);
    if (typeof body !== "string" || !body) {
      failStream("DRAMAWORLD_EMBED_RESPONSE_INVALID", "selected server returned no content",
        { hostUrl: finalUrl, httpStatus: status, responseReceived: true, contentType: contentType,
          responseKind: responseKind, elapsedMs: Date.now() - stageStartedAt });
    }
    if (body.length > MAX_EMBED_BODY_CHARS || body.indexOf("...[truncated]") >= 0) {
      failStream("DRAMAWORLD_EMBED_RESPONSE_TOO_LARGE", "selected server response exceeded the safe size limit",
        { hostUrl: finalUrl, httpStatus: status, responseReceived: true, contentType: contentType,
          responseKind: responseKind, elapsedMs: Date.now() - stageStartedAt });
    }
    traceDetailed("EMBED_FETCH_RESULT", { options: 1, streams: 0 }, null, {
      hostUrl: finalUrl, httpStatus: status, responseReceived: true, contentType: contentType,
      responseKind: responseKind, elapsedMs: Date.now() - stageStartedAt
    });
    return { body: body, finalUrl: finalUrl, httpStatus: status, contentType: contentType, responseReceived: true };
  }
  failStream("DRAMAWORLD_EMBED_REDIRECT_LIMIT", "selected server redirected too many times",
    { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, elapsedMs: Date.now() - stageStartedAt });
}

function playbackHeadersForEmbed(embedUrl, source) {
  var origin = urlOrigin(embedUrl);
  if (!origin) fail("DRAMAWORLD_EMBED_URL_INVALID", "selected server address is invalid");
  var headers = {
    "User-Agent": EMBED_USER_AGENT,
    "Accept-Language": EMBED_ACCEPT_LANGUAGE,
    "Referer": origin + "/"
  };
  // Odnoklassniki's documented extractor contract requests its signed media
  // candidates with the embed origin. This is non-secret request context, and
  // Yume's header policy forwards it only while it matches the sanitized
  // Referer origin; no Cookie or Authorization value is synthesized.
  var trustedHeaders = safeSourceHeaders(source);
  Object.keys(trustedHeaders).forEach(function (key) { headers[key] = trustedHeaders[key]; });
  var embedHost = sourceHost(embedUrl);
  if (embedHost === "ok.ru" || embedHost === "m.ok.ru" ||
      embedHost === "odnoklassniki.ru" || embedHost === "m.odnoklassniki.ru") {
    headers.Origin = origin;
  }
  return headers;
}

async function verifyMediaCandidate(candidate, embedUrl, source, candidateIndex, candidateCount) {
  var stageStartedAt = Date.now();
  var currentUrl = candidate.url;
  var headers = playbackHeadersForEmbed(embedUrl, source);
  headers.Accept = candidate.type === "hls"
    ? "application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.5"
    : "video/mp4, application/octet-stream, */*;q=0.5";
  headers.Range = "bytes=0-1023";

  for (var redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    var response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        headers: headers,
        redirect: "manual",
        timeoutMs: EMBED_RESOLVE_TIMEOUT_MS
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      var networkCode = error && error.name === "TimeoutError"
        ? "DRAMAWORLD_MEDIA_TIMEOUT"
        : "DRAMAWORLD_MEDIA_NETWORK_ERROR";
      failStream(networkCode,
        networkCode === "DRAMAWORLD_MEDIA_TIMEOUT" ? "direct media validation timed out" : "direct media could not be reached",
        { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, candidateIndex: candidateIndex,
          candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt, responseKind: "unknown" });
    }

    var status = Number(response && response.status) || 0;
    var location = response && response.headers && response.headers.get("location");
    if (status >= 300 && status < 400) {
      if (redirectCount >= MAX_REDIRECTS) {
        failStream("DRAMAWORLD_MEDIA_REDIRECT_LIMIT", "direct media redirected too many times",
          { hostUrl: currentUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
            candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt });
      }
      try {
        currentUrl = safeEmbedRedirect(location, currentUrl);
      } catch (error) {
        if (error && !error.diagnostic) {
          error.diagnostic = { hostUrl: currentUrl, httpStatus: status, responseReceived: true,
            candidateIndex: candidateIndex, candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt };
        }
        throw error;
      }
      continue;
    }
    if (response && response.networkError) {
      failStream("DRAMAWORLD_MEDIA_NETWORK_ERROR", "direct media could not be reached",
        { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, candidateIndex: candidateIndex,
          candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt, responseKind: "unknown" });
    }
    if (status === 401 || status === 403) {
      failStream("DRAMAWORLD_MEDIA_ACCESS_DENIED", "direct media denied the validation request",
        { hostUrl: currentUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
          candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt,
          contentType: response.headers && response.headers.get("content-type"), responseKind: "unknown" });
    }
    if (!response || response.ok === false || status < 200 || status >= 300) {
      failStream("DRAMAWORLD_MEDIA_HTTP_ERROR", "direct media returned HTTP " + (status || "error"),
        { hostUrl: currentUrl, httpStatus: status, responseReceived: status > 0, candidateIndex: candidateIndex,
          candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt,
          contentType: response && response.headers && response.headers.get("content-type"), responseKind: "unknown" });
    }

    var finalUrl = publicHttpUrl(response.url || currentUrl);
    if (!finalUrl || !/^https:\/\//i.test(finalUrl)) {
      failStream("DRAMAWORLD_MEDIA_REDIRECT_REJECTED", "direct media returned an unsafe address",
        { hostUrl: currentUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
          candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt });
    }
    var contentType = text(response.headers && response.headers.get("content-type")) || "";
    var valid = false;
    var responseKind = "unknown";
    if (candidate.type === "hls") {
      var playlist = await response.text();
      responseKind = responseKindFromBody(contentType, playlist);
      if (typeof playlist !== "string" || !playlist) {
        failStream("DRAMAWORLD_MEDIA_RESPONSE_INVALID", "direct media returned no playlist content",
          { hostUrl: finalUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
            candidateCount: candidateCount, contentType: contentType, responseKind: responseKind,
            elapsedMs: Date.now() - stageStartedAt });
      }
      if (/(?:cf-mitigated|challenge-platform|__cf_chl|just a moment|checking your browser)/i.test(playlist.slice(0, 8192))) {
        failStream("DRAMAWORLD_HOST_CHALLENGE", "direct media returned an access challenge",
          { hostUrl: finalUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
            candidateCount: candidateCount, contentType: contentType, responseKind: "html",
            elapsedMs: Date.now() - stageStartedAt });
      }
      valid = /^\s*#EXTM3U(?:\s|$)/i.test(playlist) &&
        !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType) && !/<\s*html/i.test(playlist.slice(0, 1024));
    } else if (candidate.type === "mp4") {
      var prefix = "";
      if (response.arrayBuffer) {
        var buffer = await response.arrayBuffer();
        var bytes = new Uint8Array(buffer);
        responseKind = responseKindFromBody(contentType, buffer);
        var prefixLength = Math.min(bytes.length, 64);
        for (var byteIndex = 0; byteIndex < prefixLength; byteIndex += 1) {
          prefix += String.fromCharCode(bytes[byteIndex]);
        }
      } else {
        prefix = await response.text();
        responseKind = responseKindFromBody(contentType, prefix);
      }
      if (/(?:cf-mitigated|challenge-platform|__cf_chl|just a moment|checking your browser)/i.test(prefix.slice(0, 8192)) ||
          /^\s*(?:<!doctype\s+html|<html|\{\s*"(?:error|message)")/i.test(prefix)) {
        failStream("DRAMAWORLD_MEDIA_RESPONSE_INVALID", "direct media returned a page instead of a video file",
          { hostUrl: finalUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
            candidateCount: candidateCount, contentType: contentType, responseKind: "html",
            elapsedMs: Date.now() - stageStartedAt });
      }
      valid = /^(?:video\/mp4|application\/octet-stream)$/i.test(contentType) && prefix.indexOf("ftyp") >= 0;
    }

    if (!valid) {
      failStream("DRAMAWORLD_MEDIA_RESPONSE_INVALID", "direct URL did not return a recognizable HLS playlist or MP4 file",
        { hostUrl: finalUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
          candidateCount: candidateCount, contentType: contentType, responseKind: responseKind,
          elapsedMs: Date.now() - stageStartedAt });
    }
    var playbackHeaders = YUME_DRAMAWORLD_LOCAL_RESOLVER &&
      typeof YUME_DRAMAWORLD_LOCAL_RESOLVER.headersForSubresource === "function"
      ? YUME_DRAMAWORLD_LOCAL_RESOLVER.headersForSubresource(headers, candidate.url, finalUrl)
      : headers;
    traceDetailed("MEDIA_CANDIDATE_VALID", { options: 1, streams: 1 }, null, {
      hostUrl: finalUrl, httpStatus: status, responseReceived: true, candidateIndex: candidateIndex,
      candidateCount: candidateCount, verifiedCount: 1, contentType: contentType,
      responseKind: responseKind, elapsedMs: Date.now() - stageStartedAt
    });
    return {
      url: finalUrl, httpStatus: status, hostUrl: finalUrl, responseReceived: true,
      body: candidate.type === "hls" ? playlist : null,
      contentType: contentType,
      playbackHeaders: playbackHeaders
    };
  }

  failStream("DRAMAWORLD_MEDIA_REDIRECT_LIMIT", "direct media redirected too many times",
    { hostUrl: currentUrl, httpStatus: 0, responseReceived: false, candidateIndex: candidateIndex,
      candidateCount: candidateCount, elapsedMs: Date.now() - stageStartedAt });
}

function safeSourceHeaders(source) {
  var inputHeaders = isObject(source.headers) ? source.headers : {};
  var headers = {};
  Object.keys(inputHeaders).forEach(function (key) {
    var normalized = key.toLowerCase();
    if (["user-agent", "accept-language", "referer", "origin"].indexOf(normalized) < 0) return;
    var value = text(inputHeaders[key]);
    if (!value || value.length > 2048 || /[\r\n\u0000]/.test(value)) return;
    if ((normalized === "referer" || normalized === "origin") &&
        (!/^https:\/\//i.test(value) || !publicHttpUrl(value))) return;
    var canonical = normalized === "user-agent" ? "User-Agent" : normalized === "accept-language" ? "Accept-Language" :
      normalized === "referer" ? "Referer" : "Origin";
    headers[canonical] = value;
  });
  return headers;
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
    { type: "header", label: "DramaWorld · 0.3.7" },
    { type: "toggle", key: "localPackedResolver", label: "المحلّل المحلي الاحتياطي", defaultValue: true, description: "يعمل عند الحاجة بعد المسار المباشر، ويفك Packer نصياً دون WebView أو خدمات استخراج خارجية." },
    { type: "toggle", key: "universalExtractorEnabled", label: "محرك Yume المركزي", defaultValue: true, description: "يجرب المحرك المركزي أولاً ثم يعود مرة واحدة إلى المحلّل المحلي عند الفشل. عطّل هذا الخيار للرجوع الفوري إلى Legacy Only." },
    { type: "toggle", key: "prioritizeVerifiedServers", label: "ترتيب السيرفرات المدعومة أولاً", defaultValue: true, description: "يعرض السيرفرات ذات الدعم المثبت أولاً مع الاحتفاظ بجميع السيرفرات وفهارسها الأصلية. عطّله لاستعادة ترتيب المصدر الأصلي." },
    { type: "toggle", key: "debugResolverDiagnostics", label: "تشخيص تقني منقّح", defaultValue: false, description: "سجلات اختيارية للمضيف والمرحلة والحالة ونوع الاستجابة والزمن والعدادات فقط؛ لا تسجل الروابط أو معاملات الاستعلام أو بيانات الاعتماد أو محتوى الصفحة." },
    { type: "info", label: "Universal First هو المسار الافتراضي مع رجوع Legacy واحد. يمكن الرجوع فوراً إلى Legacy Only من الإعدادات." }
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
  return { sections: await catalogHomeSections(config) };
}

async function getCatalog(args) {
  args = isObject(args) ? args : {};
  var catalogId = text(args.catalogId);
  var definition = catalogDefinition(catalogId);
  if (!definition) fail("DRAMAWORLD_INVALID_CATALOG", "unknown DramaWorld catalog");
  var requestedType = normalizeType(args.type);
  if (requestedType && requestedType !== definition.type) {
    fail("DRAMAWORLD_INVALID_CATALOG", "catalog type does not match the declared DramaWorld catalog");
  }
  var filters = isObject(args.filters) ? args.filters : {};
  Object.keys(filters).forEach(function (key) {
    fail("DRAMAWORLD_INVALID_FILTER", "this DramaWorld catalog does not accept filters");
  });
  var config = await readConfig();
  return requestCatalogPage(config, definition, args.cursor);
}

async function getCatalogFilters(args) {
  args = isObject(args) ? args : {};
  var catalogId = text(args.catalogId);
  if (!catalogDefinition(catalogId)) fail("DRAMAWORLD_INVALID_CATALOG", "unknown DramaWorld catalog");
  return { catalogId: catalogId, filters: [] };
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
  var configStartedAt = Date.now();
  var config = await readConfig();
  traceDetailed("CONFIG_RESULT", { sourceRows: 0, options: 0, streams: 0 }, null,
    { elapsedMs: Date.now() - configStartedAt });
  var route = identity.kind === "movie" ? "movie/source/by/" : "episode/source/by/";
  var apiStartedAt = Date.now();
  var sourceRows;
  try {
    sourceRows = await requestDecodedSources(config, endpointPath(config, route + identity.id));
  } catch (sourceError) {
    traceStreams("API_FAILURE", {}, sourceError && sourceError.code || "DRAMAWORLD_NETWORK_ERROR");
    throw sourceError;
  }
  var apiMs = Date.now() - apiStartedAt;
  var parsingStartedAt = Date.now();
  var options = mapStreamOptions(sourceRows, identity);
  if (args.mode === "options") {
    if (!options.length) {
      var optionFailure = sourceRows.length ? "DRAMAWORLD_NO_SUPPORTED_SOURCES" : "DRAMAWORLD_NO_SOURCES";
      traceStreams("OPTIONS_EMPTY", { sourceRows: sourceRows.length, options: 0, streams: 0 }, optionFailure);
      fail(optionFailure, sourceRows.length
        ? "DramaWorld returned sources, but none were safe HTTPS server links"
        : "DramaWorld returned no sources for this title");
    }
    traceDetailed("SOURCE_LIST_RESULT", { sourceRows: sourceRows.length, options: options.length, streams: 0 }, null,
      { elapsedMs: apiMs });
    traceStreams("OPTIONS_READY", { sourceRows: sourceRows.length, options: options.length, streams: 0 });
    return { options: options, timing: { apiMs: apiMs, parsingMs: Date.now() - parsingStartedAt } };
  }
  var subtitleResult = await fetchSubtitlesForIdentity(config, identity);
  traceDetailed("SUBTITLES_RESULT", { sourceRows: sourceRows.length, options: options.length, streams: 0 },
    subtitleResult.available ? null : "DRAMAWORLD_SUBTITLES_UNAVAILABLE", { elapsedMs: subtitleResult.elapsedMs });
  var result = mapStreams(sourceRows, subtitleResult.subtitles);
  result.options = options;
  result.timing = { apiMs: apiMs, parsingMs: Date.now() - parsingStartedAt };
  if (!result.streams.length && !result.options.length) {
    traceStreams("SOURCES_EMPTY", { sourceRows: sourceRows.length }, "DRAMAWORLD_NO_SUPPORTED_SOURCES");
    fail("DRAMAWORLD_NO_SUPPORTED_SOURCES", sourceRows.length
      ? "DramaWorld returned sources, but none were safe HTTPS server links"
      : "DramaWorld returned no sources for this title");
  }
  traceStreams("STREAMS_READY", { sourceRows: sourceRows.length, options: result.options.length, streams: result.streams.length });
  return result;
}

function localResolverEnabled() {
  var settings = typeof SCRAPER_SETTINGS !== "undefined" && isObject(SCRAPER_SETTINGS)
    ? SCRAPER_SETTINGS
    : {};
  return settings.localPackedResolver !== false;
}

function universalExtractorEnabled() {
  var settings = typeof SCRAPER_SETTINGS !== "undefined" && isObject(SCRAPER_SETTINGS)
    ? SCRAPER_SETTINGS : {};
  return settings.universalExtractorEnabled !== false && typeof __yume_extract_v1 === "function";
}

// Reduce native diagnostics to an allow-listed code; never forward URLs, headers, tokens, or
// exception text from the bridge into resolver logs.
function universalErrorCode(value) {
  var allowed = [
    "NETWORK_FAILURE", "DNS_FAILURE", "TIMEOUT", "NO_CANDIDATES",
    "MEDIA_SIGNATURE_INVALID", "HTTP_REFUSED", "CANCELLED"
  ];
  value = text(value);
  return value && allowed.indexOf(value) >= 0 ? value : null;
}

function universalEmptyReason(diagnostics, errorCode) {
  var topLevel = universalErrorCode(errorCode);
  if (topLevel) return topLevel;
  if (!Array.isArray(diagnostics)) return "NO_DIAGNOSTICS";
  var rows = diagnostics.filter(isObject);
  var outcomes = rows.filter(function (row) { return row.stage === "VERIFY_CANDIDATE"; })
    .map(function (row) { return row.outcome; });
  var known = [
    "DNS_FAILURE", "CONNECT_FAILURE", "NETWORK_TIMEOUT", "TIMEOUT", "HTTP_REFUSED",
    "HTTP_STATUS_ERROR", "REDIRECT_LIMIT", "HTML_RESPONSE", "MEDIA_SIGNATURE_INVALID",
    "INVALID_CANDIDATE_URL", "NETWORK_FAILURE"
  ];
  for (var i = 0; i < known.length; i += 1) {
    if (outcomes.indexOf(known[i]) >= 0) return known[i] === "NETWORK_TIMEOUT" ? "TIMEOUT" : known[i];
  }
  if (rows.some(function (row) { return row.stage === "PARSE" && row.outcome === "NO_CANDIDATES"; })) return "NO_CANDIDATES";
  var fetchFailure = rows.find(function (row) { return row.stage === "FETCH" &&
    ["DNS_FAILURE", "CONNECT_FAILURE", "NETWORK_TIMEOUT", "NETWORK_FAILURE", "HTTP_REFUSED", "HTTP_STATUS_ERROR"].indexOf(row.outcome) >= 0; });
  if (fetchFailure) return fetchFailure.outcome === "NETWORK_TIMEOUT" ? "TIMEOUT" : fetchFailure.outcome;
  if (rows.some(function (row) { return row.stage === "PARSE" && row.outcome === "UNSUPPORTED_DOCUMENT"; })) return "UNSUPPORTED_DOCUMENT";
  return "NO_VALID_MEDIA";
}

function universalDiagnosticKind(row) {
  if (!isObject(row)) return null;
  var signature = row.mediaSignature;
  if (signature === "HLS_PLAYLIST") return "hls";
  if (signature === "MP4_FTYP" || signature === "MP4_MIME_ONLY") return "mp4";
  if (signature === "DASH_MPD" || signature === "DASH_MIME_ONLY") return "dash";
  if (signature === "HTML_MARKUP" || row.outcome === "HTML") return "html";
  if (signature === "JSON_DOCUMENT" || row.outcome === "JSON") return "json";
  return "unknown";
}

function universalDiagnosticSummary(diagnostics, streamCount, elapsedMs, errorCode) {
  var rows = Array.isArray(diagnostics) ? diagnostics.filter(isObject) : [];
  var fetchRows = rows.filter(function (row) { return row.stage === "FETCH"; });
  var parse = rows.find(function (row) { return row.stage === "PARSE"; });
  var candidates = rows.filter(function (row) { return row.stage === "VERIFY_CANDIDATE"; });
  var parserIds = rows.filter(function (row) {
    return row.stage === "PARSE_EXTRACTOR" && row.outcome === "CANDIDATES" &&
      ["uqload", "json", "jwplayer", "packer", "direct-text"].indexOf(row.extractorId) >= 0;
  }).map(function (row) { return row.extractorId; });
  parserIds = parserIds.filter(function (id, index) { return parserIds.indexOf(id) === index; });
  var fetch = fetchRows.length ? fetchRows[fetchRows.length - 1] : null;
  var accepted = candidates.find(function (row) {
    return /^VALID_(?:HLS|MP4|DASH)$/.test(String(row.outcome || "")) && Number(row.validCount) > 0;
  });
  // On success, report the candidate that actually produced the returned stream. On failure there
  // is no accepted candidate, so retain the final failed probe as the most useful terminal detail.
  var media = streamCount && accepted ? accepted : (candidates.length ? candidates[candidates.length - 1] : null);
  var reason = streamCount ? null : universalEmptyReason(rows, errorCode);
  var fetchStatus = fetch && diagnosticNumber(fetch.httpStatus, 100, 599);
  var fetchResponseReceived = !!(fetch && (typeof fetch.responseReceived === "boolean"
    ? fetch.responseReceived : fetchStatus !== null));
  var mediaStatus = media && diagnosticNumber(media.httpStatus, 100, 599);
  return {
    candidateFailureCode: reason,
    candidateCount: parse && diagnosticNumber(parse.candidateCount, 0, MAX_SOURCES) !== null
      ? diagnosticNumber(parse.candidateCount, 0, MAX_SOURCES) : 0,
    parserIds: parserIds,
    acceptedCandidateId: accepted && accepted.candidateId,
    acceptedParserId: accepted && accepted.extractorId,
    verifiedCount: diagnosticNumber(streamCount, 0, MAX_SOURCES) || 0,
    elapsedMs: diagnosticNumber(elapsedMs, 0, 600000),
    host: fetch && safeDiagnosticHost(fetch.host),
    httpStatus: fetchResponseReceived ? fetchStatus : null,
    contentType: fetch && diagnosticContentType(fetch.contentType),
    responseReceived: fetchResponseReceived,
    responseKind: fetch ? universalDiagnosticKind(fetch) : null,
    mediaHost: media && safeDiagnosticHost(media.host),
    mediaHttpStatus: mediaStatus,
    mediaContentType: media && diagnosticContentType(media.contentType),
    mediaResponseKind: media ? universalDiagnosticKind(media) : null,
    mediaElapsedMs: media && diagnosticNumber(media.elapsedMs, 0, 600000)
  };
}

async function resolveWithUniversalExtractor(embedUrl, sourceIndex, source) {
  if (!universalExtractorEnabled()) return { attempted: false, streams: null };
  var startedAt = Date.now();
  traceDetailed("UNIVERSAL_ATTEMPT", { options: 1, streams: 0 }, null,
    { elapsedMs: 0, candidateCount: 0, verifiedCount: 0 });
  try {
    var raw = await __yume_extract_v1(JSON.stringify({
      url: embedUrl,
      referrer: embedUrl,
      headers: playbackHeadersForEmbed(embedUrl, source),
      timeoutMs: 12000,
      perAttemptTimeoutMs: 5000
    }));
    var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    var rows = payload && Array.isArray(payload.streams) ? payload.streams : [];
    var diagnostics = payload && Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    var errorCode = payload && universalErrorCode(payload.errorCode);
    var name = "سيرفر " + (sourceIndex + 1);
    var streams = rows.map(function (row) {
      if (!isObject(row)) return null;
      var url = publicHttpUrl(row.url);
      var type = text(row.type) && text(row.type).toLowerCase();
      if (!url || (type !== "hls" && type !== "mp4" && type !== "dash")) return null;
      var stream = { url: url, type: type, title: name, name: name, provider: "DramaWorld",
        headers: isObject(row.headers) ? row.headers : {} };
      if (text(row.quality)) stream.quality = text(row.quality);
      return stream;
    }).filter(Boolean);
    traceDetailed(streams.length ? "UNIVERSAL_SUCCESS" : "UNIVERSAL_FAILED",
      { options: 1, streams: streams.length }, streams.length ? null : "UNIVERSAL_EMPTY",
      universalDiagnosticSummary(diagnostics, streams.length, Date.now() - startedAt, errorCode));
    return { attempted: true, streams: streams.length ? streams : null, errorCode: streams.length ? null : errorCode };
  } catch (error) {
    if (isCancellation(error)) throw error;
    traceDetailed("UNIVERSAL_FAILED", { options: 1, streams: 0 },
      "UNIVERSAL_ERROR", { elapsedMs: Date.now() - startedAt, candidateCount: 0, verifiedCount: 0 });
    return { attempted: true, streams: null };
  }
}

function legacySuccess(streams, subtitles, diagnostic) {
  traceDetailed("LEGACY_SUCCESS", { options: 1, streams: streams.length }, null, diagnostic || {});
  return { streams: attachSubtitles(streams, subtitles) };
}

function localResolverPlaybackHeaders(embedUrl, resolverHeaders) {
  var origin = urlOrigin(embedUrl);
  if (!origin) return {};
  var headers = {
    "User-Agent": EMBED_USER_AGENT,
    "Accept-Language": EMBED_ACCEPT_LANGUAGE
  };
  var verifiedReferer = isObject(resolverHeaders) ? text(resolverHeaders.Referer) : null;
  // Keep only the origin-only Referer that the resolver scoped to this media
  // origin. A cross-origin media redirect removes it before it reaches the
  // destination. Probe-only Range/Accept and source-supplied credentials never
  // enter the Media3 stream headers.
  if (verifiedReferer === origin + "/") headers.Referer = verifiedReferer;
  return headers;
}

function isHlsPlaylist(body, contentType) {
  return typeof body === "string" && /^\s*#EXTM3U(?:\s|$)/i.test(body) &&
    !/(?:text\/html|application\/xhtml\+xml)/i.test(text(contentType) || "") &&
    !/<\s*html/i.test(body.slice(0, 1024));
}

function streamsFromHlsPlaylist(body, manifestUrl, playbackUrl, baseHeaders, sourceIndex, fallbackQuality) {
  var startedAt = Date.now();
  var resolver = YUME_DRAMAWORLD_LOCAL_RESOLVER;
  if (!resolver || typeof resolver.parseHlsMaster !== "function" || !isHlsPlaylist(body)) {
    traceDetailed("HLS_MASTER_RESULT", { options: 1, streams: 0 }, "HLS_PLAYLIST_INVALID",
      { hostUrl: manifestUrl, elapsedMs: Date.now() - startedAt });
    return [];
  }
  var variants = resolver.parseHlsMaster(body, manifestUrl, {});
  traceDetailed("HLS_MASTER_RESULT", { options: 1, streams: variants.length }, null,
    { hostUrl: manifestUrl, elapsedMs: Date.now() - startedAt });
  var hasVariants = variants.length > 0;
  var mediaRows = hasVariants ? variants : [{ url: manifestUrl, type: "hls", quality: text(fallbackQuality) }];
  var output = [];
  mediaRows.forEach(function (media) {
    var url = publicHttpUrl(media && media.url);
    if (!url || !/^https:\/\//i.test(url) || output.some(function (item) { return item.url === url; })) return;
    var scopedHeaders = typeof resolver.headersForSubresource === "function"
      ? resolver.headersForSubresource(baseHeaders || {}, manifestUrl, url)
      : (baseHeaders || {});
    var quality = text(media.quality) || (!hasVariants ? text(fallbackQuality) : null);
    var serverName = "سيرفر " + (Number(sourceIndex) + 1);
    var stream = {
      url: url,
      type: "hls",
      title: serverName,
      name: serverName,
      provider: "DramaWorld",
      headers: Object.assign({}, localResolverPlaybackHeaders(playbackUrl, scopedHeaders))
    };
    if (quality) stream.quality = quality;
    output.push(stream);
  });
  return output;
}

function mediaCandidateFailureCode(status, contentType, responseKind) {
  if (status === 401 || status === 403) return "HTTP_STATUS_DENIED";
  if (status < 200 || status >= 300) return "MEDIA_HTTP_ERROR";
  if (diagnosticContentType(contentType) === "text/html" ||
      diagnosticContentType(contentType) === "application/xhtml+xml" || responseKind === "html") return "HTML_RESPONSE";
  return responseKind === "hls" || responseKind === "mp4" ? null : "MEDIA_SIGNATURE_INVALID";
}

function diagnosticFetch(transport, records) {
  var nextCandidateIndex = 0;
  var activeCandidateIndex = -1;
  var previousWasRedirect = false;
  return async function (input, init) {
    var requestUrl = typeof input === "string" ? input : text(input && input.url);
    if (activeCandidateIndex < 0 || !previousWasRedirect) activeCandidateIndex = nextCandidateIndex++;
    var candidateIndex = activeCandidateIndex;
    var startedAt = Date.now();
    var response;
    try {
      response = await transport(input, init);
    } catch (error) {
      previousWasRedirect = false;
      records.push({
        host: sourceHost(requestUrl), httpStatus: 0, contentType: null,
        responseKind: "unknown", elapsedMs: Date.now() - startedAt,
        candidateIndex: candidateIndex, failureCode: "NETWORK_ERROR"
      });
      throw error;
    }
    var status = Number(response && response.status) || 0;
    var contentType = response && response.headers && response.headers.get("content-type") || null;
    var record = {
      host: sourceHost(requestUrl), httpStatus: status,
      contentType: diagnosticContentType(contentType), responseKind: "unknown",
      elapsedMs: Date.now() - startedAt, candidateIndex: candidateIndex, failureCode: null
    };
    var saved = false;
    function save(kind, bodyElapsed) {
      if (saved) return;
      saved = true;
      record.responseKind = kind || "unknown";
      record.elapsedMs = Date.now() - startedAt;
      record.failureCode = status >= 300 && status < 400
        ? null : mediaCandidateFailureCode(status, contentType, record.responseKind);
      records.push(record);
    }
    previousWasRedirect = status >= 300 && status < 400;
    if (previousWasRedirect || status < 200 || status >= 300) save("unknown");
    var wrapped = {
      ok: response && response.ok,
      status: response && response.status,
      statusText: response && response.statusText,
      url: response && response.url,
      headers: response && response.headers,
      networkError: response && response.networkError,
      text: async function () {
        var body = await response.text();
        save(responseKindFromBody(contentType, body));
        return body;
      },
      arrayBuffer: async function () {
        var body = await response.arrayBuffer();
        save(responseKindFromBody(contentType, body));
        return body;
      }
    };
    return wrapped;
  };
}

async function resolveEmbedLocally(embedResponse, sourceIndex, source, directCandidate) {
  var resolver = YUME_DRAMAWORLD_LOCAL_RESOLVER;
  var response = isObject(embedResponse) ? embedResponse : {};
  var hasEmbedBody = typeof response.body === "string";
  var sourceUrl = text(response.finalUrl) || text(source && source.url) || text(directCandidate && directCandidate.url);
  var resolverUrl = hasEmbedBody
    ? (text(response.finalUrl) || sourceUrl)
    : (text(directCandidate && directCandidate.url) || sourceUrl);
  var familyUrl = text(response.finalUrl) || text(source && source.url) || resolverUrl;
  if (!resolver || typeof resolver.resolve !== "function" || typeof fetch !== "function") {
    return { streams: [], family: null, errorCode: "DRAMAWORLD_LOCAL_RESOLVER_UNAVAILABLE" };
  }
  var family = resolver.familyFromUrl(familyUrl);
  var candidateCount = 0;
  var parseStartedAt = Date.now();
  try {
    candidateCount = hasEmbedBody && typeof resolver.parseCandidates === "function"
      ? resolver.parseCandidates(response.body, resolverUrl, {}).length
      : directCandidate ? 1 : 0;
  } catch (_) { candidateCount = directCandidate ? 1 : 0; }
  traceDetailed("LOCAL_PARSE_RESULT", { options: 1, streams: 0 },
    candidateCount ? null : "NO_MEDIA_CANDIDATE",
    { hostUrl: familyUrl, candidateCount: candidateCount, elapsedMs: Date.now() - parseStartedAt });
  var resolverStartedAt = Date.now();
  var mediaDiagnostics = [];
  traceStreams("LOCAL_RESOLVER_START", { options: 1, streams: 0 }, null, {
    hostUrl: familyUrl,
    httpStatus: Number(response.httpStatus) || null,
    responseReceived: response.responseReceived === true,
    contentType: response.contentType,
    responseKind: responseKindFromBody(response.contentType, response.body),
    candidateCount: candidateCount,
    elapsedMs: 0
  });
  traceDetailed("LOCAL_RESOLVER_DETAIL_START", { options: 1, streams: 0 }, null, {
    hostUrl: familyUrl,
    httpStatus: Number(response.httpStatus) || null,
    responseReceived: response.responseReceived === true,
    contentType: response.contentType,
    responseKind: responseKindFromBody(response.contentType, response.body),
    candidateCount: candidateCount,
    elapsedMs: 0
  });
  var result;
  var caughtErrorCode = null;
  try {
    var resolverHeaders = safeSourceHeaders(source || {});
    // The local engine generates a referer from the embed origin. Ignore API
    // supplied cross-origin Referer/Origin values so its scoped playback
    // headers remain stable and cannot leak to a media host.
    delete resolverHeaders.Referer;
    delete resolverHeaders.Origin;
    var resolverSource = {
      url: resolverUrl,
      family: family || undefined,
      headers: resolverHeaders,
      quality: text(directCandidate && directCandidate.quality) || text(source && source.quality) || undefined
    };
    var resolverContext = {
      fetch: diagnosticsEnabled() ? diagnosticFetch(fetch, mediaDiagnostics) : fetch,
      timeoutMs: EMBED_RESOLVE_TIMEOUT_MS,
      userAgent: EMBED_USER_AGENT,
      acceptLanguage: EMBED_ACCEPT_LANGUAGE,
      playbackHeaders: { Referer: (urlOrigin(familyUrl) || "") + "/" },
      allowExternalResolver: false
    };
    if (hasEmbedBody) resolverContext.embedBody = response.body;
    result = await resolver.resolve(resolverSource, resolverContext);
  } catch (error) {
    if (isCancellation(error)) throw error;
    caughtErrorCode = error && error.code || "DRAMAWORLD_LOCAL_RESOLVER_EXCEPTION";
    result = null;
  }
  var mediaRows = result && Array.isArray(result.streams) ? result.streams : [];
  var verifiedCount = mediaDiagnostics.filter(function (item) {
    return item.httpStatus >= 200 && item.httpStatus < 300 &&
      !item.failureCode && (item.responseKind === "hls" || item.responseKind === "mp4");
  }).length;
  var lastProbe = mediaDiagnostics.length ? mediaDiagnostics[mediaDiagnostics.length - 1] : null;
  mediaDiagnostics.forEach(function (item) {
    traceDetailed("MEDIA_CANDIDATE_RESULT", { options: 1, streams: 0 }, item.failureCode, {
      host: item.host,
      httpStatus: item.httpStatus,
      contentType: item.contentType,
      responseKind: item.responseKind,
      candidateIndex: item.candidateIndex,
      candidateCount: candidateCount,
      verifiedCount: verifiedCount,
      elapsedMs: item.elapsedMs,
      candidateFailureCode: item.failureCode
    });
  });
  var output = [];
  mediaRows.forEach(function (media) {
    if (!isObject(media) || media.verified !== true ||
        (media.type !== "hls" && media.type !== "mp4") ||
        !publicHttpUrl(media.url) || !/^https:\/\//i.test(media.url)) return;
    if (output.some(function (existing) { return existing.url === media.url; })) return;
    var quality = text(media.quality);
    var label = "سيرفر " + (Number(sourceIndex) + 1);
    var playbackHeaders = localResolverPlaybackHeaders(familyUrl, media.playbackHeaders);
    var stream = {
      url: media.url,
      type: media.type,
      title: label,
      name: label,
      provider: "DramaWorld",
      headers: Object.assign({}, playbackHeaders)
    };
    if (quality) stream.quality = quality;
    output.push(stream);
  });
  var errorCode = output.length ? null : caughtErrorCode || result && result.errorCode || "DRAMAWORLD_LOCAL_RESOLVER_NO_STREAMS";
  traceStreams("LOCAL_RESOLVER_RESULT", { options: 1, streams: output.length }, errorCode, {
    hostUrl: familyUrl,
    httpStatus: Number(response.httpStatus) || null,
    responseReceived: response.responseReceived === true || mediaRows.length > 0,
    videoExtracted: output.length > 0,
    contentType: response.contentType,
    responseKind: responseKindFromBody(response.contentType, response.body),
    candidateCount: candidateCount,
    verifiedCount: verifiedCount,
    elapsedMs: Date.now() - resolverStartedAt,
    mediaHost: lastProbe && lastProbe.host,
    mediaHttpStatus: lastProbe && lastProbe.httpStatus,
    mediaContentType: lastProbe && lastProbe.contentType,
    mediaResponseKind: lastProbe && lastProbe.responseKind,
    mediaElapsedMs: lastProbe && lastProbe.elapsedMs,
    candidateFailureCode: lastProbe && lastProbe.failureCode
  });
  return { streams: output, family: family || null, errorCode: errorCode,
    candidateCount: candidateCount, verifiedCount: verifiedCount, elapsedMs: Date.now() - resolverStartedAt,
    mediaDiagnostic: lastProbe };
}

async function resolveStreamOption(args) {
  args = isObject(args) ? args : {};
  var identity;
  var selection;
  try {
    identity = parseNativeId(args.id || args.nativeId, ["movie", "episode"]);
    selection = parseSourceOptionToken(args.token);
  } catch (selectionError) {
    traceStreamFailure(selectionError, "OPTION_TOKEN_INVALID", { options: 1, streams: 0 });
    throw selectionError;
  }
  if (selection.kind !== identity.kind || selection.id !== identity.id) {
    var identityError;
    try { fail("DRAMAWORLD_OPTION_ID_MISMATCH", "selected server belongs to a different DramaWorld title"); }
    catch (error) { identityError = error; }
    traceStreamFailure(identityError, "OPTION_ID_MISMATCH", { options: 1, streams: 0 });
    throw identityError;
  }

  var configStartedAt = Date.now();
  var config = await readConfig();
  traceDetailed("CONFIG_RESULT", { sourceRows: 0, options: 1, streams: 0 }, null,
    { elapsedMs: Date.now() - configStartedAt });
  var route = identity.kind === "movie" ? "movie/source/by/" : "episode/source/by/";
  var sourceRows;
  var subtitlePromise = fetchSubtitlesForIdentity(config, identity);
  var sourceStartedAt = Date.now();
  try {
    sourceRows = await requestDecodedSources(config, endpointPath(config, route + identity.id));
  } catch (sourceError) {
    traceStreams("RESOLVE_API_FAILURE", {}, sourceError && sourceError.code || "DRAMAWORLD_NETWORK_ERROR");
    throw sourceError;
  }
  var sourceElapsedMs = Date.now() - sourceStartedAt;
  var subtitleResult = await subtitlePromise;
  traceDetailed("RESOLVE_INPUTS_READY", { sourceRows: sourceRows.length, options: 1, streams: 0 },
    subtitleResult.available ? null : "DRAMAWORLD_SUBTITLES_UNAVAILABLE",
    { elapsedMs: Math.max(sourceElapsedMs, subtitleResult.elapsedMs) });
  var source = sourceRows[selection.index];
  if (!isObject(source) || source.external === true ||
      stableSourceFingerprint(source, identity, selection.index) !== selection.fingerprint) {
    var expiredError;
    try { fail("DRAMAWORLD_OPTION_EXPIRED", "DramaWorld server list changed; refresh the source list and try again"); }
    catch (error) { expiredError = error; }
    traceStreamFailure(expiredError, "OPTION_EXPIRED", { sourceRows: sourceRows.length, options: 1, streams: 0 });
    throw expiredError;
  }

  var embedUrl = publicHttpUrl(source.url);
  if (!embedUrl || !/^https:\/\//i.test(embedUrl)) {
    var embedUrlError;
    try { fail("DRAMAWORLD_EMBED_URL_INVALID", "selected DramaWorld server does not provide a public HTTPS address"); }
    catch (error) { embedUrlError = error; }
    traceStreamFailure(embedUrlError, "EMBED_URL_INVALID", { sourceRows: sourceRows.length, options: 1, streams: 0 });
    throw embedUrlError;
  }

  // Production contract: Universal First is the default. Disabling the setting
  // selects Legacy Only immediately; otherwise the legacy path is entered at
  // most once, only after an empty/failed universal result.
  var universalAttempt = await resolveWithUniversalExtractor(embedUrl, selection.index, source);
  if (universalAttempt.streams && universalAttempt.streams.length) {
    traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: universalAttempt.streams.length }, null, {
      hostUrl: embedUrl, responseReceived: true, videoExtracted: true
    });
    return { streams: attachSubtitles(universalAttempt.streams, subtitleResult.subtitles) };
  }
  if (universalAttempt.errorCode === "HTTP_REFUSED") {
    var refusedError;
    try { fail("DRAMAWORLD_MEDIA_HTTP_REFUSED", "selected server refused media access"); }
    catch (error) { refusedError = error; }
    traceStreamFailure(refusedError, "HTTP_REFUSED",
      { sourceRows: sourceRows.length, options: 1, streams: 0 }, embedUrl);
    throw refusedError;
  }
  if (universalAttempt.attempted) {
    traceDetailed("LEGACY_FALLBACK", { sourceRows: sourceRows.length, options: 1, streams: 0 },
      "UNIVERSAL_UNRESOLVED", { candidateCount: 0, verifiedCount: 0 });
  }

  var legacyStartedAt = Date.now();
  var candidates;
  try {
    candidates = parseDirectMediaCandidates(JSON.stringify(source));
  } catch (parseSourceError) {
    traceStreamFailure(parseSourceError, "SOURCE_PARSE_FAILURE",
      { sourceRows: sourceRows.length, options: 1, streams: 0 }, embedUrl);
    throw parseSourceError;
  }
  var playbackUrl = embedUrl;
  var embedResponse = null;
  if (!candidates.length) {
    try {
      embedResponse = await fetchEmbedBody(embedUrl);
    } catch (embedError) {
      traceStreamFailure(embedError, "EMBED_FETCH_FAILURE",
        { sourceRows: sourceRows.length, options: 1, streams: 0 }, embedUrl);
      throw embedError;
    }
    playbackUrl = embedResponse.finalUrl;
    if (isHlsPlaylist(embedResponse.body, embedResponse.contentType)) {
      var playlistStreams = streamsFromHlsPlaylist(embedResponse.body, embedResponse.finalUrl,
        playbackUrl, playbackHeadersForEmbed(playbackUrl, source), selection.index, source.quality);
      if (playlistStreams.length) {
        traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: playlistStreams.length }, null, {
          hostUrl: embedResponse.finalUrl, httpStatus: embedResponse.httpStatus,
          responseReceived: embedResponse.responseReceived, videoExtracted: true
        });
        return legacySuccess(playlistStreams, subtitleResult.subtitles, {
          hostUrl: embedResponse.finalUrl, httpStatus: embedResponse.httpStatus,
          responseReceived: embedResponse.responseReceived,
          elapsedMs: Date.now() - legacyStartedAt
        });
      }
    }
    var embedParseStartedAt = Date.now();
    try {
      candidates = parseDirectMediaCandidates(embedResponse.body);
    } catch (parseEmbedError) {
      if (parseEmbedError && !parseEmbedError.diagnostic) {
        parseEmbedError.diagnostic = {
          hostUrl: embedResponse.finalUrl,
          httpStatus: embedResponse.httpStatus,
          responseReceived: embedResponse.responseReceived
        };
      }
      traceStreamFailure(parseEmbedError, "EMBED_PARSE_FAILURE",
        { sourceRows: sourceRows.length, options: 1, streams: 0 }, embedResponse.finalUrl);
      throw parseEmbedError;
    }
    traceDetailed("EMBED_PARSE_RESULT", { sourceRows: sourceRows.length, options: 1, streams: 0 }, null, {
      hostUrl: embedResponse.finalUrl, httpStatus: embedResponse.httpStatus,
      responseReceived: embedResponse.responseReceived, contentType: embedResponse.contentType,
      responseKind: responseKindFromBody(embedResponse.contentType, embedResponse.body),
      candidateCount: candidates.length, verifiedCount: 0, elapsedMs: Date.now() - embedParseStartedAt
    });
  }

  if (!candidates.length) {
    var localResult = null;
    if (localResolverEnabled()) {
      localResult = await resolveEmbedLocally(embedResponse, selection.index, source, null);
      if (localResult && localResult.streams.length) {
        traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: localResult.streams.length }, null, {
          hostUrl: embedResponse && embedResponse.finalUrl || embedUrl,
          httpStatus: embedResponse && embedResponse.httpStatus || null,
          responseReceived: !!(embedResponse && embedResponse.responseReceived), videoExtracted: true
        });
        return legacySuccess(localResult.streams, subtitleResult.subtitles, {
          hostUrl: embedResponse && embedResponse.finalUrl || embedUrl,
          httpStatus: embedResponse && embedResponse.httpStatus || null,
          responseReceived: !!(embedResponse && embedResponse.responseReceived),
          elapsedMs: Date.now() - legacyStartedAt
        });
      }
    }
    var unresolvedError;
    var unresolvedContext = {
      hostUrl: embedResponse && embedResponse.finalUrl || embedUrl,
      httpStatus: embedResponse && embedResponse.httpStatus || null,
      responseReceived: !!(embedResponse && embedResponse.responseReceived)
    };
    try {
      failStream("DRAMAWORLD_EMBED_UNRESOLVED", "selected server returned an embed page without a directly readable HLS or MP4 source", unresolvedContext);
    } catch (error) { unresolvedError = error; }
    traceStreamFailure(unresolvedError, "EMBED_UNRESOLVED",
      { sourceRows: sourceRows.length, options: 1, streams: 0 }, embedUrl);
    if (localResult && localResult.errorCode) {
      traceStreams("LOCAL_RESOLVER_FALLBACK_FAILED", { options: 1, streams: 0 }, localResult.errorCode, Object.assign({}, unresolvedContext, {
        candidateCount: localResult.candidateCount,
        verifiedCount: localResult.verifiedCount,
        elapsedMs: localResult.elapsedMs,
        mediaHost: localResult.mediaDiagnostic && localResult.mediaDiagnostic.host,
        mediaHttpStatus: localResult.mediaDiagnostic && localResult.mediaDiagnostic.httpStatus,
        mediaContentType: localResult.mediaDiagnostic && localResult.mediaDiagnostic.contentType,
        mediaResponseKind: localResult.mediaDiagnostic && localResult.mediaDiagnostic.responseKind,
        mediaElapsedMs: localResult.mediaDiagnostic && localResult.mediaDiagnostic.elapsedMs,
        candidateFailureCode: localResult.mediaDiagnostic && localResult.mediaDiagnostic.failureCode
      }));
    }
    throw unresolvedError;
  }

  var selected = null;
  var verifiedMedia = null;
  var lastValidationError = null;
  for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    try {
      verifiedMedia = await verifyMediaCandidate(candidates[candidateIndex], playbackUrl, source,
        candidateIndex, candidates.length);
      selected = candidates[candidateIndex];
      break;
    } catch (validationError) {
      if (isCancellation(validationError)) throw validationError;
      lastValidationError = validationError;
      traceStreamFailure(validationError, "MEDIA_CANDIDATE_FAILURE",
        { sourceRows: sourceRows.length, options: 1, streams: 0 }, candidates[candidateIndex].url);
    }
  }
  if (!selected || !verifiedMedia) {
    // The legacy parser may identify a URL that fails signature validation while
    // the structural local parser can still find a different, valid rendition
    // in the already-fetched embed page. Reuse that page and preserve the old
    // validation error if the fallback also fails.
    var fallbackResult = null;
    if (localResolverEnabled() && embedResponse) {
      fallbackResult = await resolveEmbedLocally(embedResponse, selection.index, source, candidates[0]);
      if (fallbackResult && fallbackResult.streams.length) {
        traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: fallbackResult.streams.length }, null, {
          hostUrl: embedResponse && embedResponse.finalUrl || candidates[0].url,
          httpStatus: embedResponse && embedResponse.httpStatus || null,
          responseReceived: !!(embedResponse && embedResponse.responseReceived), videoExtracted: true
        });
        return legacySuccess(fallbackResult.streams, subtitleResult.subtitles, {
          hostUrl: embedResponse && embedResponse.finalUrl || candidates[0].url,
          httpStatus: embedResponse && embedResponse.httpStatus || null,
          responseReceived: !!(embedResponse && embedResponse.responseReceived),
          elapsedMs: Date.now() - legacyStartedAt
        });
      }
      if (fallbackResult && fallbackResult.errorCode) {
        traceStreams("LOCAL_RESOLVER_FALLBACK_FAILED", { options: 1, streams: 0 }, fallbackResult.errorCode, {
          hostUrl: embedResponse && embedResponse.finalUrl || candidates[0].url,
          httpStatus: embedResponse && embedResponse.httpStatus || null,
          responseReceived: !!(embedResponse && embedResponse.responseReceived),
          candidateCount: fallbackResult.candidateCount,
          verifiedCount: fallbackResult.verifiedCount,
          elapsedMs: fallbackResult.elapsedMs,
          mediaHost: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.host,
          mediaHttpStatus: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.httpStatus,
          mediaContentType: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.contentType,
          mediaResponseKind: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.responseKind,
          mediaElapsedMs: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.elapsedMs,
          candidateFailureCode: fallbackResult.mediaDiagnostic && fallbackResult.mediaDiagnostic.failureCode
        });
      }
    }
    if (lastValidationError) throw lastValidationError;
    fail("DRAMAWORLD_MEDIA_RESPONSE_INVALID", "selected server did not return a valid video source");
  }

  if (selected.type === "hls") {
    var hlsStreams = streamsFromHlsPlaylist(verifiedMedia.body, verifiedMedia.url,
      playbackUrl, verifiedMedia.playbackHeaders, selection.index, selected.quality);
    if (hlsStreams.length) {
      traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: hlsStreams.length }, null, {
        hostUrl: verifiedMedia.hostUrl, httpStatus: verifiedMedia.httpStatus,
        responseReceived: verifiedMedia.responseReceived, videoExtracted: true
      });
      return legacySuccess(hlsStreams, subtitleResult.subtitles, {
        hostUrl: verifiedMedia.hostUrl, httpStatus: verifiedMedia.httpStatus,
        responseReceived: verifiedMedia.responseReceived,
        elapsedMs: Date.now() - legacyStartedAt
      });
    }
  }

  var streamName = "سيرفر " + (selection.index + 1);
  var stream = {
    url: verifiedMedia.url,
    type: selected.type,
    title: streamName,
    name: streamName,
    provider: "DramaWorld",
    headers: selected.type === "mp4"
      ? playbackHeadersForEmbed(playbackUrl, source)
      : verifiedMedia.playbackHeaders || playbackHeadersForEmbed(playbackUrl, source)
  };
  traceStreams("RESOLVE_READY", { sourceRows: sourceRows.length, options: 1, streams: 1 }, null, {
    hostUrl: verifiedMedia.hostUrl,
    httpStatus: verifiedMedia.httpStatus,
    responseReceived: verifiedMedia.responseReceived,
    videoExtracted: true
  });
  if (selected.quality) stream.quality = selected.quality;
  return legacySuccess([stream], subtitleResult.subtitles, {
    hostUrl: verifiedMedia.hostUrl, httpStatus: verifiedMedia.httpStatus,
    responseReceived: verifiedMedia.responseReceived,
    elapsedMs: Date.now() - legacyStartedAt
  });
}

module.exports = {
  getHome: getHome,
  getCatalog: getCatalog,
  getCatalogFilters: getCatalogFilters,
  search: search,
  getDetails: getDetails,
  getStreams: getStreams,
  resolveStreamOption: resolveStreamOption,
  onSettings: onSettings
};


// Bundled local DramaWorld resolver. It stays in a private scope so its
// CommonJS export cannot replace the plugin API.
var YUME_DRAMAWORLD_LOCAL_RESOLVER = (function () {
  var module;
/*
 * DramaWorld local resolver
 * Standalone ES2019/QuickJS-oriented resolver. No eval, DOM, Node APIs, Android
 * APIs, or network access are used unless a caller injects a fetch function.
 */
(function (root) {
  "use strict";

  var VERSION = "0.3.7";
  var DEFAULT_TIMEOUT_MS = 10000;
  var MAX_BODY_CHARS = 512 * 1024;
  var MAX_PROBE_BYTES = 64 * 1024;
  var MAX_CANDIDATES = 48;
  var MAX_REDIRECTS = 4;
  var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  var ACCEPT_LANGUAGE = "en-US,en;q=0.9";
  var FAMILIES = {
    anafast: { resolver: "dramaworld.anafast.local" },
    okhd: { resolver: "dramaworld.okhd.local" },
    vidspeed: { resolver: "dramaworld.vidspeed.local" },
    upzur: { resolver: "dramaworld.upzur.local" },
    luluvdo: { resolver: "dramaworld.luluvdo.local" }
  };

  function result(streams, type, quality, headers, resolverId, errorCode, extra) {
    return Object.assign({
      streams: streams || [], type: type || null, quality: quality || null,
      playbackHeaders: headers || {}, resolverId: resolverId || "dramaworld.unknown",
      errorCode: errorCode || null
    }, extra || {});
  }

  function parseHttpUrl(value) {
    if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\\\u007f]/.test(value)) return null;
    var match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
    if (!match) return null;
    var authority = match[2];
    if (authority.indexOf("@") >= 0 || authority.charAt(0) === "[" || authority.indexOf("]") >= 0) return null;
    var hostPort = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
    if (!hostPort) return null;
    var host = hostPort[1].toLowerCase();
    var port = hostPort[2] ? Number(hostPort[2]) : null;
    if (!host || host.length > 253 || host.charAt(0) === "." || host.charAt(host.length - 1) === "." || host.indexOf("..") >= 0) return null;
    if (port !== null && (port < 1 || port > 65535)) return null;
    if (!host.split(".").every(function (part) { return part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part); })) return null;
    return {
      protocol: match[1].toLowerCase(), host: host, port: port,
      origin: match[1].toLowerCase() + "://" + host + (port === null ? "" : ":" + port),
      path: match[3] || "/", query: match[4] || "", fragment: match[5] || ""
    };
  }

  function isPrivateIpv4(host) {
    if (!/^[0-9.]+$/.test(host)) return false;
    var p = host.split(".").map(Number);
    if (p.length !== 4 || p.some(function (n) { return n < 0 || n > 255; })) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
  }

  function isAllowedUrl(value, context) {
    var parsed = parseHttpUrl(value);
    if (!parsed) return false;
    if (parsed.protocol !== "https") return false;
    return parsed.host !== "localhost" && parsed.host !== "localhost.localdomain" &&
      !/\.(?:localhost|local|internal|test)$/.test(parsed.host) && !isPrivateIpv4(parsed.host);
  }

  function normalizePath(path) {
    var absolute = path.charAt(0) === "/";
    var trailing = path.length > 1 && path.charAt(path.length - 1) === "/";
    var stack = [];
    path.split("/").forEach(function (part) {
      if (!part || part === ".") return;
      if (part === "..") stack.pop(); else stack.push(part);
    });
    var resultPath = (absolute ? "/" : "") + stack.join("/");
    if (!resultPath) resultPath = "/";
    if (trailing && resultPath.charAt(resultPath.length - 1) !== "/") resultPath += "/";
    return resultPath;
  }

  function resolveUrl(reference, baseUrl) {
    if (typeof reference !== "string" || !baseUrl) return null;
    var ref = reference.trim().replace(/&amp;/gi, "&").replace(/\\\//g, "/");
    if (!ref) return null;
    if (/^https?:\/\//i.test(ref)) return ref;
    var base = parseHttpUrl(baseUrl);
    if (!base) return null;
    if (ref.slice(0, 2) === "//") return base.protocol + ":" + ref;
    if (ref.charAt(0) === "#") return base.origin + base.path + (base.query ? "?" + base.query : "") + ref;
    if (ref.charAt(0) === "?") return base.origin + base.path + ref;
    var refMatch = /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(ref);
    if (!refMatch) return null;
    var path = refMatch[1];
    var nextPath;
    if (!path) nextPath = base.path;
    else if (path.charAt(0) === "/") nextPath = normalizePath(path);
    else nextPath = normalizePath(base.path.substring(0, base.path.lastIndexOf("/") + 1) + path);
    var query = refMatch[2] !== undefined ? "?" + refMatch[2] : (!path && base.query ? "?" + base.query : "");
    var fragment = refMatch[3] !== undefined ? "#" + refMatch[3] : "";
    return base.origin + nextPath + query + fragment;
  }

  function familyFromUrl(url, hint) {
    var normalizedHint = typeof hint === "string" ? hint.toLowerCase().trim() : "";
    if (FAMILIES[normalizedHint]) return normalizedHint;
    var parsed = parseHttpUrl(url);
    if (!parsed) return null;
    var labels = parsed.host.split(".");
    for (var i = labels.length - 1; i >= 0; i -= 1) if (FAMILIES[labels[i]]) return labels[i];
    return null;
  }

  function qualityNumber(value) {
    var match = /(?:^|[^0-9])([0-9]{3,4})\s*p?(?:$|[^0-9])/i.exec(String(value || ""));
    return match ? Number(match[1]) : 0;
  }

  function pathType(url) {
    var parsed = parseHttpUrl(url);
    if (!parsed) return null;
    if (/\.m3u8$/i.test(parsed.path)) return "hls";
    if (/\.mp4$/i.test(parsed.path)) return "mp4";
    return null;
  }

  function addCandidate(output, rawUrl, quality, baseUrl, declaredType, context) {
    if (output.length >= MAX_CANDIDATES || typeof rawUrl !== "string") return;
    var url = resolveUrl(rawUrl, baseUrl);
    if (!url || !isAllowedUrl(url, context)) return;
    var type = pathType(url);
    if (!type && (declaredType === "hls" || declaredType === "mp4")) type = declaredType;
    if (type !== "hls" && type !== "mp4") type = null;
    if (output.some(function (item) { return item.url === url; })) return;
    output.push({ url: url, type: type, quality: typeof quality === "string" && quality.trim() ? quality.trim() : null });
  }

  function walkJson(value, baseUrl, output, context, depth) {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(function (item) { walkJson(item, baseUrl, output, context, depth + 1); }); return; }
    ["sources", "links", "availableQualities"].forEach(function (key) {
      var rows = value[key];
      if (!Array.isArray(rows)) return;
      rows.forEach(function (row) {
        var url = typeof row === "string" ? row : row && (row.file || row.url || row.src);
        var quality = row && typeof row === "object" ? row.quality || row.label || row.name : null;
        addCandidate(output, url, quality, baseUrl, row && row.type, context);
      });
    });
    if (Array.isArray(value.filtered_content)) {
      value.filtered_content.forEach(function (row, index) {
        var labels = value.Quality || value.qualities || [];
        addCandidate(output, typeof row === "string" ? row : row && (row.file || row.url),
          labels[index] || (row && (row.quality || row.label)), baseUrl, row && row.type, context);
      });
    }
    if (value.file || value.url || value.src) {
      addCandidate(output, value.file || value.url || value.src, value.quality || value.label,
        baseUrl, value.type, context);
    }
    if (value.data && typeof value.data === "object") walkJson(value.data, baseUrl, output, context, depth + 1);
  }

  function findBalancedObject(text, start) {
    var depth = 0, quote = "", escape = false;
    for (var i = start; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (quote) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === quote) quote = "";
      } else if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  function parseJwJson(text, baseUrl, output, context) {
    var setup = /\.setup\s*\(/i.exec(text);
    if (!setup) return;
    var start = text.indexOf("{", setup.index + setup[0].length);
    if (start < 0) return;
    var balanced = findBalancedObject(text, start);
    if (!balanced) return;
    try { walkJson(JSON.parse(balanced), baseUrl, output, context, 0); } catch (_) { /* JSON-only: never evaluate JS. */ }
  }

  function unpackPackerText(text) {
    if (typeof text !== "string" || text.length > MAX_BODY_CHARS) return null;
    function skipSpace(input, index) {
      while (index < input.length && /\s/.test(input.charAt(index))) index += 1;
      return index;
    }
    function readQuotedString(input, index) {
      var quote = input.charAt(index);
      if (quote !== "'" && quote !== '"') return null;
      var value = "";
      for (var cursor = index + 1; cursor < input.length; cursor += 1) {
        var ch = input.charAt(cursor);
        if (ch === quote) return { value: value, next: cursor + 1 };
        if (ch !== "\\") { value += ch; continue; }
        cursor += 1;
        if (cursor >= input.length) return null;
        var escaped = input.charAt(cursor);
        if (escaped === "n") value += "\n";
        else if (escaped === "r") value += "\r";
        else if (escaped === "t") value += "\t";
        else if (escaped === "b") value += "\b";
        else if (escaped === "f") value += "\f";
        else if (escaped === "v") value += "\v";
        else if (escaped === "x" || escaped === "u") {
          var digits = escaped === "x" ? 2 : 4;
          var hex = input.slice(cursor + 1, cursor + 1 + digits);
          if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return null;
          value += String.fromCharCode(parseInt(hex, 16));
          cursor += digits;
        } else if (escaped === "\n") {
          // JavaScript line continuation contributes no character.
        } else if (escaped === "\r") {
          if (input.charAt(cursor + 1) === "\n") cursor += 1;
        } else {
          // Quoted literals in packed payloads commonly escape quotes, slashes,
          // or backslashes. Treat other identity escapes as their literal char.
          value += escaped;
        }
        if (value.length > MAX_BODY_CHARS) return null;
      }
      return null;
    }
    function readInteger(input, index) {
      var match = /^[0-9]{1,5}/.exec(input.slice(index));
      return match ? { value: Number(match[0]), next: index + match[0].length } : null;
    }
    function readPackerArguments(input, index) {
      var payload = readQuotedString(input, skipSpace(input, index));
      if (!payload) return null;
      index = skipSpace(input, payload.next);
      if (input.charAt(index++) !== ",") return null;
      var radix = readInteger(input, skipSpace(input, index));
      if (!radix) return null;
      index = skipSpace(input, radix.next);
      if (input.charAt(index++) !== ",") return null;
      var count = readInteger(input, skipSpace(input, index));
      if (!count) return null;
      index = skipSpace(input, count.next);
      if (input.charAt(index++) !== ",") return null;
      var dictionary = readQuotedString(input, skipSpace(input, index));
      if (!dictionary) return null;
      index = skipSpace(input, dictionary.next);
      if (!/^\.\s*split\s*\(/i.test(input.slice(index))) return null;
      index += /^\.\s*split\s*\(/i.exec(input.slice(index))[0].length;
      var separator = readQuotedString(input, skipSpace(input, index));
      if (!separator || separator.value !== "|") return null;
      index = skipSpace(input, separator.next);
      if (input.charAt(index) !== ")") return null;
      return { payload: payload.value, radix: radix.value, count: count.value, words: dictionary.value.split("|") };
    }
    function toBase(value, radix) {
      var alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      if (value === 0) return "0";
      var result = "";
      while (value > 0) {
        result = alphabet.charAt(value % radix) + result;
        value = Math.floor(value / radix);
      }
      return result;
    }

    // Parse the wrapper and string arguments only. The packed function is never
    // evaluated, so this remains safe for untrusted embed HTML.
    var wrapper = /eval\s*\(\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*\(/ig;
    var match, args = null;
    while ((match = wrapper.exec(text)) !== null) {
      args = readPackerArguments(text, wrapper.lastIndex);
      if (args) break;
      wrapper.lastIndex = match.index + match[0].length;
    }
    if (!args || args.radix < 2 || args.radix > 62 || args.count < 1 || args.count > 4096 || args.words.length > 4096) return null;

    var replacements = Object.create(null);
    for (var i = 0; i < args.count; i += 1) {
      if (args.words[i]) replacements[toBase(i, args.radix)] = args.words[i];
    }
    var decoded = args.payload.replace(/\b\w+\b/g, function (token) {
      return replacements[token] || token;
    });
    return decoded.length <= MAX_BODY_CHARS ? decoded : null;
  }

  function parseCandidates(body, baseUrl, context) {
    var output = [];
    if (typeof body !== "string" || !body.trim() || body.length > MAX_BODY_CHARS) return output;
    var text = body.replace(/\\\//g, "/").replace(/&amp;/gi, "&");
    var unpacked = unpackPackerText(text);
    if (unpacked) text += "\n" + unpacked;
    var trimmed = text.trim();
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
      try { walkJson(JSON.parse(trimmed), baseUrl, output, context, 0); } catch (_) { /* HTML/raw parser below. */ }
    }
    parseJwJson(text, baseUrl, output, context);
    var fileRegex = /\bfile\s*:\s*(["'])(https?:\/\/[^"']+)\1/gi;
    var fileMatch;
    while ((fileMatch = fileRegex.exec(text)) && output.length < MAX_CANDIDATES) {
      var tail = text.slice(fileMatch.index + fileMatch[0].length, fileMatch.index + fileMatch[0].length + 180);
      var label = /\blabel\s*:\s*(["'])(.*?)\1/i.exec(tail);
      addCandidate(output, fileMatch[2], label && label[2], baseUrl, null, context);
    }
    // Uqload's core extractor also accepts a literal `sources: ["<url>"]`
    // entry. The endpoint may be extensionless, so let media-signature
    // verification determine HLS vs MP4 instead of guessing from its path.
    var sourceArrayRegex = /\bsources\s*:\s*\[\s*(["'])(https?:\/\/[^"']+)\1/gi;
    var sourceArrayMatch;
    while ((sourceArrayMatch = sourceArrayRegex.exec(text)) && output.length < MAX_CANDIDATES) {
      addCandidate(output, sourceArrayMatch[2], null, baseUrl, null, context);
    }
    var urlRegex = /https?:\/\/[^\s"'<>\\]+/gi;
    var urlMatch;
    while ((urlMatch = urlRegex.exec(text)) && output.length < MAX_CANDIDATES) {
      var candidateUrl = urlMatch[0].replace(/[),;]+$/, "");
      if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(candidateUrl)) addCandidate(output, candidateUrl, null, baseUrl, null, context);
    }
    return output.sort(function (a, b) { return qualityNumber(b.quality) - qualityNumber(a.quality); });
  }

  function parseHlsMaster(text, masterUrl, context) {
    if (typeof text !== "string" || !/^\s*#EXTM3U(?:\s|$)/i.test(text) || /<\s*html/i.test(text)) return [];
    var lines = text.split(/\r?\n/), variants = [], master = parseHttpUrl(masterUrl);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
      var attrs = line.substring(line.indexOf(":") + 1);
      var resolution = /(?:^|,)RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
      var name = /(?:^|,)NAME="([^"]+)"/i.exec(attrs);
      var bandwidth = /(?:^|,)BANDWIDTH=(\d+)/i.exec(attrs);
      var next = i + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].trim().charAt(0) === "#")) next += 1;
      if (next >= lines.length) continue;
      var reference = lines[next].trim();
      var url = resolveUrl(reference, masterUrl);
      if (!url || !isAllowedUrl(url, context)) continue;
      var parsedVariant = parseHttpUrl(url);
      // Signed master URLs often authorize sibling playlists. Preserve that
      // query only for a relative same-origin child without its own query;
      // never copy credentials onto absolute or cross-origin URLs.
      if (master && master.query && parsedVariant && parsedVariant.origin === master.origin &&
          !/[?]/.test(reference) && !/^(?:https?:)?\/\//i.test(reference)) {
        var fragmentAt = url.indexOf("#");
        url = (fragmentAt < 0 ? url : url.slice(0, fragmentAt)) + "?" + master.query +
          (fragmentAt < 0 ? "" : url.slice(fragmentAt));
      }
      if (variants.some(function (item) { return item.url === url; })) continue;
      var height = resolution ? Number(resolution[2]) : 0;
      variants.push({ url: url, height: height, bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
        quality: name ? name[1] : height ? height + "p" : null, type: "hls" });
    }
    variants.sort(function (a, b) { return b.height - a.height || b.bandwidth - a.bandwidth; });
    return variants;
  }

  function headerValue(response, name) {
    if (!response || !response.headers) return "";
    if (typeof response.headers.get === "function") return response.headers.get(name) || "";
    var key = Object.keys(response.headers).filter(function (item) { return item.toLowerCase() === name.toLowerCase(); })[0];
    return key ? response.headers[key] : "";
  }

  function playbackHeadersFor(embedUrl, source, context) {
    var parsed = parseHttpUrl(embedUrl);
    var headers = {
      "User-Agent": (context && context.userAgent) || USER_AGENT,
      "Accept-Language": (context && context.acceptLanguage) || ACCEPT_LANGUAGE,
      "Referer": parsed ? parsed.origin + "/" : ""
    };
    var supplied = Object.assign({}, source && source.headers || {}, context && context.playbackHeaders || {});
    Object.keys(supplied).forEach(function (key) {
      var lower = key.toLowerCase();
      if (["user-agent", "accept-language", "referer", "origin"].indexOf(lower) < 0) return;
      var value = supplied[key];
      if (typeof value !== "string" || !value.trim() || value.length > 2048) return;
      if (lower === "referer" || lower === "origin") {
        var suppliedUrl = parseHttpUrl(value);
        if (!suppliedUrl || suppliedUrl.protocol !== "https") return;
      }
      var canonical = lower === "user-agent" ? "User-Agent" : lower === "accept-language" ? "Accept-Language" : lower === "referer" ? "Referer" : "Origin";
      headers[canonical] = value.trim();
    });
    if (!headers.Referer) delete headers.Referer;
    return headers;
  }

  function sanitizeHeaders(headers) {
    var output = {};
    Object.keys(headers || {}).forEach(function (key) {
      var lower = key.toLowerCase();
      if (["user-agent", "accept-language", "referer", "origin", "accept", "range"].indexOf(lower) < 0) return;
      var value = headers[key];
      if (typeof value === "string" && value.length <= 4096) output[key] = value;
    });
    return output;
  }

  function playbackOnlyHeaders(headers) {
    var output = {};
    Object.keys(headers || {}).forEach(function (key) {
      var lower = key.toLowerCase();
      if (["user-agent", "accept-language", "referer", "origin"].indexOf(lower) < 0) return;
      var value = headers[key];
      if (typeof value === "string" && value.length <= 4096) output[key] = value;
    });
    return output;
  }

  function headersForSubresource(playbackHeaders, mediaUrl, targetUrl) {
    var media = parseHttpUrl(mediaUrl), target = parseHttpUrl(targetUrl);
    var output = sanitizeHeaders(playbackHeaders);
    if (!media || !target || media.origin !== target.origin) {
      Object.keys(output).forEach(function (key) {
        if (key.toLowerCase() === "referer" || key.toLowerCase() === "origin") delete output[key];
      });
    }
    return output;
  }

  function isCancelled(context) {
    return !!(context && context.signal && context.signal.aborted === true);
  }

  function responseStatus(response) { return Number(response && (response.status || response.statusCode)) || 0; }

  function waitForTransport(promise, timeoutMs, signal) {
    if (signal && signal.aborted === true) return Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    if (typeof setTimeout !== "function" || typeof clearTimeout !== "function") return promise;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(Object.assign(new Error("request timed out"), { name: "TimeoutError" }));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
      }
      function finish(error, value) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      }
      function onAbort() { finish(Object.assign(new Error("cancelled"), { name: "AbortError" })); }
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort);
      Promise.resolve(promise).then(function (value) { finish(null, value); }, function (error) { finish(error || new Error("request failed")); });
    });
  }

  async function fetchFollowingRedirects(url, headers, context) {
    var fetcher = context && context.fetch;
    if (typeof fetcher !== "function") return { errorCode: "FETCH_UNAVAILABLE" };
    var current = url;
    var sentHeaders = sanitizeHeaders(headers);
    var timeout = Number(context.timeoutMs || DEFAULT_TIMEOUT_MS);
    if (!isFinite(timeout) || timeout < 1 || timeout > 60000) timeout = DEFAULT_TIMEOUT_MS;
    for (var redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (isCancelled(context)) return { errorCode: "CANCELLED" };
      var response;
      try {
        response = await waitForTransport(
          fetcher(current, { method: "GET", headers: sentHeaders, redirect: "manual", timeoutMs: timeout, signal: context.signal }),
          timeout, context.signal
        );
      } catch (error) {
        if (error && /abort|cancel/i.test(String(error.name || error.message))) return { errorCode: "CANCELLED" };
        return { errorCode: error && /timed\s*out|timeout/i.test(String(error.name || error.message)) ? "NETWORK_TIMEOUT" : "NETWORK_ERROR" };
      }
      if (isCancelled(context)) return { errorCode: "CANCELLED" };
      var status = responseStatus(response);
      if ([301, 302, 303, 307, 308].indexOf(status) >= 0) {
        if (redirects === MAX_REDIRECTS) return { errorCode: "REDIRECT_LIMIT", httpStatus: status };
        var location = headerValue(response, "location");
        var next = resolveUrl(location, current);
        if (!next || !isAllowedUrl(next, context)) return { errorCode: "REDIRECT_REJECTED", httpStatus: status };
        var before = parseHttpUrl(current), after = parseHttpUrl(next);
        if (before && after && before.origin !== after.origin && context.forwardRefererAcrossRedirects !== true) {
          Object.keys(sentHeaders).forEach(function (key) {
            if (["referer", "origin"].indexOf(key.toLowerCase()) >= 0) delete sentHeaders[key];
          });
        }
        current = next;
        continue;
      }
      return { response: response, status: status, url: current, headers: sanitizeHeaders(sentHeaders) };
    }
    return { errorCode: "REDIRECT_LIMIT" };
  }

  async function readText(response) {
    if (response && typeof response.text === "function") return response.text();
    if (response && typeof response.body === "string") return response.body;
    return "";
  }

  async function readBytes(response) {
    if (response && typeof response.arrayBuffer === "function") {
      var buffer = await response.arrayBuffer();
      if (typeof Uint8Array !== "undefined") return new Uint8Array(buffer);
    }
    var text = await readText(response), bytes = [];
    for (var i = 0; i < text.length && i < 64; i += 1) bytes.push(text.charCodeAt(i) & 255);
    return bytes;
  }

  function bytesToText(bytes) {
    var text = "";
    var limit = Math.min(bytes ? bytes.length : 0, MAX_BODY_CHARS);
    for (var i = 0; i < limit; i += 1) text += String.fromCharCode(bytes[i] & 255);
    return text;
  }

  function isMp4Ftyp(bytes) {
    return bytes && bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  }

  function isHtmlMime(mime) { return /(?:text\/html|application\/xhtml\+xml)/i.test(mime || ""); }

  async function verifyCandidate(candidate, embedUrl, source, context) {
    var playbackHeaders = playbackHeadersFor(embedUrl, source, context);
    var probeHeaders = Object.assign({}, playbackHeaders);
    probeHeaders.Accept = candidate.type === "mp4" ? "video/mp4, application/octet-stream, */*;q=0.5" : "application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.5";
    probeHeaders.Range = "bytes=0-8191";
    var fetched = await fetchFollowingRedirects(candidate.url, probeHeaders, context);
    if (fetched.errorCode) return { errorCode: fetched.errorCode, httpStatus: fetched.httpStatus || null };
    var response = fetched.response, status = fetched.status;
    if (status < 200 || status > 299) return { errorCode: status === 401 || status === 403 ? "HTTP_STATUS_DENIED" : "MEDIA_HTTP_ERROR", httpStatus: status };
    var mime = headerValue(response, "content-type");
    if (isHtmlMime(mime)) return { errorCode: "HTML_RESPONSE", httpStatus: status };
    var bytes = await readBytes(response);
    if (bytes && bytes.length > MAX_PROBE_BYTES) return { errorCode: "MEDIA_PROBE_LIMIT", httpStatus: status };
    var body = bytesToText(bytes);
    if (isHtmlMime(mime) || /<\s*(?:!doctype\s+html|html|body)\b/i.test(body.slice(0, 1024))) {
      return { errorCode: "HTML_RESPONSE", httpStatus: status };
    }
    var mediaType = null;
    if (/^\s*#EXTM3U(?:\s|$)/i.test(body)) mediaType = "hls";
    else if (isMp4Ftyp(bytes)) mediaType = "mp4";
    else return { errorCode: "MEDIA_SIGNATURE_INVALID", httpStatus: status };
    if (mediaType === "hls" && !/^\s*#EXTM3U(?:\s|$)/i.test(body)) return { errorCode: "MEDIA_SIGNATURE_INVALID", httpStatus: status };
    if (mediaType === "mp4" && !isMp4Ftyp(bytes)) return { errorCode: "MEDIA_SIGNATURE_INVALID", httpStatus: status };
    return {
      url: fetched.url, type: mediaType, quality: candidate.quality || null,
      httpStatus: status, contentType: mime || null,
      playbackHeaders: playbackOnlyHeaders(headersForSubresource(playbackHeaders, candidate.url, fetched.url)),
      structure: mediaType === "hls" ? "m3u8-signature" : "iso-bmff-ftyp",
      hlsBody: mediaType === "hls" ? body : null
    };
  }

  async function fetchEmbed(url, context, headers) {
    var requestHeaders = Object.assign({
      "User-Agent": (context && context.userAgent) || USER_AGENT,
      "Accept-Language": (context && context.acceptLanguage) || ACCEPT_LANGUAGE,
      "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"
    }, headers || {});
    var fetched = await fetchFollowingRedirects(url, requestHeaders, context);
    if (fetched.errorCode) return fetched;
    if (fetched.status < 200 || fetched.status > 299) return { errorCode: fetched.status === 401 || fetched.status === 403 ? "HTTP_STATUS_DENIED" : "EMBED_HTTP_ERROR", httpStatus: fetched.status };
    var body = await readText(fetched.response);
    if (typeof body !== "string" || body.length > MAX_BODY_CHARS) return { errorCode: "EMBED_BODY_LIMIT", httpStatus: fetched.status };
    return { body: body, url: fetched.url, httpStatus: fetched.status };
  }

  async function resolveInternal(source, context) {
    context = context || {};
    source = typeof source === "string" ? { url: source } : (source || {});
    var embedUrl = typeof source.url === "string" ? source.url.trim() : "";
    var family = familyFromUrl(embedUrl, context.family || source.family);
    var rule = family && FAMILIES[family];
    var resolverId = rule ? rule.resolver : "dramaworld.generic.local";
    if (!embedUrl || !isAllowedUrl(embedUrl, context)) return result([], null, null, {}, resolverId, "INVALID_SOURCE_URL", { family: family, verified: false });
    if (isCancelled(context)) return result([], null, null, {}, resolverId, "CANCELLED", { family: family, verified: false });

    var directType = pathType(embedUrl);
    var body = typeof context.embedBody === "string" ? context.embedBody :
      (typeof source.embedBody === "string" ? source.embedBody : null);
    var playbackHeaders = playbackHeadersFor(embedUrl, source, context);
    if (!directType && body === null) {
      var embedRequestHeaders = Object.assign({}, playbackHeaders);
      delete embedRequestHeaders.Referer;
      var embed = await fetchEmbed(embedUrl, context, embedRequestHeaders);
      if (embed.errorCode) return result([], null, null, {}, resolverId, embed.errorCode, { family: family, httpStatus: embed.httpStatus || null, verified: false });
      body = embed.body;
      embedUrl = embed.url;
      playbackHeaders = playbackHeadersFor(embedUrl, source, context);
    }

    var candidates = directType ? [{ url: embedUrl, type: directType, quality: source.quality || source.label || null }] : parseCandidates(body, embedUrl, context);
    if (!candidates.length) {
      return result([], null, null, playbackHeaders, resolverId, "NO_MEDIA_CANDIDATE", { family: family, verified: false });
    }
    if (typeof context.fetch !== "function") return result([], null, null, playbackHeaders, resolverId, "FETCH_UNAVAILABLE", { family: family, verified: false });

    var streams = [], lastError = "MEDIA_SIGNATURE_INVALID", lastStatus = null;
    for (var i = 0; i < candidates.length && streams.length < MAX_CANDIDATES; i += 1) {
      if (isCancelled(context)) return result(streams, streams.length ? "mixed" : null, null, playbackHeaders, resolverId, "CANCELLED", { family: family, verified: streams.length > 0 });
      var checked;
      try { checked = await verifyCandidate(candidates[i], embedUrl, source, context); }
      catch (verifyError) {
        if (verifyError && /abort|cancel/i.test(String(verifyError.name || verifyError.message))) {
          return result(streams, streams.length ? "mixed" : null, null, playbackHeaders, resolverId, "CANCELLED", { family: family, verified: streams.length > 0 });
        }
        lastError = verifyError && /timed\s*out|timeout/i.test(String(verifyError.name || verifyError.message)) ? "NETWORK_TIMEOUT" : "MEDIA_VERIFY_FAILED";
        continue;
      }
      if (!checked.url) { lastError = checked.errorCode || lastError; lastStatus = checked.httpStatus || lastStatus; continue; }
      var hlsVariants = checked.type === "hls" ? parseHlsMaster(checked.hlsBody, checked.url, context) : [];
      var items = hlsVariants.length ? hlsVariants : [checked];
      items.forEach(function (item) {
        if (streams.some(function (existing) { return existing.url === item.url; })) return;
        var streamHeaders = checked.playbackHeaders || playbackHeaders;
        if (hlsVariants.length) streamHeaders = headersForSubresource(streamHeaders, checked.url, item.url);
        streams.push({
          url: item.url, type: checked.type,
          quality: item.quality || (hlsVariants.length ? null : checked.quality) || null,
          playbackHeaders: Object.assign({}, streamHeaders), verified: true,
          verification: hlsVariants.length ? "master-playlist-reference" : checked.structure,
          variantFetched: !hlsVariants.length, httpStatus: checked.httpStatus,
          contentType: checked.contentType, sourceFamily: family
        });
      });
    }
    if (!streams.length) return result([], null, null, playbackHeaders, resolverId, lastError, { family: family, httpStatus: lastStatus, verified: false });
    var types = {};
    streams.forEach(function (stream) { types[stream.type] = true; });
    var onlyTypes = Object.keys(types);
    return result(streams, onlyTypes.length === 1 ? onlyTypes[0] : "mixed",
      streams.length === 1 ? streams[0].quality : null, playbackHeaders, resolverId, null,
      { family: family, verified: true, extractedOnly: true, playbackTested: false });
  }

  async function resolve(source, context) {
    try { return await resolveInternal(source, context); }
    catch (error) {
      var item = typeof source === "string" ? { url: source } : (source || {});
      var family = familyFromUrl(item.url, context && (context.family || item.family));
      var resolverId = family && FAMILIES[family] ? FAMILIES[family].resolver : "dramaworld.generic.local";
      var message = error && String(error.name || error.message);
      var code = /abort|cancel/i.test(message) ? "CANCELLED" : /timed\s*out|timeout/i.test(message) ? "NETWORK_TIMEOUT" : "RESOLVER_EXCEPTION";
      return result([], null, null, {}, resolverId, code, { family: family, verified: false });
    }
  }

  async function resolveMany(sources, context) {
    var list = Array.isArray(sources) ? sources : [];
    var settled = await Promise.all(list.map(async function (source, index) {
      var childContext = Object.assign({}, context || {});
      var sourceBody = source && typeof source === "object" && typeof source.embedBody === "string";
      if (sourceBody) childContext.embedBody = source.embedBody;
      else if (list.length > 1) delete childContext.embedBody;
      if (typeof childContext.contextForSource === "function") {
        try { childContext = Object.assign(childContext, childContext.contextForSource(source, index) || {}); }
        catch (_) { return result([], null, null, {}, "dramaworld.generic.local", "RESOLVER_EXCEPTION", { verified: false }); }
      }
      delete childContext.contextForSource;
      try { return await resolve(source, childContext); }
      catch (_) { return result([], null, null, {}, "dramaworld.generic.local", "RESOLVER_EXCEPTION", { verified: false }); }
    }));
    return settled;
  }

  var api = {
    version: VERSION,
    resolve: resolve,
    resolveMany: resolveMany,
    familyFromUrl: familyFromUrl,
    parseCandidates: parseCandidates,
    parseHlsMaster: parseHlsMaster,
    unpackPackerText: unpackPackerText,
    playbackHeadersFor: playbackHeadersFor,
    headersForSubresource: headersForSubresource,
    mediaSignature: { isMp4Ftyp: isMp4Ftyp }
  };
  root.DramaWorldResolver = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

  var api = globalThis.DramaWorldResolver;
  try { delete globalThis.DramaWorldResolver; } catch (_) {}
  return api;
})();
