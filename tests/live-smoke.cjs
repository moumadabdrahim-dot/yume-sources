#!/usr/bin/env node
'use strict';

// Runs the production API v2 plugin against OscarTV with bounded read-only calls.
// Raw signed URLs and response objects remain in memory and are passed directly
// to the existing redacting analyzer; nothing is written to disk.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { summarize } = require('../tools/oscar-watchlink-evidence.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'oscartv-v2.js'), 'utf8');
const apiEvents = [];
const mediaHops = [];
const TARGET_SERVER_LABEL = process.env.OSCAR_TARGET_SERVER_LABEL || 'Via — Server 4';

function safeApiUrl(value) {
  try {
    const url = new URL(String(value));
    return { host: url.hostname, path: url.pathname, queryKeys: [...new Set([...url.searchParams.keys()])].sort() };
  } catch (_) {
    return { host: null, path: null, queryKeys: [] };
  }
}

function safeResponseHeaders(headers) {
  const values = {};
  for (const name of ['date', 'server', 'via', 'content-type', 'content-length', 'cf-ray', 'cf-cache-status',
    'x-request-id', 'x-correlation-id', 'request-id', 'x-cache', 'retry-after', 'allow']) {
    const value = headers.get(name);
    if (value) values[name] = value.slice(0, 180);
  }
  values['www-authenticate-present'] = !!headers.get('www-authenticate');
  values['set-cookie-present'] = !!headers.get('set-cookie');
  return values;
}

function responseCategory(status, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('json')) return status >= 400 ? 'json-error' : 'json';
  if (type.includes('html')) return status >= 400 ? 'html-error-page' : 'html';
  if (!type) return 'no-content-type';
  return status >= 400 ? 'non-json-error' : 'non-json';
}

async function safeErrorBodyCategory(response, contentType) {
  if (response.status < 400) return null;
  let body = '';
  try {
    const clone = response.clone();
    if (clone.body && typeof clone.body.getReader === 'function') {
      const reader = clone.body.getReader();
      const chunks = [];
      let size = 0;
      while (size < 16384) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, 16384 - size);
        chunks.push(chunk);
        size += chunk.length;
        if (chunk.length < value.length) break;
      }
      try { await reader.cancel(); } catch (_) {}
      body = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
    } else {
      body = (await clone.text()).slice(0, 16384);
    }
  } catch (_) {}
  const text = body.toLowerCase();
  if (/error code\s*:?\s*(1020|1015)|you have been blocked|cf-error-details|cloudflare ray id/.test(text)) {
    return 'cloudflare-block-page';
  }
  if (/cf-chl-|attention required|checking your browser|verify you are human/.test(text)) {
    return 'cloudflare-challenge-page';
  }
  if (String(contentType || '').toLowerCase().includes('html')) return 'generic-html-error-page';
  return text ? 'error-body-present' : 'empty-error-body';
}

function wordArray(bytes) {
  const value = Buffer.from(bytes);
  const words = [];
  for (let i = 0; i < value.length; i++) words[i >>> 2] = (words[i >>> 2] || 0) | (value[i] << (24 - (i % 4) * 8));
  return { words, sigBytes: value.length, _bytes: value,
    toString: () => value.toString('hex') };
}

function bytesOf(value) {
  if (Buffer.isBuffer(value._bytes)) return value._bytes;
  const bytes = Buffer.alloc(value.sigBytes);
  for (let i = 0; i < value.sigBytes; i++) bytes[i] = (value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
  return bytes;
}

const CryptoJS = {
  enc: {
    Utf8: { parse: value => wordArray(Buffer.from(String(value), 'utf8')) },
    Hex: { stringify: value => bytesOf(value).toString('hex') }
  },
  lib: { WordArray: {
    create: (words, size) => wordArray(Buffer.isBuffer(words)
      ? words.subarray(0, size)
      : Array.from({ length: size }, (_, i) => (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255)),
    random: size => wordArray(crypto.randomBytes(size))
  } },
  SHA256: value => wordArray(crypto.createHash('sha256').update(bytesOf(value)).digest()),
  HmacSHA256: (message, key) => wordArray(crypto.createHmac('sha256', bytesOf(key)).update(String(message)).digest())
};

async function observedFetch(input, options = {}) {
  const requestUrl = String(input);
  const response = await fetch(input, options);
  let parsedUrl;
  try { parsedUrl = new URL(requestUrl); } catch (_) {}
  if (parsedUrl && parsedUrl.hostname === 'ostv-11-11.xyz' && parsedUrl.pathname.startsWith('/api/')) {
    const contentType = response.headers.get('content-type') || '';
    const headerNames = Object.keys(options.headers || {}).map(name => name.toLowerCase()).sort();
    apiEvents.push({
      ...safeApiUrl(requestUrl), method: options.method || 'GET', status: response.status,
      requestHeaderNames: headerNames, ironDiagSent: headerNames.includes('x-iron-diag'),
      responseCategory: responseCategory(response.status, contentType),
      responseBodyCategory: await safeErrorBodyCategory(response, contentType),
      responseHeaders: safeResponseHeaders(response.headers)
    });
  } else {
    mediaHops.push({
      url: requestUrl,
      finalUrl: response.url || requestUrl,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
      method: options.method || 'GET'
    });
  }
  return response;
}

function loadProductionPlugin() {
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, CryptoJS, fetch: observedFetch, console: { warn() {}, error() {} }, Date, URL,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, isFinite, setTimeout, encodeURIComponent, decodeURIComponent
  };
  vm.runInNewContext(source, context, { filename: 'oscartv-v2.js' });
  return module.exports;
}

function normalizedTitle(item) {
  return [item && item.title, item && item.originalTitle].filter(Boolean).join(' ').toLowerCase();
}

function serverNumber(value) {
  const match = /(?:^|[^a-z0-9])server\s*[-#]?\s*(\d+)\s*$/i.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function selectTargetOption(options, requestedLabel) {
  const requested = String(requestedLabel || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const requestedServerNumber = serverNumber(requestedLabel);
  const matches = [];
  (options || []).forEach((option, index) => {
    let tokenLink = {};
    try { tokenLink = JSON.parse(option.token || '{}').link || {}; } catch (_) {}
    const labels = [option.label, option.title, tokenLink.server_name].filter(Boolean);
    const exact = labels.some(label => String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') === requested);
    const labeledServer = requestedServerNumber != null && labels.some(label => serverNumber(label) === requestedServerNumber);
    if (exact || labeledServer) matches.push({ option, index });
  });
  return matches.length === 1 ? matches[0] : null;
}

function blockedStatus() {
  return apiEvents.find(event => event.status < 200 || event.status >= 300) || null;
}

async function main() {
  const plugin = loadProductionPlugin();
  const seriesPage = await plugin.getCatalog({
    catalogId: 'series', type: 'series', query: 'House of the Dragon', limit: 20
  });
  const series = seriesPage.items.find(item => /house\s+of\s+the\s+dragon|آل\s*التنين/i.test(normalizedTitle(item)));
  if (!series) {
    const blocked = blockedStatus();
    if (blocked) {
      process.stdout.write(JSON.stringify({
        case: 'House of the Dragon / S01E01', realWatchLinkObtained: false,
        requestVariant: 'production plugin request',
        request: { method: blocked.method, host: blocked.host, path: blocked.path,
          queryKeys: blocked.queryKeys, requestHeaderNames: blocked.requestHeaderNames },
        upstreamStatus: blocked.status, responseCategory: blocked.responseCategory,
        responseBodyCategory: blocked.responseBodyCategory,
        responseHeaders: blocked.responseHeaders,
        note: 'OscarTV denied the normal plugin request; no response body or credentials are printed.'
      }, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({
      case: 'House of the Dragon / S01E01', realWatchLinkObtained: false,
      searchResultCount: seriesPage.items.length, note: 'No exact title match was returned.'
    }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  const details = await plugin.getDetails({ id: series.nativeId });
  const episode = details.episodes.find(item => item.season === 1 && item.episode === 1);
  if (!episode) {
    const blocked = blockedStatus();
    process.stdout.write(JSON.stringify({
      case: 'House of the Dragon / S01E01', realWatchLinkObtained: false,
      seriesNativeId: series.nativeId, upstreamStatus: blocked && blocked.status || null,
      responseCategory: blocked && blocked.responseCategory || null,
      responseBodyCategory: blocked && blocked.responseBodyCategory || null,
      responseHeaders: blocked && blocked.responseHeaders || null,
      note: 'The normal details flow did not return the target episode.'
    }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  const listing = await plugin.getStreams({ id: episode.nativeId, mode: 'options' });
  const yumeListing = listing.options.map((option, index) => ({
    ordinal: index + 1, title: option.title, label: option.title, token: option.token
  }));
  const capture = {
    nativeEpisodeId: episode.nativeId,
    runtimeTrace: { events: apiEvents, yumeListing },
    hops: mediaHops
  };
  const selected = selectTargetOption(listing.options, TARGET_SERVER_LABEL);
  if (selected) {
    capture.runtimeTrace.selectedYumeOrdinal = selected.index + 1;
    capture.runtimeTrace.selectedYumeLabel = selected.option.title;
    const resolved = await plugin.resolveStreamOption({ id: episode.nativeId, token: selected.option.token });
    const candidate = resolved.streams[0];
    if (candidate) capture.playerCandidate = { url: candidate.url, type: candidate.type };
    capture.runtimeTrace.playerStream = candidate || null;
  }
  const report = summarize(capture);
  report.case = 'House of the Dragon / S01E01';
  report.requestVariant = 'production plugin request';
  report.apiRequests = apiEvents;
  report.seriesNativeId = series.nativeId;
  report.realWatchLinkObtained = true;
  report.requestedServerLabel = TARGET_SERVER_LABEL;
  report.selectedOptionMatchedByLabel = !!selected;
  if (!selected) report.resolutionNote = 'The requested server label was absent or ambiguous; no option was resolved.';
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!selected) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    const blocked = blockedStatus();
    process.stdout.write(JSON.stringify({
      case: 'House of the Dragon / S01E01', realWatchLinkObtained: false,
      upstreamStatus: blocked && blocked.status || null,
      requestVariant: 'production plugin request',
      request: blocked ? { method: blocked.method, host: blocked.host, path: blocked.path,
        queryKeys: blocked.queryKeys, requestHeaderNames: blocked.requestHeaderNames } : null,
      responseCategory: blocked && blocked.responseCategory || null,
      responseBodyCategory: blocked && blocked.responseBodyCategory || null,
      responseHeaders: blocked && blocked.responseHeaders || null,
      error: blocked ? 'OscarTV rejected the normal plugin request.' : 'The normal plugin flow failed before a WatchLink capture.'
    }, null, 2) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { selectTargetOption };
