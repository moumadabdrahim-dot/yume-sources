#!/usr/bin/env node
'use strict';

// Offline-only analyzer for a legitimately captured Oscar WatchLink response.
// This utility never fetches URLs and never prints query strings or fragments.
const fs = require('node:fs');

function usage() {
  console.error('Usage: node tools/oscar-watchlink-evidence.cjs <capture.json | ->');
  console.error('Reads a saved capture or JSON from stdin. Performs no network requests.');
  process.exit(2);
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      hostname: parsed.hostname || null,
      pathname: safePathname(parsed.pathname || '/'),
      http: parsed.protocol === 'http:' || parsed.protocol === 'https:'
    };
  } catch (_) {
    return null;
  }
}

function safePathname(pathname) {
  const segments = pathname.split('/');
  return segments.map((segment, index) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch (_) {}
    // Oscar's CDN uses short path tokens after /t/; redact them as well as
    // long opaque path segments and signed query values.
    if ((index > 0 && segments[index - 1].toLowerCase() === 't') ||
        /^(?:token|sig(?:nature)?|auth|key)[-_:=.]/i.test(decoded) ||
        /^[A-Za-z0-9+/_=-]{40,}$/.test(decoded) || /^[a-f0-9]{32,}$/i.test(decoded)) {
      return '[REDACTED]';
    }
    return segment;
  }).join('/');
}

function embeddedUrl(deepLink) {
  if (typeof deepLink !== 'string') return null;
  const direct = safeUrl(deepLink);
  if (direct && direct.http) return direct;
  try {
    const parsed = new URL(deepLink);
    for (const key of ['url', 'video_url', 'stream', 'link']) {
      const value = parsed.searchParams.get(key);
      const candidate = safeUrl(value);
      if (candidate) return candidate;
    }
  } catch (_) {
    // Unsupported/nonstandard URI formats stay unparsed and are never emitted.
  }
  return null;
}

function findLinks(root) {
  const candidates = [
    root.watchLinks,
    root.watch_links,
    root.watchLinkResponse && root.watchLinkResponse.watch_links,
    root.watchLinkResponse && root.watchLinkResponse.body && root.watchLinkResponse.body.watch_links,
    root.watchLinkResponse && root.watchLinkResponse.body && root.watchLinkResponse.body.data && root.watchLinkResponse.body.data.watch_links,
    root.watchLinkResponse && root.watchLinkResponse.response && root.watchLinkResponse.response.data && root.watchLinkResponse.response.data.watch_links,
    root.runtimeCapture && root.runtimeCapture.watchLinkResponse && root.runtimeCapture.watchLinkResponse.body &&
      root.runtimeCapture.watchLinkResponse.body.data && root.runtimeCapture.watchLinkResponse.body.data.watch_links,
    root.runtimeTrace && root.runtimeTrace.watchLinkResponse && root.runtimeTrace.watchLinkResponse.body &&
      root.runtimeTrace.watchLinkResponse.body.data && root.runtimeTrace.watchLinkResponse.body.data.watch_links,
    root.response && root.response.watch_links,
    root.response && root.response.data && root.response.data.watch_links,
    root.data && root.data.watch_links,
    root.payload && root.payload.watch_links
  ];
  const direct = candidates.find(Array.isArray);
  if (direct) return direct;

  // Runtime fetch captures may store the actual detail response as an event.
  const events = root.fetchEvents || root.runtimeTrace && root.runtimeTrace.events || root.runtimeCapture && root.runtimeCapture.fetchEvents;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    const requestUrl = event && (event.requestUrl || event.url || event.request && event.request.url);
    let path = '';
    try { path = new URL(String(requestUrl || ''), 'https://capture.invalid').pathname; } catch (_) {}
    const body = objectValue(event && (event.responseBody || event.body || event.payload || event.response && event.response.body));
    if (!body) continue;
    if (path.endsWith('/api/watch_links/')) {
      if (Array.isArray(body.data)) return body.data;
      if (Array.isArray(body.data && body.data.data)) return body.data.data;
    }
    if (path.endsWith('/api/episodes/show.php') || path.endsWith('/api/anime/episodes/show.php') ||
        path.endsWith('/api/movies/show.php') || path.endsWith('/api/anime/show.php')) {
      const links = body.data && body.data.watch_links || body.watch_links;
      if (Array.isArray(links)) return links;
    }
  }
  return null;
}

function tokenLink(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const token = entry.token;
  if (typeof token === 'string') {
    try {
      const parsed = JSON.parse(token);
      if (parsed && (parsed.version === 1 || parsed.version === 2 || parsed.version === 3) && parsed.link && typeof parsed.link === 'object') return parsed.link;
    } catch (_) {}
  }
  if (entry.link && typeof entry.link === 'object') return entry.link;
  if (typeof entry.url === 'string') return entry;
  return null;
}

function sameUrl(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

function durationMetadata(link) {
  if (!link || typeof link !== 'object') return null;
  for (const field of ['duration_seconds', 'durationSeconds', 'runtime_seconds', 'duration', 'runtime']) {
    const raw = link[field];
    const value = typeof raw === 'string' && /^\d+(?::\d{1,2}){0,2}$/.test(raw.trim()) ? raw.trim() : raw;
    if ((typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400000) ||
        (typeof value === 'string' && /^\d+(?::\d{1,2}){0,2}$/.test(value))) {
      return { sourceField: field, value, unit: /(?:_seconds|Seconds)$/.test(field) ? 'seconds' : 'provider-defined' };
    }
  }
  return null;
}

function objectValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) {}
  }
  return null;
}

function safeCandidate(link, watchLinks) {
  if (!link) return { matchedWatchLink: null, selectedField: null, selectedTarget: null };
  const selectedUrl = typeof link.selected_url === 'string' ? link.selected_url : (typeof link.url === 'string' ? link.url : '');
  const parsed = safeUrl(selectedUrl);
  const linkId = link.watch_link_id != null ? String(link.watch_link_id) : null;
  let matchIndex = linkId == null ? -1 : watchLinks.findIndex(item => item && item.id != null && String(item.id) === linkId);
  if (matchIndex < 0) matchIndex = watchLinks.findIndex(item => sameUrl(item && item.url, link.url));
  if (matchIndex < 0) {
    matchIndex = watchLinks.findIndex(item =>
      item && item.server_name === link.server_name && item.quality === link.quality &&
      item.type === link.type && sameUrl(item.url, link.url));
  }
  let selectedField = link.selected_field || null;
  if (!selectedField && matchIndex >= 0) {
    const source = watchLinks[matchIndex];
    if (sameUrl(source.deep_link, selectedUrl)) selectedField = 'deep_link';
    else if (source.deep_link && embeddedUrl(source.deep_link) && sameUrl(source.deep_link, selectedUrl)) selectedField = 'deep_link';
    else if (source.url && sameUrl(source.url, selectedUrl)) selectedField = 'url';
    else if (source.deep_link && embeddedUrl(source.deep_link)) selectedField = 'deep_link.url';
  }
  return {
    matchedWatchLink: matchIndex < 0 ? null : matchIndex,
    selectedField: parsed && parsed.http ? selectedField : (typeof link.selected_field === 'string' ? link.selected_field : null),
    selectedTarget: parsed && parsed.http ? parsed : null
  };
}

function summarize(capture) {
  const runtimeCapture = capture.runtimeCapture || capture.runtimeTrace || {};
  const watchLinks = findLinks(capture);
  if (!watchLinks) throw new Error('No watch_links array found in the supplied capture.');
  const nativeEpisodeId = capture.nativeEpisodeId || capture.native_episode_id || runtimeCapture.nativeEpisodeId ||
    (capture.request && capture.request.id) || (runtimeCapture.request && runtimeCapture.request.id) || null;
  const listing = Array.isArray(capture.yumeListing) ? capture.yumeListing :
    (Array.isArray(runtimeCapture.yumeListing) ? runtimeCapture.yumeListing : []);
  const selectedYumeOrdinal = capture.selectedYumeOrdinal || runtimeCapture.selectedYumeOrdinal || null;
  const selectedYumeLabel = capture.selectedYumeLabel || runtimeCapture.selectedYumeLabel || null;
  const result = {
    nativeEpisodeId,
    selectedYumeOrdinal,
    selectedYumeLabel,
    watchLinks: watchLinks.map((link, index) => {
      const url = safeUrl(link && link.url);
      const deep = safeUrl(link && link.deep_link);
      const embedded = embeddedUrl(link && link.deep_link);
      return {
        sourceIndex0: index,
        sourceOrdinal1: index + 1,
        id: link && link.id != null ? link.id : null,
        serverName: link && link.server_name != null ? link.server_name : null,
        quality: link && link.quality != null ? link.quality : null,
        type: link && link.type != null ? link.type : null,
        hasUrl: !!(link && typeof link.url === 'string' && link.url.trim()),
        url: url ? { scheme: url.scheme, hostname: url.hostname, pathname: url.pathname } : null,
        hasDeepLink: !!(link && typeof link.deep_link === 'string' && link.deep_link.trim()),
        deepLink: deep ? { scheme: deep.scheme, hostname: deep.hostname, pathname: deep.pathname } : null,
        embeddedUrl: embedded ? { scheme: embedded.scheme, hostname: embedded.hostname, pathname: embedded.pathname } : null,
        durationMetadata: durationMetadata(link),
        yumePlayableFromUrl: !!(url && url.http),
        yumeSelectedField: embedded ? 'deep_link.url' : (url && url.http ? 'url' : null)
      };
    })
  };

  const selectedOrdinal = Number(selectedYumeOrdinal);
  const selectedEntry = Number.isInteger(selectedOrdinal) && selectedOrdinal > 0
    ? listing[selectedOrdinal - 1]
    : listing.find(entry => entry && (entry.label === selectedYumeLabel || entry.title === selectedYumeLabel));
  if (selectedEntry) {
    const candidate = tokenLink(selectedEntry);
    const mapping = safeCandidate(candidate, watchLinks);
    result.yumeSelection = {
      displayOrdinal1: listing.indexOf(selectedEntry) + 1,
      displayLabel: selectedEntry.label || selectedEntry.title || null,
      kind: selectedEntry.kind || (selectedEntry.token ? 'option' : 'stream'),
      matchedWatchLink: mapping.matchedWatchLink == null ? null : {
        sourceIndex0: mapping.matchedWatchLink,
        sourceOrdinal1: mapping.matchedWatchLink + 1,
        id: watchLinks[mapping.matchedWatchLink] && watchLinks[mapping.matchedWatchLink].id != null
          ? watchLinks[mapping.matchedWatchLink].id : null
      },
      selectedField: mapping.selectedField,
      selectedCandidate: mapping.selectedTarget
    };
  } else {
    result.yumeSelection = null;
    result.selectionMappingNote = listing.length
      ? 'Selected display ordinal/label did not match yumeListing.'
      : 'Provide the exact ordered Yume UI listing to map “Server N” to a WatchLink.';
  }

  const returned = capture.playerCandidate || capture.resolvedStream || capture.playerStream || runtimeCapture.playerCandidate ||
    runtimeCapture.resolvedStream || runtimeCapture.playerStream || null;
  if (returned) {
    const returnedUrl = safeUrl(returned.url);
    const selection = result.yumeSelection;
    result.playerCandidate = {
      url: returnedUrl ? { scheme: returnedUrl.scheme, hostname: returnedUrl.hostname, pathname: returnedUrl.pathname } : null,
      type: returned.type || returned.streamType || null,
      contentType: returned.contentType || returned.mimeType || null,
      durationSeconds: Number.isFinite(Number(returned.durationSeconds)) ? Number(returned.durationSeconds) : null,
      correspondsToSelectedWatchLink: selection && selection.matchedWatchLink
        ? 'Compare selected candidate and this URL; redirects may make paths differ.' : 'unmapped'
    };
  }

  const hops = capture.hops || runtimeCapture.hops;
  if (Array.isArray(hops)) {
    result.hops = hops.map(hop => {
      const from = safeUrl(hop && (hop.url || hop.from));
      const to = safeUrl(hop && (hop.redirectTo || hop.location || hop.finalUrl));
      return {
        status: hop && hop.status != null ? hop.status : null,
        from: from ? { scheme: from.scheme, hostname: from.hostname, pathname: from.pathname } : null,
        to: to ? { scheme: to.scheme, hostname: to.hostname, pathname: to.pathname } : null,
        contentType: hop && (hop.contentType || hop.mimeType) || null,
        durationSeconds: hop && Number.isFinite(Number(hop.durationSeconds)) ? Number(hop.durationSeconds) : null,
        observation: hop && ['requested-episode', 'warning-video', 'access-denied', 'unknown'].includes(hop.observation)
          ? hop.observation : null
      };
    });
  }
  return result;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) usage();
  const raw = inputPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(inputPath, 'utf8');
  const capture = JSON.parse(raw);
  const report = summarize(capture);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Capture analysis failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { summarize, safeUrl };
