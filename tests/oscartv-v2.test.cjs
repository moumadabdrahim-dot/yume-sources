const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { summarize: summarizeWatchLinks } = require('../tools/oscar-watchlink-evidence.cjs');
const { selectTargetOption } = require('./live-smoke.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins/oscartv-v2.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const ORIGINAL_ENCRYPTED_DOMAIN_CONFIG = "cG1q2ai4gZGtgQFNbZLJcqfw8R4FL5l9aUXHJLcwAZQ3alLqX30LSOIVQeIRPhpM3BMD858RdXOFjZxomEKaZ6AISXSldwd6xWOZM24qtYBMyijxQbCuo3lXQyksDmQZGp/iVqGYEPA50mXS9qOvrsP8+d1fBMGekx6y04meLq0w0ZMDioTv6joUdBy2UWh1nywgA+v1zDLS0ItVLK//Z9tZ5n4VIJ7kDpGHroFBfpB318ILqJbqIiKyVktI2k1obMJLKNcGO8aYLKuk3NIan9Wml0ex4F0SDkKCejOLQY73qAUp/6qcpjnRWFEREnFLYuHEzy6Fk24pf8awbGRCJbmc3MZzgBeYsSKjk3+vL2ZTkkutBqyv97DLA2fbqS6XZPbVUephi4p6XDmnmsE3vX1mAU9f5VLDR037JuGywWJ1WGqIoqCC3DhPrenXKBuSfhH3WcnxJY8sFgJ+jIo/9e2S/LIDg74sCCJmMc8GR37DfhuecKYsWCkdizu14+04JLoCBhIUrf1s6dMq8tMB5TBuyJmkvLJbWLYofAag4G5ZF2X2Vnhnb0BN/B8jdvFegIsZbPp5bONgGl98irSKR82YBFhi766CHRwlCcl3Mhz3PwEx2bjzS8M+D8SN3xAKQaQOo4h3NBNKtRvR8k5cDrhkqC7U/r0PhyEhD16osWG1Hwo80C5c";
function wordArray(bytes) {
  const value = Buffer.from(bytes);
  const words = [];
  for (let i = 0; i < value.length; i++) words[i >>> 2] = (words[i >>> 2] || 0) | (value[i] << (24 - (i % 4) * 8));
  return { words, sigBytes: value.length, _bytes: value, toString() { return value.toString('hex'); } };
}
function bytesOf(value) {
  if (Buffer.isBuffer(value._bytes)) return value._bytes;
  const bytes = Buffer.alloc(value.sigBytes);
  for (let i = 0; i < value.sigBytes; i++) bytes[i] = (value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
  return bytes;
}
const CryptoJS = {
  enc: {
    Utf8: { parse: value => wordArray(Buffer.from(String(value), 'utf8')),
      stringify: value => bytesOf(value).toString('utf8') },
    Hex: { stringify: value => bytesOf(value).toString('hex'), parse: value => wordArray(Buffer.from(String(value), 'hex')) },
    Base64: { parse: value => wordArray(Buffer.from(String(value), 'base64')) }
  },
  lib: { WordArray: {
    create: (words, size) => wordArray(Buffer.isBuffer(words) ? words.subarray(0, size) : Array.from({ length: size }, (_, i) => (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255)),
    random: size => wordArray(Buffer.from(Array.from({ length: size }, (_, i) => i + 1)))
  } },
  SHA256: value => wordArray(crypto.createHash('sha256').update(bytesOf(value)).digest()),
  HmacSHA256: (message, key) => wordArray(crypto.createHmac('sha256', bytesOf(key)).update(Buffer.from(String(message))).digest()),
  mode: { GCM: 'AES-GCM' },
  pad: { NoPadding: 'NoPadding' },
  AES: { decrypt: (cipher, key, options = {}) => {
    const bytes = bytesOf(cipher.ciphertext || cipher);
    const keyBytes = bytesOf(key);
    const nonce = bytesOf(options.iv);
    if (options.mode !== 'AES-GCM' || bytes.length < 16) throw new Error('Invalid AES-GCM test input');
    const decipher = crypto.createDecipheriv(`aes-${keyBytes.length * 8}-gcm`, keyBytes, nonce);
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return wordArray(Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]));
  } }
};
const DOMAIN_CONFIG_URLS = new Set([
  'https://raw.githubusercontent.com/MBoshkash/ostv-config/main/domains.json',
  'https://cdn.jsdelivr.net/gh/MBoshkash/ostv-config@main/domains.json'
]);
const DEFAULT_TEST_DOMAIN_CONFIG = JSON.stringify({ default_domain: 'https://ostv-11-11.xyz/', backup_domains: [] });
function loadPlugin(fetchImpl, options = {}) {
  const module = { exports: {} };
  const observedFetch = async (url, requestOptions = {}) => {
    const parsed = new URL(url);
    const isBootstrap = DOMAIN_CONFIG_URLS.has(url);
    const isProbe = parsed.pathname === '/api/movies/' && parsed.searchParams.get('page') === '1' &&
      parsed.searchParams.get('limit') === '1' && parsed.searchParams.get('sort_by') === 'views_today';
    if (options.mockBootstrapAndProbe !== false && isBootstrap) {
      return httpResponse({ status: 200, url, contentType: 'text/plain', body: options.remoteConfigBody ?? DEFAULT_TEST_DOMAIN_CONFIG });
    }
    if (options.mockBootstrapAndProbe !== false && isProbe) {
      return apiResponse([{ id: 1, title_en: 'Probe' }], { page: 1, page_count: 1, total: 1, per_page: 1 });
    }
    options.onFetch?.(url, requestOptions);
    return fetchImpl(url, requestOptions);
  };
  observedFetch.supportsNativeTimeout = options.nativeTimeoutSupport !== false;
  const context = { module, exports: module.exports, CryptoJS, __YUME_OSCAR_TESTING__: true, fetch: observedFetch,
    console, Date: options.Date || Date, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, isFinite,
    setTimeout: options.setTimeout || (callback => { callback(); return 0; }), encodeURIComponent, decodeURIComponent };
  vm.runInNewContext(source, context, { filename: 'oscartv-v2.js' });
  return module.exports;
}
function apiResponse(data, pagination = {}) {
  return { ok: true, status: 200, json: async () => ({ status: 'success', data, pagination }) };
}
function httpResponse({ status = 200, url, contentType = '', body = '', headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => {
      const key = String(name).toLowerCase();
      return key === 'content-type' ? contentType : (headers[key] || null);
    } },
    text: async () => body
  };
}

test('v2 exports aggregate Home/catalog/details/streams and preserves the deterministic Iron signer', () => {
  const plugin = loadPlugin(async () => { throw new Error('unexpected network'); });
  const vector = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/iron-signer.json'), 'utf8'));
  const [pathPart, timestamp, nonce] = vector.source.split('|');
  assert.equal(typeof plugin.getHome, 'function');
  assert.equal(typeof plugin.search, 'function');
  assert.equal(typeof plugin.getCatalog, 'function');
  assert.equal(plugin.__test.sign(pathPart, timestamp, nonce), vector.expectedSignature);
});

test('the current original OscarTV AES-GCM domain feed decrypts and preserves ordered candidates', () => {
  const plugin = loadPlugin(async () => { throw new Error('unexpected network'); });
  const candidates = plugin.__test.domainCandidatesFromConfig(ORIGINAL_ENCRYPTED_DOMAIN_CONFIG);
  assert.equal(candidates[0], 'https://ostvapp.cam');
  assert.equal(candidates[1], 'https://api.myychann.site');
  assert.equal(candidates[2], 'https://api.ossccaarr111.online');
  assert.equal(candidates[3], 'https://ostv-11-11.xyz');
  assert.equal(candidates.at(-1), 'https://weathered-forest-d8db.manon-lol2000.workers.dev');
  assert.equal(candidates.includes('https://poster.ostv-11-33.xyz'), false);
  assert.equal(plugin.__test.domainCandidatesFromConfig('{malformed'), null);
});

test('domain config accepts only HTTPS host roots and always reserves the known .xyz fallback', () => {
  const plugin = loadPlugin(async () => { throw new Error('unexpected network'); });
  const candidates = plugin.__test.domainCandidatesFromConfig(JSON.stringify({
    default_domain: 'http://insecure.example.net/',
    backup_domains: [
      'https://user:pass@credential.example.net/',
      'https://path.example.net/api/',
      'https://invalid_label.example.net/',
      'https://valid.example.net/'
    ]
  }));
  assert.deepEqual(Array.from(candidates), ['https://valid.example.net', 'https://ostv-11-11.xyz']);
  const manyDomains = Array.from({ length: 32 }, (_, index) => `https://domain-${index}.example.net/`);
  const bounded = plugin.__test.domainCandidatesFromConfig(JSON.stringify({ backup_domains: manyDomains }));
  assert.equal(bounded.length, 16);
  assert.equal(bounded.at(-1), 'https://ostv-11-11.xyz');
  assert.deepEqual(Array.from(plugin.__test.domainCandidatesFromConfig(JSON.stringify(['https://legacy.example.net/']))), [
    'https://legacy.example.net', 'https://ostv-11-11.xyz'
  ]);
});

test('configuration bootstrap uses the fixed source without API signatures and selects a valid configured primary', async () => {
  const events = [];
  const config = JSON.stringify({ default_domain: 'https://primary.example.net/', backup_domains: ['https://backup.example.net/'] });
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    if (DOMAIN_CONFIG_URLS.has(url)) return httpResponse({ status: 200, url, contentType: 'text/plain', body: config });
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([{ id: 1 }], { page: 1, page_count: 1, total: 1, per_page: 1 });
    }
    return apiResponse([{ id: 42, title_en: 'Configured movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, onFetch: (url, options) => events.push({ url, options }) });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:42');
  assert.deepEqual(events.map(event => new URL(event.url).hostname), [
    'raw.githubusercontent.com', 'primary.example.net', 'primary.example.net'
  ]);
  assert.equal(events[0].options.redirect, 'manual');
  assert.equal(events[0].options.timeoutMs, 3000);
  assert.deepEqual(Object.keys(events[0].options.headers), ['Accept']);
  assert.equal(events[0].options.headers['X-Iron-Sig'], undefined);
  assert.equal(events[1].options.redirect, 'manual');
  assert.equal(events[1].options.timeoutMs, 4000);
  assert.match(events[1].options.headers['X-Iron-Sig'], /^[a-f0-9]{64}$/);
  assert.equal(plugin.__test.selectedApiDomain(), 'https://primary.example.net');
});

test('domain discovery bounds native requests and reserves the third probe for the known fallback', async () => {
  let now = 1_000;
  const FakeDate = { now: () => now, parse: Date.parse };
  const config = JSON.stringify({
    default_domain: 'https://primary.example.net/',
    backup_domains: ['https://backup.example.net/', 'https://not-probed.example.net/']
  });
  const events = [];
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    events.push({ url, options });
    if (DOMAIN_CONFIG_URLS.has(url)) {
      return httpResponse({ status: 200, url, contentType: 'application/json', body: config });
    }
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      if (parsed.hostname !== 'ostv-11-11.xyz') {
        now += options.timeoutMs;
        throw new Error('native timeout');
      }
      return apiResponse([{ id: 9 }], { page: 1, page_count: 1 });
    }
    return apiResponse([{ id: 90, title_en: 'Fallback movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, Date: FakeDate });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  const probes = events.filter(event => new URL(event.url).searchParams.get('sort_by') === 'views_today');
  assert.equal(result.items[0].nativeId, 'movie:90');
  assert.deepEqual(probes.map(event => new URL(event.url).hostname), [
    'primary.example.net', 'backup.example.net', 'ostv-11-11.xyz'
  ]);
  assert.deepEqual(probes.map(event => event.options.timeoutMs), [4000, 4000, 4000]);
  assert.equal(events.some(event => new URL(event.url).hostname === 'not-probed.example.net'), false);
  assert.ok(now - 1_000 <= plugin.__test.discoveryPolicy.budgetMs);
});

test('slow configuration sources consume only their native timeout and still leave time for fallback', async () => {
  let now = 10_000;
  const FakeDate = { now: () => now, parse: Date.parse };
  const events = [];
  const plugin = loadPlugin(async (url, options) => {
    events.push({ url, options });
    const parsed = new URL(url);
    if (DOMAIN_CONFIG_URLS.has(url)) {
      now += options.timeoutMs;
      throw new Error('native timeout');
    }
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([{ id: 10 }], { page: 1, page_count: 1 });
    }
    return apiResponse([{ id: 91, title_en: 'Fallback after config timeout', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, Date: FakeDate });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:91');
  assert.deepEqual(events.filter(event => DOMAIN_CONFIG_URLS.has(event.url)).map(event => event.options.timeoutMs), [3000, 3000]);
  assert.equal(plugin.__test.selectedApiDomain(), 'https://ostv-11-11.xyz');
  assert.equal(now - 10_000, 6000);
});

test('an exhausted discovery budget starts no additional probe', async () => {
  let now = 50_000;
  const FakeDate = { now: () => now, parse: Date.parse };
  const events = [];
  const config = JSON.stringify({ default_domain: 'https://primary.example.net/', backup_domains: [] });
  const plugin = loadPlugin(async (url, options) => {
    events.push({ url, options });
    if (DOMAIN_CONFIG_URLS.has(url)) {
      now += 20_000;
      return httpResponse({ status: 200, url, contentType: 'application/json', body: config });
    }
    return apiResponse([{ id: 92, title_en: 'Budget fallback', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, Date: FakeDate });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:92');
  assert.equal(events.filter(event => new URL(event.url).searchParams.get('sort_by') === 'views_today').length, 0);
  assert.equal(plugin.__test.selectedApiDomain(), 'https://ostv-11-11.xyz');
});

test('older hosts without native timeout support skip speculative discovery and keep the fallback API', async () => {
  const events = [];
  const plugin = loadPlugin(async (url, options) => {
    events.push({ url, options });
    return apiResponse([{ id: 93, title_en: 'Compatible fallback', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, nativeTimeoutSupport: false });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:93');
  assert.equal(events.length, 1);
  assert.equal(new URL(events[0].url).hostname, 'ostv-11-11.xyz');
  assert.equal(events[0].options.timeoutMs, undefined);
});

test('unhealthy primary and invalid probe schema fail over to the first valid backup', async () => {
  const events = [];
  const config = JSON.stringify({ default_domain: 'https://primary.example.net/', backup_domains: ['https://backup.example.net/'] });
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    if (DOMAIN_CONFIG_URLS.has(url)) return httpResponse({ status: 200, url, contentType: 'application/json', body: config });
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      if (parsed.hostname === 'primary.example.net') return apiResponse({ wrong: 'shape' });
      return apiResponse([{ id: 2 }], { page: 1, page_count: 1 });
    }
    return apiResponse([{ id: 43, title_en: 'Backup movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, onFetch: (url, options) => events.push({ url, options }) });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:43');
  assert.deepEqual(events.map(event => new URL(event.url).hostname), [
    'raw.githubusercontent.com', 'primary.example.net', 'backup.example.net', 'backup.example.net'
  ]);
  assert.equal(plugin.__test.selectedApiDomain(), 'https://backup.example.net');
});

test('unavailable primary config source uses jsDelivr mirror and caches the selected domain for the runtime', async () => {
  const events = [];
  const config = JSON.stringify({ default_domain: 'https://mirror-selected.example.net/', backup_domains: [] });
  let apiCalls = 0;
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    if (url === 'https://raw.githubusercontent.com/MBoshkash/ostv-config/main/domains.json') {
      return httpResponse({ status: 503, url, contentType: 'text/plain', body: 'unavailable' });
    }
    if (url === 'https://cdn.jsdelivr.net/gh/MBoshkash/ostv-config@main/domains.json') {
      return httpResponse({ status: 200, url, contentType: 'text/plain', body: config });
    }
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([{ id: 3 }], { page: 1, page_count: 1 });
    }
    apiCalls++;
    return apiResponse([{ id: 44 + apiCalls, title_en: 'Cached config movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, onFetch: (url, options) => events.push({ url, options }) });

  await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.deepEqual(events.map(event => new URL(event.url).hostname), [
    'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'mirror-selected.example.net',
    'mirror-selected.example.net', 'mirror-selected.example.net'
  ]);
  assert.equal(events.filter(event => new URL(event.url).hostname === 'cdn.jsdelivr.net').length, 1);
  assert.equal(events.filter(event => new URL(event.url).searchParams.get('sort_by') === 'views_today').length, 1);
  assert.equal(apiCalls, 2);
});

test('both remote config sources unavailable falls back to the known working .xyz API', async () => {
  const events = [];
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    if (DOMAIN_CONFIG_URLS.has(url)) return httpResponse({ status: 503, url, contentType: 'text/plain', body: 'unavailable' });
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([{ id: 4 }], { page: 1, page_count: 1 });
    }
    return apiResponse([{ id: 45, title_en: 'Fallback movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, onFetch: (url, options) => events.push({ url, options }) });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:45');
  assert.deepEqual(events.map(event => new URL(event.url).hostname), [
    'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'ostv-11-11.xyz', 'ostv-11-11.xyz'
  ]);
  assert.equal(plugin.__test.selectedApiDomain(), 'https://ostv-11-11.xyz');
});

test('malformed remote config and redirected API probes cannot redirect signed headers off-host', async () => {
  const events = [];
  const plugin = loadPlugin(async (url, options) => {
    const parsed = new URL(url);
    if (DOMAIN_CONFIG_URLS.has(url)) {
      return httpResponse({ status: 200, url, contentType: 'application/json', body: '{malformed' });
    }
    if (parsed.hostname === 'ostv-11-11.xyz' && parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return httpResponse({ status: 302, url, contentType: 'text/plain', body: '', headers: { location: 'https://untrusted.example/api/movies/' } });
    }
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([{ id: 5 }], { page: 1, page_count: 1 });
    }
    return apiResponse([{ id: 46, title_en: 'Safe fallback', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { mockBootstrapAndProbe: false, onFetch: (url, options) => events.push({ url, options }) });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(result.items[0].nativeId, 'movie:46');
  assert.equal(events.filter(event => new URL(event.url).hostname === 'raw.githubusercontent.com').length, 1);
  assert.equal(events.filter(event => new URL(event.url).hostname === 'cdn.jsdelivr.net').length, 1);
  assert.equal(events.some(event => new URL(event.url).hostname === 'untrusted.example'), false);
  const signed = events.filter(event => event.options.headers['X-Iron-Sig']);
  assert.equal(signed.length, 2);
  assert.ok(signed.every(event => event.options.redirect === 'manual'));
  assert.ok(signed.every(event => !new URL(event.url).hostname.includes('untrusted')));
  assert.equal(plugin.__test.selectedApiDomain(), 'https://ostv-11-11.xyz');
});

test('API requests are signed locally and sent directly to the provider host', async () => {
  const events = [];
  const plugin = loadPlugin(async () => {
    return apiResponse([{ id: 4444, title_en: 'Reference movie', poster: '/poster.jpg' }], { page: 1, page_count: 1 });
  }, { onFetch: (url, options) => events.push({ stage: 'fetch', url, options }) });

  const result = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 20 });
  assert.equal(result.items[0].nativeId, 'movie:4444');
  assert.equal(events.length, 1);
  const requestedApiUrl = 'https://ostv-11-11.xyz/api/movies/?page=1&limit=20';
  assert.equal(events[0].url, requestedApiUrl);
  assert.equal(events[0].options.method, 'GET');
  assert.equal(events[0].options.redirect, 'manual', 'API signatures must not follow redirects to other hosts');
  assert.match(events[0].options.headers['X-Iron-Sig'], /^[a-f0-9]{64}$/);
  assert.match(events[0].options.headers['X-Iron-Ts'], /^\d+$/);
  assert.match(events[0].options.headers['X-Iron-Nonce'], /^[a-f0-9]{8}$/);
  assert.equal(events[0].options.headers.Accept, 'application/json');
  assert.equal(events[0].options.headers['User-Agent'], 'okhttp/4.12.0');
  assert.deepEqual(events[0].stage, 'fetch');
});

test('API signing never contacts or forwards request data to the former external helper', async () => {
  const events = [];
  const plugin = loadPlugin(async () => apiResponse([]), { onFetch: (url, options) => events.push({ url, options }) });

  await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 1 });
  assert.equal(events.length, 1);
  assert.equal(new URL(events[0].url).hostname, 'ostv-11-11.xyz');
  assert.equal(events[0].options.headers.Authorization, undefined);
  assert.equal(events[0].options.headers.Cookie, undefined);
  assert.equal(events[0].options.headers['Proxy-Authorization'], undefined);
  assert.equal(events[0].options.headers['X-Provider-Token'], undefined);
});

test('provider request signature covers the raw path and excludes query values', async () => {
  const plugin = loadPlugin(async () => apiResponse([]));
  const headers = plugin.__test.apiHeaders('https://ostv-11-11.xyz/api/movies/?search=private%20query');
  const expected = plugin.__test.sign('/api/movies/', headers['X-Iron-Ts'], headers['X-Iron-Nonce']);
  assert.equal(headers['X-Iron-Sig'], expected);
  assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'User-Agent', 'X-Iron-Nonce', 'X-Iron-Sig', 'X-Iron-Ts'].sort());
});

test('Oscar API HTTP and JSON failures remain distinguishable', async () => {
  const deniedPlugin = loadPlugin(async (url) => ({
    ok: false, status: 403, json: async () => ({ status: 'error' })
  }));
  await assert.rejects(deniedPlugin.getCatalog({ catalogId: 'movies', type: 'movie' }), /HTTP 403/);

  const invalidJsonPlugin = loadPlugin(async () => ({
    ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); }
  }));
  await assert.rejects(invalidJsonPlugin.getCatalog({ catalogId: 'movies', type: 'movie' }), /invalid JSON/);

  const redirectPlugin = loadPlugin(async (url, options) => {
    assert.equal(options.redirect, 'manual');
    return { ok: false, status: 302, json: async () => ({}) };
  });
  await assert.rejects(redirectPlugin.getCatalog({ catalogId: 'movies', type: 'movie' }), /HTTP 302/);
});

test('getHome loads the 11 ordered paginated catalog rows and returns only poster-ready items', async () => {
  const requests = [];
  const plugin = loadPlugin(async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    const ordinal = requests.length;
    const type = parsed.pathname.includes('/anime/') ? 'anime' : parsed.pathname.includes('/series/') ? 'series' : 'movie';
    await new Promise(resolve => setTimeout(resolve, ordinal));
    return apiResponse(Array.from({ length: 4 }, (_, index) => ({
      id: ordinal * 100 + index + 1,
      title_en: `${type} ${ordinal}-${index}`,
      poster: index === 3 ? null : `/poster-${ordinal}-${index}.jpg`,
      banner: `/backdrop-${ordinal}-${index}.jpg`,
      logo: `/logo-${ordinal}-${index}.png`
    })), { page: 1, page_count: 4, total: 80, per_page: 18 });
  });
  const home = JSON.parse(JSON.stringify(await plugin.getHome()));
  const ids = ['movies_top', 'foreign_movies', 'foreign_series', 'foreign_latest', 'foreign_airing', 'asian_series', 'asian_latest', 'asian_airing', 'anime_picks', 'anime', 'anime_movies'];
  const titles = ['رائج اليوم', 'أفلام أجنبية', 'مسلسلات أجنبية', 'أحدث الأجنبي', 'يعرض الآن', 'مسلسلات آسيوية', 'أحدث الآسيوي', 'يعرض الآن آسيوي', 'اخترنا لك', 'أحدث الأنمي', 'أفلام أنمي'];
  assert.equal(requests.length, 11);
  assert.deepEqual(home.sections.map(section => section.id), ids);
  assert.deepEqual(home.sections.map(section => section.title), titles);
  assert.equal(home.sections.every(section => section.items.length === 3), true);
  assert.equal(home.sections.every(section => section.items.every(item => /^https:\/\//.test(item.poster))), true);
  assert.equal(home.sections.every(section => section.hasMore === true && section.nextPage === '2'), true);
  assert.equal(home.sections.some(section => /العربية|مختارة/.test(section.title)), false);
  assert.equal(home.sections.some(section => ['movies_spotlight', 'series_spotlight'].includes(section.id)), false);
  assert.equal(home.sections[0].items[0].nativeId, 'movie:101');
  assert.equal(home.sections[2].items[0].nativeId, 'series:301');
  assert.equal(home.sections[8].items[0].nativeId, 'anime:901');
  assert.equal(home.sections[0].items[0].pluginId, undefined);
  assert.deepEqual(requests.map(url => url.pathname), ['/api/movies/', '/api/movies/', '/api/series/', '/api/series/', '/api/series/', '/api/series/', '/api/series/', '/api/series/', '/api/anime/', '/api/anime/', '/api/anime/']);
  assert.deepEqual(requests.map(url => Object.fromEntries(url.searchParams.entries())), [
    { sort_by: 'views_today', page: '1', limit: '18' },
    { category: '18', sort_by: 'newest', page: '1', limit: '18' },
    { category: '4', sort_by: 'most_viewed', page: '1', limit: '18' },
    { category: '4', sort_by: 'newest', page: '1', limit: '18' },
    { category: '4', status: 'ongoing', sort_by: 'latest_episode', page: '1', limit: '18' },
    { category: '5', sort_by: 'most_viewed', page: '1', limit: '18' },
    { category: '5', sort_by: 'newest', page: '1', limit: '18' },
    { category: '5', status: 'ongoing', sort_by: 'latest_episode', page: '1', limit: '18' },
    { sort_by: 'rating', page: '1', limit: '18' },
    { sort_by: 'newest', page: '1', limit: '18' },
    { anime_type: 'movie', sort_by: 'newest', page: '1', limit: '18' }
  ]);
});

test('getHome suppresses empty rows and rows where most catalog items have no portrait poster', async () => {
  const plugin = loadPlugin(async url => {
    const parsed = new URL(url);
    const category = parsed.searchParams.get('category');
    if (parsed.pathname === '/api/movies/' && parsed.searchParams.get('sort_by') === 'views_today') {
      return apiResponse([], { page: 1, page_count: 1, total: 0, per_page: 18 });
    }
    const items = category === '18'
      ? [{ id: 1, title_en: 'one', poster: '/one.jpg' }, { id: 2, title_en: 'two' }, { id: 3, title_en: 'three' }, { id: 4, title_en: 'four' }]
      : [{ id: Number(category || 4) + 10, title_en: 'poster', poster: '/poster.jpg' }];
    return apiResponse(items, { page: 1, page_count: 2, total: 20, per_page: 18 });
  });
  const home = JSON.parse(JSON.stringify(await plugin.getHome()));
  assert.equal(home.sections.some(section => section.id === 'movies_top'), false);
  assert.equal(home.sections.some(section => section.id === 'foreign_movies'), false);
  assert.equal(home.sections.length, 9);
  assert.equal(home.sections.every(section => section.items.length > 0 && section.items.every(item => item.poster)), true);
});

test('getHome bounds request concurrency, preserves catalog order, and isolates partial failures', async () => {
  let active = 0;
  let peak = 0;
  const plugin = loadPlugin(async (url) => {
    const parsed = new URL(url);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    if (parsed.searchParams.get('category') === '4' && parsed.searchParams.get('sort_by') === 'newest') {
      throw new Error('one catalog is unavailable');
    }
    return apiResponse([{ id: Number(parsed.searchParams.get('page') || 1) + 100, title_en: 'Ready', poster: '/poster.jpg' }],
      { page: 1, page_count: 1, total: 1, per_page: 18 });
  });
  const home = JSON.parse(JSON.stringify(await plugin.getHome()));
  assert.ok(peak <= 3, `peak concurrent API requests was ${peak}`);
  assert.equal(home.sections.length, 10);
  assert.equal(home.sections.some(section => section.id === 'foreign_latest'), false);
  assert.deepEqual(home.sections.map(section => section.id), [
    'movies_top', 'foreign_movies', 'foreign_series', 'foreign_airing', 'asian_series', 'asian_latest',
    'asian_airing', 'anime_picks', 'anime', 'anime_movies'
  ]);
});

test('manifest exposes only the requested ordered Home catalogs with paginated browse targets', () => {
  assert.equal(manifest.version, '2.0.16');
  assert.ok(manifest.capabilities.includes('home'));
  assert.ok(manifest.capabilities.includes('search'));
  assert.deepEqual(manifest.searchGroups.map(group => group.id), ['movies', 'series', 'anime']);
  const expected = [
    ['movies_top', 'رائج اليوم'], ['foreign_movies', 'أفلام أجنبية'], ['foreign_series', 'مسلسلات أجنبية'],
    ['foreign_latest', 'أحدث الأجنبي'], ['foreign_airing', 'يعرض الآن'], ['asian_series', 'مسلسلات آسيوية'],
    ['asian_latest', 'أحدث الآسيوي'], ['asian_airing', 'يعرض الآن آسيوي'], ['anime_picks', 'اخترنا لك'],
    ['anime', 'أحدث الأنمي'], ['anime_movies', 'أفلام أنمي']
  ];
  const rows = Object.fromEntries(manifest.catalogs.map(row => [row.id, row]));
  const homeRows = manifest.catalogs.filter(row => row.capabilities.includes('home'));
  assert.deepEqual(homeRows.map(row => [row.id, row.title]), expected);
  assert.equal(homeRows.every(row => row.capabilities.includes('browse') && row.capabilities.includes('pagination')), true);
  assert.equal(homeRows.every(row => row.presentation?.posterShape === 'portrait'), true);
  assert.equal(homeRows.every(row => row.homeFallback), true);
  assert.deepEqual(homeRows.map(row => row.homeOrder), [...homeRows.map(row => row.homeOrder)].sort((a, b) => a - b));
  assert.equal(manifest.catalogs.some(row => /العربية|مختارة/.test(row.title)), false);
  assert.equal(rows.movies.capabilities.includes('home'), false);
  assert.equal(rows.series.capabilities.includes('home'), false);
  assert.equal(rows.movies.capabilities.includes('browse'), true);
  assert.equal(rows.series.capabilities.includes('browse'), true);
});

test('manifest declares category and genre Discover roles while preserving anime movie identity', () => {
  const rows = Object.fromEntries(manifest.catalogs.map(row => [row.id, row]));
  assert.equal(rows.movies.discoverType, 'movie');
  assert.equal(rows.series.discoverType, 'series');
  assert.equal(rows.movies.filters.find(filter => filter.key === 'category').label, 'فئة الفيلم');
  assert.equal(rows.series.filters.find(filter => filter.key === 'category').label, 'فئة المسلسل');
  assert.equal(rows.anime_movies.type, 'anime');
  assert.equal(rows.anime_movies.discoverType, 'movie');
  assert.deepEqual(rows.anime_movies.discoverCategory, { id: 'anime', label: 'الأنمي' });
  assert.equal(rows.anime_series.type, 'anime');
  assert.equal(rows.anime_series.discoverType, 'series');
  assert.deepEqual(rows.anime_series.discoverCategory, { id: 'anime', label: 'الأنمي' });
  assert.deepEqual(rows.movies.filters.map(filter => filter.key), [
    'category', 'genre_id', 'year', 'country', 'language', 'quality_source', 'content_type',
    'age_rating', 'status', 'awards', 'sort_by'
  ]);
  assert.equal(rows.movies.filters.every(filter => filter.dynamic && filter.options.length === 0), true);
  assert.deepEqual(rows.series.filters.slice(1).map(filter => filter.dependsOn),
    rows.series.filters.slice(1).map(() => ['category']));
  assert.equal(rows.anime_movies.filters.some(filter => filter.key === 'anime_type'), false);

  for (const catalogId of ['movies', 'series']) {
    assert.equal(rows[catalogId].filters.find(filter => filter.key === 'category').discoverPresentation.role, 'category');
    assert.equal(rows[catalogId].filters.find(filter => filter.key === 'category').discoverPresentation.hidden, true);
    assert.equal(rows[catalogId].filters.find(filter => filter.key === 'genre_id').discoverPresentation.role, 'genre');
  }
  for (const catalogId of ['anime_movies', 'anime_series']) {
    assert.equal(rows[catalogId].filters.find(filter => filter.key === 'genre_id').discoverPresentation.role, 'genre');
    assert.equal(rows[catalogId].filters.find(filter => filter.key === 'studio_id').discoverPresentation.hidden, true);
  }
  for (const catalogId of ['movies', 'series', 'anime_movies', 'anime_series']) {
    const filters = rows[catalogId].filters;
    const extras = filters.filter(filter =>
      !['category', 'genre_id'].includes(filter.key) && !filter.discoverPresentation?.hidden);
    assert.deepEqual(extras, [], `${catalogId} exposes only category/genre in Discover`);
  }
});

test('dynamic filter lookup preserves API values and scopes series dependencies to category', async () => {
  const requests = [];
  const plugin = loadPlugin(async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname === '/api/series/filters.php') {
      return apiResponse({
        categories: [{ id: 4, name: 'أجنبي' }, { id: 5, name: 'آسيوي' }],
        genres: [{ id: 17, name: 'دراما' }], years: [2026], countries: [{ code: 'kr', name: 'كوريا' }],
        languages: ['ko'], statuses: [{ code: 'ongoing', name: 'مستمر' }],
        content_types: [{ code: 'series', name: 'مسلسل' }], age_ratings: [{ code: 'pg13', name: '+13' }]
      });
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  });
  const result = await plugin.getCatalogFilters({
    catalogId: 'series', contentType: 'series', selectedFilters: { category: '5', genre_id: 'old' }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('category'), '5');
  assert.equal(result.filters[0].label, 'فئة المسلسل');
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters[0].options)), [
    { value: '4', label: 'أجنبي' }, { value: '5', label: 'آسيوي' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters[1].options)), [{ value: '17', label: 'دراما' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters[1].dependsOn)), ['category']);
});

test('known series category slugs receive Arabic display labels while API values stay unchanged', async () => {
  const plugin = loadPlugin(async url => {
    const parsed = new URL(url);
    if (!['/api/series/filters.php', '/api/movies/filters.php'].includes(parsed.pathname)) {
      throw new Error(`unexpected request ${parsed.pathname}`);
    }
    return apiResponse({
      categories: [
        { id: 4, name: 'foreign_series' },
        { id: 5, name: 'turkish_series' },
        { id: 6, slug: 'asian_series', title_ar: 'المسلسلات الآسيوية' },
        { id: 7, name: 'talk_show' },
        { value: 'arabic', label: 'arabic' },
        { slug: 'reality_tv', id: 9 }
      ],
      languages: ['arabic']
    });
  });

  const result = await plugin.getCatalogFilters({ catalogId: 'series', contentType: 'series', selectedFilters: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters[0].options)), [
    { value: '4', label: 'المسلسلات الأجنبية' },
    { value: '5', label: 'المسلسلات التركية' },
    { value: '6', label: 'المسلسلات الآسيوية' },
    { value: '7', label: 'البرامج الحوارية' },
    { value: 'arabic', label: 'مسلسلات عربية' },
    { value: '9', label: 'Reality Tv' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters.find(filter => filter.key === 'language').options)), [
    { value: 'arabic', label: 'Arabic' }
  ]);
  const movieFilters = await plugin.getCatalogFilters({ catalogId: 'movies', contentType: 'movie', selectedFilters: {} });
  assert.equal(movieFilters.filters[0].label, 'فئة الفيلم');
});

test('anime movie and series filters share native anime metadata without exposing anime_type as a user filter', async () => {
  const plugin = loadPlugin(async url => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/api/anime/filters.php') throw new Error(`unexpected request ${parsed.pathname}`);
    return apiResponse({
      genres: [{ id: 2, name: 'مغامرات' }], studios: [{ id: 8, name: 'Studio' }], statuses: ['finished'],
      season_periods: ['winter'], season_years: [2025], years: [2024],
      content_types: [{ code: 'anime', name: 'أنمي' }], age_ratings: ['pg']
    });
  });
  const result = await plugin.getCatalogFilters({ catalogId: 'anime_movies', contentType: 'anime', selectedFilters: {} });
  assert.equal(result.filters.some(filter => filter.key === 'anime_type'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters[0].options)), [{ value: '2', label: 'مغامرات' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.filters.find(filter => filter.key === 'studio_id').options)), [
    { value: '8', label: 'Studio' }
  ]);
  await assert.rejects(plugin.getCatalogFilters({ catalogId: 'anime_movies', contentType: 'series' }), /type mismatch/);

  const seriesFilters = await plugin.getCatalogFilters({ catalogId: 'anime_series', contentType: 'anime', selectedFilters: {} });
  assert.equal(seriesFilters.filters.some(filter => filter.key === 'anime_type'), false);
  await assert.rejects(plugin.getCatalogFilters({ catalogId: 'anime_series', contentType: 'series' }), /type mismatch/);
});

test('anime series catalog uses the original OscarTV episode-list type values and preserves anime identity', async () => {
  const requests = [];
  const plugin = loadPlugin(async url => {
    requests.push(new URL(url));
    return apiResponse([{ id: 88, title_en: 'Series Anime', poster: '/series-anime.jpg' }],
      { page: 1, page_count: 2, total: 19, per_page: 18 });
  });
  const page = await plugin.getCatalog({ catalogId: 'anime_series', type: 'anime', limit: 18, filters: {} });
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.fromEntries(requests[0].searchParams.entries()), {
    anime_type: 'tv,ova,ona,special', sort_by: 'newest', page: '1', limit: '18'
  });
  assert.equal(page.items[0].nativeId, 'anime:88');
  assert.equal(page.items[0].type, 'anime');
});

test('catalog descriptors map movies, series, and anime to one native-ID-preserving page each', async () => {
  const requests = [];
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url: new URL(url), options });
    const type = requests.at(-1).url.pathname.includes('/series/') ? 'series' : requests.at(-1).url.pathname.includes('/anime/') ? 'anime' : 'movie';
    return apiResponse([{ id: 17, title_en: `${type} title`, poster: '/poster.jpg', rating: '8.2' }], { page: 1, page_count: 3, total: 45, per_page: 20 });
  });
  for (const [catalogId, type] of [['movies', 'movie'], ['series', 'series'], ['anime', 'anime']]) {
    const page = await plugin.getCatalog({ catalogId, type, limit: 20, filters: {} });
    assert.equal(page.catalogId, catalogId);
    assert.equal(page.items[0].nativeId, `${type}:17`);
    assert.equal(page.items[0].type, type);
    assert.equal(page.page.nextCursor, '2');
    assert.equal(page.page.hasMore, true);
    assert.equal(page.page.total, 45);
  }
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(({ url }) => url.pathname), ['/api/movies/', '/api/series/', '/api/anime/']);
  assert.ok(requests.every(({ options }) => /^[a-f0-9]{64}$/.test(options.headers['X-Iron-Sig']) &&
    /^\d+$/.test(options.headers['X-Iron-Ts']) && /^[a-f0-9]{8}$/.test(options.headers['X-Iron-Nonce'])));
});

test('external TMDB and IMDb IDs are validated and mapped without changing native identity', () => {
  const h = loadPlugin(async () => { throw new Error('external ID mapping must not make a request'); }).__test;
  const valid = h.mapMedia({ id: 31, title_en: 'With IDs', tmdb_id: 307106, imdb_id: ' tt1234567 ' }, 'series');
  assert.equal(valid.externalIds.tmdb, '307106');
  assert.equal(valid.externalIds.imdb, 'tt1234567');
  assert.equal(valid.nativeId, 'series:31');

  const stringId = h.mapMedia({ id: 32, tmdb_id: '42' }, 'movie');
  assert.equal(stringId.externalIds.tmdb, '42');
  assert.equal(stringId.nativeId, 'movie:32');

  for (const value of [null, '', '  ', 0, '0', -1, '-1', 'garbage', 1.5, '1.5', true, '1e2']) {
    assert.equal(h.externalIdsOf({ tmdb_id: value }), undefined, `invalid TMDB id ${String(value)}`);
  }
  assert.equal(h.externalIdsOf({ imdb_id: '' }), undefined);
  assert.equal(h.externalIdsOf({ imdb_id: 'not-an-imdb-id' }), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(h.externalIdsOf({ imdb_id: ' tt7654321 ' }))), { imdb: 'tt7654321' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.externalIdsOf({ tmdb_id: 9, imdb_id: 'tt1234567' }))), { tmdb: '9', imdb: 'tt1234567' });
  assert.equal(h.mapMedia({ id: 33 }, 'anime').externalIds, undefined);
});

test('details retain validated external IDs when Oscar details supplies them', () => {
  const h = loadPlugin(async () => { throw new Error('details mapping must not make a request'); }).__test;
  const details = h.detailsItem({ id: 55, title_en: 'Movie', tmdb_id: '1284046', imdb_id: 'tt32268691' }, 'movie', 55);
  assert.equal(details.nativeId, 'movie:55');
  assert.deepEqual(JSON.parse(JSON.stringify(details.externalIds)), { tmdb: '1284046', imdb: 'tt32268691' });
  const ignored = h.detailsItem({ id: 56, tmdb_id: 'garbage', imdb_id: '' }, 'movie', 56);
  assert.equal(ignored.externalIds, undefined);
});

test('anime original title prefers Japanese and falls back to English without changing display identity', () => {
  const h = loadPlugin(async () => { throw new Error('title mapping must not make a request'); }).__test;
  const anime = h.mapMedia({
    id: 519,
    title_ar: 'Mushoku Tensei: Isekai Ittara Honki Dasu',
    title_en: 'Mushoku Tensei: Isekai Ittara Honki Dasu',
    title_jp: '\u7121\u8077\u8EE2\u751F \uFF5E\u7570\u4E16\u754C\u884C\u3063\u305F\u3089\u672C\u6C17\u3060\u3059\uFF5E'
  }, 'anime');
  assert.equal(anime.originalTitle, '無職転生 ～異世界行ったら本気だす～');
  assert.equal(anime.title, 'Mushoku Tensei: Isekai Ittara Honki Dasu');
  assert.equal(anime.nativeId, 'anime:519');

  const animeWithoutJapanese = h.mapMedia({ id: 520, title_ar: 'عرض عربي', title_en: 'English title' }, 'anime');
  assert.equal(animeWithoutJapanese.originalTitle, 'English title');
  assert.equal(animeWithoutJapanese.title, 'عرض عربي');
  assert.equal(animeWithoutJapanese.nativeId, 'anime:520');
});

test('movie and series original title mapping remains English-first', () => {
  const h = loadPlugin(async () => { throw new Error('title mapping must not make a request'); }).__test;
  for (const type of ['movie', 'series']) {
    const item = h.mapMedia({ id: 64, title_ar: 'اسم العرض', title_en: 'English title', title_jp: 'Original title' }, type);
    assert.equal(item.originalTitle, 'English title');
    assert.equal(item.title, 'اسم العرض');
    assert.equal(item.nativeId, `${type}:64`);
  }
});

test('anime details return Japanese original title while preserving visible title and Oscar identity', async () => {
  const requests = [];
  const plugin = loadPlugin(async (url) => {
    requests.push(new URL(url));
    return apiResponse({
      id: 519,
      title_ar: 'Mushoku Tensei: Isekai Ittara Honki Dasu',
      title_en: 'Mushoku Tensei: Isekai Ittara Honki Dasu',
      title_jp: '\u7121\u8077\u8EE2\u751F \uFF5E\u7570\u4E16\u754C\u884C\u3063\u305F\u3089\u672C\u6C17\u3060\u3059\uFF5E',
      release_year: 2021,
      seasons: []
    });
  });
  const result = await plugin.getDetails({ id: 'anime:519' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/anime/show.php');
  assert.equal(requests[0].searchParams.get('id'), '519');
  assert.equal(result.item.originalTitle, '無職転生 ～異世界行ったら本気だす～');
  assert.equal(result.item.title, 'Mushoku Tensei: Isekai Ittara Honki Dasu');
  assert.equal(result.item.nativeId, 'anime:519');
  assert.equal(result.item.type, 'anime');
  assert.equal(result.item.year, 2021);
});

test('anime details advertise parent streams only when a supported parent WatchLink exists', async () => {
  const responses = [
    { id: 150, title_en: 'One Piece Fan Letter', seasons: [], watch_links: [
      { url: 'https://cdn.mediaoscar.com/fan-letter/master.m3u8', quality: '1080p' }
    ] },
    { id: 151, title_en: 'Episode-only anime', seasons: [], watch_links: [] },
    { id: 152, title_en: 'Malformed special', seasons: [], watch_links: [{ url: 'not-a-url' }] },
    { id: 153, title_en: 'TDM-linked special', seasons: [], watch_links: [
      { deep_link: 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Fspecial%2Fmaster.m3u8', type: 'direct' }
    ] }
  ];
  const plugin = loadPlugin(async () => apiResponse(responses.shift()));

  const playable = await plugin.getDetails({ id: 'anime:150' });
  const episodeOnly = await plugin.getDetails({ id: 'anime:151' });
  const malformed = await plugin.getDetails({ id: 'anime:152' });
  const deepLinkOnly = await plugin.getDetails({ id: 'anime:153' });

  assert.equal(playable.item.hasParentStreams, true);
  assert.equal(playable.episodes.length, 0);
  assert.equal(episodeOnly.item.hasParentStreams, false);
  assert.equal(malformed.item.hasParentStreams, false);
  assert.equal(deepLinkOnly.item.hasParentStreams, true);
});

test('series detail loading caps concurrent page fetches while preserving all episode IDs and order', async () => {
  let active = 0;
  let peak = 0;
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    if (url.pathname === '/api/series/show.php') {
      return apiResponse({ id: 800, title_en: 'Many seasons' });
    }
    if (url.pathname === '/api/seasons/') {
      return apiResponse(Array.from({ length: 4 }, (_, index) => ({ id: index + 10, season_number: index + 1 })));
    }
    if (url.pathname === '/api/episodes/') {
      const seasonId = Number(url.searchParams.get('season_id'));
      const page = Number(url.searchParams.get('page'));
      return apiResponse([{ id: seasonId * 100 + page, episode_number: page }], { page, page_count: 3 });
    }
    throw new Error(`unexpected URL ${rawUrl}`);
  });

  const result = await plugin.getDetails({ id: 'series:800' });
  assert.ok(peak <= 4, `peak concurrent detail requests was ${peak}`);
  assert.deepEqual(Array.from(result.episodes, item => item.nativeId), [
    'series_episode:1001', 'series_episode:1002', 'series_episode:1003',
    'series_episode:1101', 'series_episode:1102', 'series_episode:1103',
    'series_episode:1201', 'series_episode:1202', 'series_episode:1203',
    'series_episode:1301', 'series_episode:1302', 'series_episode:1303'
  ]);
});

test('episode page 403 is not retried by the details layer', async () => {
  let episodePageRequests = 0;
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/series/show.php') return apiResponse({ id: 801, title_en: 'Denied season' });
    if (url.pathname === '/api/seasons/') return apiResponse([{ id: 81, season_number: 1 }]);
    if (url.pathname === '/api/episodes/') {
      episodePageRequests += 1;
      return httpResponse({ status: 403, url: rawUrl, contentType: 'application/json' });
    }
    throw new Error(`unexpected URL ${rawUrl}`);
  });

  const result = await plugin.getDetails({ id: 'series:801' });
  assert.equal(result.episodes.length, 0);
  assert.equal(episodePageRequests, 1);
});

test('Oscar genres normalize live object, text-array, and delimited-string shapes without object leakage', () => {
  const h = loadPlugin(async () => { throw new Error('genre normalization must not make a request'); }).__test;
  const liveMovie = h.mapMedia({ id: 4433, genres: [
    { id: 1, name: 'دراما', slug: 'drama' },
    { id: 5, name: 'رعب', slug: 'horror' }
  ] }, 'movie');
  assert.deepEqual(JSON.parse(JSON.stringify(liveMovie.genres)), ['دراما', 'رعب']);

  const textArray = h.mapMedia({ id: 4431, genres: ['تشويق وإثارة', 'دراما'] }, 'movie');
  assert.deepEqual(JSON.parse(JSON.stringify(textArray.genres)), ['تشويق وإثارة', 'دراما']);
  const seriesDetails = h.detailsItem({ id: 1662, genres: [
    { id: 7, name: 'غموض', slug: 'mystery' }, { id: 53, name: 'كوميديا', slug: 'genre_1775469420' }
  ] }, 'series', 1662);
  assert.deepEqual(JSON.parse(JSON.stringify(seriesDetails.genres)), ['غموض', 'كوميديا']);
  const delimited = h.detailsItem({ id: 573, genres: 'Time Travel,أكشن،خيال|مدرسي' }, 'anime', 573);
  assert.deepEqual(JSON.parse(JSON.stringify(delimited.genres)), ['Time Travel', 'أكشن', 'خيال', 'مدرسي']);

  for (const malformed of [null, 7, {}, [{ id: 8 }], ['  ', null, 9, { name: {} }], '[object Object]']) {
    const item = h.mapMedia({ id: 10, genres: malformed }, 'series');
    assert.ok(item.genres.every(value => typeof value === 'string' && value.trim()));
    assert.ok(item.genres.every(value => value !== '[object Object]'));
  }
});

test('movie, series, and anime catalogs keep Oscar genres as strings for home and search results', async () => {
  const plugin = loadPlugin(async (url) => {
    const type = new URL(url).pathname.includes('/series/') ? 'series' : new URL(url).pathname.includes('/anime/') ? 'anime' : 'movie';
    const genres = type === 'movie'
      ? [{ id: 1, name: 'دراما', slug: 'drama' }]
      : type === 'series' ? ['غموض', 'دراما'] : 'Time Travel,أكشن';
    return apiResponse([{ id: type === 'movie' ? 4433 : 17, title_ar: 'عنوان', genres }]);
  });
  for (const [catalogId, type] of [['movies', 'movie'], ['series', 'series'], ['anime', 'anime']]) {
    for (const query of [undefined, 'عنوان']) {
      const page = await plugin.getCatalog({ catalogId, type, query, filters: {} });
      assert.ok(page.items[0].genres.every(value => typeof value === 'string'));
      assert.ok(page.items[0].genres.every(value => value !== '[object Object]'));
    }
  }
});

test('opaque pagination cursor and query are forwarded to one catalog request', async () => {
  let observed;
  const plugin = loadPlugin(async (url) => {
    observed = new URL(url);
    return apiResponse([{ id: 99, title_ar: 'بحث' }], { page: 2, page_count: 2, total: 21, per_page: 20 });
  });
  const page = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', cursor: '2', limit: 20, query: '  بحث & drama  ', filters: {} });
  assert.equal(observed.pathname, '/api/movies/');
  assert.equal(observed.searchParams.get('page'), '2');
  assert.equal(observed.searchParams.get('search'), '  بحث & drama  ');
  assert.equal(page.items[0].nativeId, 'movie:99');
  assert.equal(page.page.hasMore, false);
  assert.equal(page.page.nextCursor, null);
});

test('native search sends one request for the selected group and preserves pagination', async () => {
  let observed;
  const plugin = loadPlugin(async (url) => {
    observed = new URL(url);
    return apiResponse([{ id: 42, title_ar: 'نتيجة' }], { page: 2, page_count: 3, total: 41, per_page: 20 });
  });
  const page = await plugin.search({ query: ' تنانين ', groupId: 'series', cursor: '2', limit: 20 });
  assert.equal(observed.pathname, '/api/series/');
  assert.equal(observed.searchParams.get('search'), 'تنانين');
  assert.equal(observed.searchParams.get('page'), '2');
  assert.equal(page.groupId, 'series');
  assert.equal(page.items[0].nativeId, 'series:42');
  assert.deepEqual(JSON.parse(JSON.stringify(page.page)), { nextCursor: '3', hasMore: true, total: 41 });
});

test('native search rejects unknown groups before network access', async () => {
  let requests = 0;
  const plugin = loadPlugin(async () => { requests++; return apiResponse([]); });
  await assert.rejects(plugin.search({ query: 'x', groupId: 'unknown' }), /unknown search group/);
  assert.equal(requests, 0);
});

test('invalid catalog type, cursor, and limit fail without making a request', async () => {
  let requests = 0;
  const plugin = loadPlugin(async () => { requests++; return apiResponse([]); });
  await assert.rejects(plugin.getCatalog({ catalogId: 'movies', type: 'series' }), /type mismatch/);
  await assert.rejects(plugin.getCatalog({ catalogId: 'movies', type: 'movie', cursor: '01' }), /invalid page cursor/);
  await assert.rejects(plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 101 }), /invalid page limit/);
  assert.equal(requests, 0);
});

test('missing titles and stream labels do not leak the internal plugin name', async () => {
  const plugin = loadPlugin(async () => apiResponse([{ id: 8 }], { page: 1, page_count: 1 }));
  const page = await plugin.getCatalog({ catalogId: 'movies', type: 'movie' });
  assert.match(page.items[0].title, /عنوان غير متوفر/);
  assert.doesNotMatch(page.items[0].title, /OscarTV/i);
  assert.equal(plugin.__test.serverTitle({ server_name: 'OscarTV HD' }), 'Server');
  assert.equal(plugin.__test.serverTitle({ server_name: 'Mirror 1' }), 'Mirror 1');
});

test('SeriesMP4 detection accepts the base domain and real subdomains only', () => {
  const h = loadPlugin(async () => { throw new Error('classification must not fetch'); }).__test;
  for (const url of [
    'https://seriesmp4.com/watch/1',
    'https://cdn.seriesmp4.com/file.mp4',
    'https://newcdn.seriesmp4.com/video?id=1'
  ]) assert.equal(h.isSeriesMp4(url), true, url);
  for (const url of [
    'https://fake-seriesmp4.com/watch/1',
    'https://seriesmp4.com.evil.test/watch/1',
    'https://notseriesmp4.com/watch/1'
  ]) assert.equal(h.isSeriesMp4(url), false, url);
});

test('HTML content type overrides a misleading direct declaration', () => {
  const h = loadPlugin(async () => { throw new Error('classification must not fetch'); }).__test;
  assert.equal(h.directMedia('https://newcdn.seriesmp4.com/watch/1', 'text/html; charset=UTF-8', 'direct'), false);
  assert.equal(h.directMedia('https://cdn.test/watch?id=1'), false, 'a direct declaration is not media evidence');
  assert.equal(h.directMedia('https://cdn.test/media', 'video/mp4', ''), true);
  assert.equal(h.directMedia('https://cdn.test/media', 'application/vnd.apple.mpegurl', ''), true);
});

test('wrapper parsing resolves a relative iframe and preserves media headers', async () => {
  const requests = [];
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://newcdn.seriesmp4.com/watch/1') {
      return httpResponse({ status: 200, url, contentType: 'text/html', body: '<html><iframe src="/media/video.mp4?token=ok"></iframe></html>' });
    }
    if (url === 'https://newcdn.seriesmp4.com/media/video.mp4?token=ok') {
      return httpResponse({ status: 206, url, contentType: 'video/mp4', body: 'partial' });
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const streams = await plugin.__test.resolveLink({
    url: 'https://newcdn.seriesmp4.com/watch/1', type: 'direct', deep_link: '?ua=FixtureUA', quality: '1080p'
  });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://newcdn.seriesmp4.com/media/video.mp4?token=ok');
  assert.equal(streams[0].headers['User-Agent'], 'FixtureUA');
  assert.equal(streams[0].headers.Referer, 'https://newcdn.seriesmp4.com/watch/1');
  assert.equal(streams[0].headers.Range, undefined);
  assert.equal(requests[0].options.headers.Range, undefined, 'SeriesMP4 wrapper uses one normal bounded GET');
  assert.equal(requests[1].options.headers.Referer, 'https://newcdn.seriesmp4.com/watch/1');
  assert.equal(requests[1].options.headers.Range, 'bytes=0-65535');
});

test('SeriesMP4 wrapper avoids the proven Range 416 and resolves Yandex without the rejected Referer', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/old-episode';
  const yandex = 'https://downloader.disk.yandex.ru/disk/old-episode';
  const finalUrl = 'https://downloader.disk.yandex.ru/disk/old-episode.mp4?token=signed';
  const requests = [];
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    if (url === wrapper) {
      if (options.headers.Range) return httpResponse({ status: 416, url, contentType: 'text/html', body: '<html>range rejected</html>' });
      return httpResponse({ status: 200, url, contentType: 'text/html', body: `<html><iframe src="${yandex}"></iframe></html>` });
    }
    if (url === yandex) {
      assert.equal(options.headers.Referer, undefined, 'SeriesMP4 Referer must not be inherited by Yandex');
      assert.equal(options.headers.Range, 'bytes=0-65535');
      assert.equal(options.redirect, 'follow');
      return httpResponse({ status: 206, url: finalUrl, contentType: 'video/mp4', body: 'partial' });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const streams = await plugin.__test.resolveLink({ url: wrapper, type: 'direct', deep_link: '?ua=FixtureUA' });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, finalUrl);
  assert.equal(streams[0].headers['User-Agent'], 'FixtureUA');
  assert.equal(streams[0].headers.Referer, undefined);
  assert.equal(streams[0].headers.Range, undefined);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Range, undefined);
});

test('confirmed media MIME is returned without asking JavaScript to read the media body', async () => {
  let textReads = 0;
  const plugin = loadPlugin(async (url, options) => ({
    ok: true,
    status: 206,
    url,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'video/mp4' : null },
    text: async () => { textReads++; throw new Error('media body must not be read by resolver JavaScript'); }
  }));

  const streams = await plugin.__test.resolveLink({ url: 'https://downloader.disk.yandex.ru/disk/media', type: 'direct' });

  assert.equal(streams.length, 1);
  assert.equal(textReads, 0);
  assert.equal(streams[0].headers.Range, undefined);
});

test('wrapper resolution rejects HTTP 403, 404, and 416 final responses', async () => {
  for (const status of [403, 404, 416]) {
    const plugin = loadPlugin(async (url) => {
      if (url.includes('seriesmp4.com')) {
        return httpResponse({ status: 200, url, contentType: 'text/html', body: '<iframe src="https://downloader.disk.yandex.ru/file.mp4"></iframe>' });
      }
      return httpResponse({ status, url, contentType: 'text/html', body: '<html>denied</html>' });
    });
    const streams = await plugin.__test.resolveLink({ url: 'https://newcdn.seriesmp4.com/watch/dead', type: 'direct' });
    assert.equal(streams.length, 0, `status ${status}`);
  }
});

test('HTTP 206 with a real media content type remains playable', async () => {
  const plugin = loadPlugin(async (url) => httpResponse({ status: 206, url, contentType: 'video/mp4', body: 'partial' }));
  const streams = await plugin.__test.resolveLink({ url: 'https://newcdn.seriesmp4.com/media/valid.mp4', type: 'direct' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://newcdn.seriesmp4.com/media/valid.mp4');
  assert.equal(streams[0].type, 'video');
});

test('extensionless direct declarations are probed and HTML responses are rejected', async () => {
  const url = 'https://cdn.example.test/watch?id=opaque';
  const requests = [];
  const plugin = loadPlugin(async (requestUrl, options) => {
    requests.push({ requestUrl, options });
    return httpResponse({ status: 200, url: requestUrl, contentType: 'text/html', body: '<html>login page</html>' });
  });
  const streams = await plugin.__test.resolveLink({ url, type: 'direct' });
  assert.equal(streams.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Range, 'bytes=0-65535');
});

test('HTML wrapper bodies are never returned as playable streams', async () => {
  const plugin = loadPlugin(async (url) => httpResponse({
    status: 206,
    url,
    contentType: 'text/html; charset=UTF-8',
    body: '<html><body>No playable source</body></html>'
  }));
  const streams = await plugin.__test.resolveLink({ url: 'https://newcdn.seriesmp4.com/file.mp4', type: 'direct' });
  assert.equal(streams.length, 0);
});

test('a broken wrapper does not suppress a following valid HLS source', async () => {
  const requests = [];
  const plugin = loadPlugin(async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url.toString());
    if (url.hostname === 'ostv-11-11.xyz') {
      return apiResponse({ id: 3383, watch_links: [
        { url: 'https://newcdn.seriesmp4.com/watch/dead', type: 'direct', server_name: 'Mirror 1' },
        { url: 'https://cdn.mediaoscar.com/live/valid.m3u8?token=signed', type: 'direct', server_name: 'Mirror 2' }
      ] });
    }
    return httpResponse({ status: 403, url: url.toString(), contentType: 'text/html', body: '<html>denied</html>' });
  });
  const result = await plugin.getStreams({ id: 'anime_episode:3383' });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].url, 'https://cdn.mediaoscar.com/live/valid.m3u8?token=signed');
  assert.equal(result.streams[0].type, 'm3u8');
  assert.equal(requests.filter(url => url.includes('cdn.mediaoscar.com')).length, 0, 'known direct HLS must not receive a probe request');
});

test('movie 4444 and modern anime episode 10549 keep direct signed HLS unchanged without probes', async () => {
  for (const nativeId of ['movie:4444', 'anime_episode:10549']) {
    const requests = [];
    const plugin = loadPlugin(async (rawUrl) => {
      const url = new URL(rawUrl);
      requests.push(url);
      if (url.hostname === 'ostv-11-11.xyz') {
        return apiResponse({ id: Number(nativeId.split(':')[1]), watch_links: [
          { url: 'https://cdn.mediaoscar.com/live/master.m3u8?token=signed&expires=123', type: 'direct', server_name: 'Mirror' }
        ] });
      }
      throw new Error(`direct HLS must not be probed: ${url.hostname}`);
    });

    const result = await plugin.getStreams({ id: nativeId });

    assert.equal(requests.length, 1, nativeId);
    assert.equal(result.streams.length, 1, nativeId);
    assert.equal(result.streams[0].url, 'https://cdn.mediaoscar.com/live/master.m3u8?token=signed&expires=123');
    assert.equal(result.streams[0].type, 'm3u8');
  }
});

test('anime parent streams use the anime details endpoint and preserve all advertised qualities', async () => {
  const requests = [];
  const plugin = loadPlugin(async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url);
    assert.equal(url.pathname, '/api/anime/show.php');
    assert.equal(url.searchParams.get('id'), '150');
    return apiResponse({ id: 150, watch_links: ['1080p', '720p', '480p'].map(quality => ({
      url: `https://cdn.mediaoscar.com/fan-letter/${quality}.m3u8?token=signed`,
      type: 'direct',
      quality,
      server_name: 'Source'
    })) });
  });

  const result = await plugin.getStreams({ id: 'anime:150' });

  assert.equal(requests.length, 1);
  assert.equal(result.streams.length, 3);
  assert.deepEqual(Array.from(result.streams, stream => stream.quality), ['1080p', '720p', '480p']);
  assert.ok(result.streams.every(stream => stream.type === 'm3u8'));
  assert.ok(result.streams.every(stream => stream.provider === 'Source'));
});

test('anime episode 3383 fixture resolves SeriesMP4 iframe through Yandex and keeps native request identity', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/3383';
  const yandex = 'https://downloader.disk.yandex.ru/disk/3383';
  const finalUrl = 'https://downloader.disk.yandex.ru/disk/3383.mp4?token=signed';
  const requests = [];
  const plugin = loadPlugin(async (rawUrl, options) => {
    const url = new URL(rawUrl);
    requests.push({ url, options });
    if (url.hostname === 'ostv-11-11.xyz') {
      assert.equal(url.pathname, '/api/anime/episodes/show.php');
      assert.equal(url.searchParams.get('id'), '3383');
      return apiResponse({ id: 3383, watch_links: [{ url: wrapper, type: 'direct', server_name: 'Mirror' }] });
    }
    if (rawUrl === wrapper) return httpResponse({ status: 200, url: rawUrl, contentType: 'text/html', body: `<iframe src="${yandex}"></iframe>` });
    if (rawUrl === yandex) {
      assert.equal(options.headers.Referer, undefined);
      return httpResponse({ status: 206, url: finalUrl, contentType: 'video/mp4', body: 'partial' });
    }
    throw new Error(`unexpected host ${url.hostname}`);
  });

  const result = await plugin.getStreams({ id: 'anime_episode:3383' });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].url, finalUrl);
  assert.equal(result.streams[0].headers.Referer, undefined);
  assert.equal(requests.length, 3);
});

test('valid mediaoscar direct links remain unchanged and preserve signed URLs and User-Agent', async () => {
  let fetches = 0;
  const plugin = loadPlugin(async () => { fetches += 1; throw new Error('direct media must not fetch'); });
  const url = 'https://cdn.mediaoscar.com/path/master.m3u8?token=abc&expires=123';
  const streams = await plugin.__test.resolveLink({ url, type: 'direct', deep_link: '?ua=OscarMediaUA' });
  assert.equal(fetches, 0);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, url);
  assert.equal(streams[0].type, 'm3u8');
  assert.equal(streams[0].headers['User-Agent'], 'OscarMediaUA');
});

test('followed redirect uses the final response URL and preserves the original stream headers', async () => {
  const requests = [];
  const finalUrl = 'https://cdn.example.test/redirected.mp4?sig=fixture';
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://newcdn.seriesmp4.com/watch/redirect') {
      return httpResponse({ status: 206, url: finalUrl, contentType: 'video/mp4', body: 'partial', headers: { location: finalUrl } });
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const streams = await plugin.__test.resolveLink({ url: 'https://newcdn.seriesmp4.com/watch/redirect', type: 'direct', deep_link: '?ua=RedirectUA' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, finalUrl);
  assert.equal(streams[0].headers['User-Agent'], 'RedirectUA');
  assert.equal(requests[0].options.redirect, 'follow');
});

test('SeriesMP4 bounded body fallback follows only a Yandex media URL and ignores ad/tracking/script links', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/body-link';
  const media = 'https://downloader.disk.yandex.ru/disk/fixture.mp4?token=abc&expires=123';
  const requests = [];
  const body = [
    '<html><body>',
    '<a href="https://ads.example.test/ads/pixel.mp4">ad</a>',
    '<a href="https://downloader.disk.yandex.ru/tracking/pixel.mp4">tracker</a>',
    '<script>var ignored = "https://downloader.disk.yandex.ru/script-only.mp4";</script>',
    `<p>video source: ${media.replace(/&/g, '&amp;')}</p>`,
    '</body></html>'
  ].join('');
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    if (url === wrapper) return httpResponse({ status: 200, url, contentType: 'text/html', body });
    if (url === media) return httpResponse({ status: 206, url, contentType: 'video/mp4', body: 'partial' });
    throw new Error(`unexpected URL ${url}`);
  });
  const streams = await plugin.__test.resolveLink({ url: wrapper, type: 'direct', deep_link: '?user_agent=BodyUA' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, media);
  assert.equal(streams[0].headers['User-Agent'], 'BodyUA');
  assert.equal(streams[0].headers.Referer, undefined);
  assert.equal(streams[0].headers.Range, undefined);
  assert.deepEqual(requests.map(request => request.url), [wrapper, media]);
  assert.equal(requests[0].options.headers.Range, undefined);
  assert.equal(requests[1].options.headers.Range, 'bytes=0-65535');
  assert.equal(requests[1].options.headers.Referer, undefined);
});

test('SeriesMP4 absolute body fallback rejects non-Yandex hosts and ad paths without probing them', async () => {
  const wrapper = 'https://seriesmp4.com/watch/unsafe-body';
  const requests = [];
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    return httpResponse({ status: 200, url, contentType: 'text/html', body: [
      '<html><body>',
    'https://yandex.ru.evil.test/video.mp4',
    'https://downloader.disk.yandex.ru/ads/creative.mp4',
    'https://downloader.disk.yandex.ru/tracking/pixel.mp4',
      '</body></html>'
    ].join('') });
  });
  const streams = await plugin.__test.resolveLink({ url: wrapper, type: 'direct' });
  assert.equal(streams.length, 0);
  assert.deepEqual(requests.map(request => request.url), [wrapper]);
});

test('TDM custom schemes are never emitted as Media3 stream URLs', async () => {
  let fetches = 0;
  const plugin = loadPlugin(async () => { fetches += 1; throw new Error('custom URI must not be fetched'); });
  const custom = 'tdmvideo://play?url=https%3A%2F%2Fcdn.example.test%2Fmovie.mp4&ua=FixtureUA';
  assert.equal(plugin.__test.isHttpUrl(custom), false);
  assert.equal(plugin.__test.isHttpUrl('https:///missing-host.mp4'), false);
  assert.equal(plugin.__test.directMedia(custom, '', 'direct'), false);
  assert.equal((await plugin.__test.resolveLink({ url: custom, type: 'direct' })).length, 0);
  assert.equal(fetches, 0);
});

test('WatchLink URL remains the media candidate while TDM deep_link supplies playback headers', async () => {
  let fetches = 0;
  const plugin = loadPlugin(async () => { fetches += 1; throw new Error('direct media must not fetch'); });
  const url = 'https://cdn.mediaoscar.com/live/master.m3u8?token=signed';
  const streams = await plugin.__test.resolveLink({
    url,
    deep_link: 'tdmvideo://play?url=https%3A%2F%2Fother.example%2Fvideo.mp4&user_agent=Fixture%20Player&cookies=session%3Dfixture&referer=https%3A%2F%2Fwatch.example%2Fepisode',
    type: 'direct'
  });
  assert.equal(fetches, 0);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, url);
  assert.equal(streams[0].headers['User-Agent'], 'Fixture Player');
  assert.equal(streams[0].headers.Cookie, 'session=fixture');
  assert.equal(streams[0].headers.Referer, 'https://watch.example/episode');
});

test('TDM session headers are omitted when the deep-link media target differs from the WatchLink origin', async () => {
  const plugin = loadPlugin(async () => { throw new Error('direct media must not fetch'); });
  const streams = await plugin.__test.resolveLink({
    id: 42,
    url: 'https://origin.example/wrapper.mp4',
    type: 'embed',
    deep_link: 'tdmvideo://play?url=https%3A%2F%2Fother.example%2Fepisode.mp4&ua=FixtureUA&cookies=session%3Dsecret&ref=https%3A%2F%2Fwatch.example%2F'
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://other.example/episode.mp4');
  assert.equal(streams[0].headers['User-Agent'], 'FixtureUA');
  assert.equal(streams[0].headers.Cookie, undefined);
  assert.equal(streams[0].headers.Referer, undefined);
});

test('TDM playback metadata rejects header controls and non-HTTP Referer values', async () => {
  const plugin = loadPlugin(async () => { throw new Error('direct media must not fetch'); });
  const streams = await plugin.__test.resolveLink({
    url: 'https://cdn.mediaoscar.com/episode.mp4',
    type: 'direct',
    deep_link: 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Fepisode.mp4&ua=Bad%0d%0aX-Evil%3A%20yes&cookies=session%3Dvalue%0d%0aX-Evil%3A%20yes&referer=javascript%3Aalert(1)'
  });

  assert.equal(streams[0].headers['User-Agent'], 'TDMuaPlayer');
  assert.equal(streams[0].headers.Cookie, undefined);
  assert.equal(streams[0].headers.Referer, undefined);
});

test('offline WatchLink fixture retains server order and selects HTTP WatchLink URLs', async () => {
  const mediaFetches = [];
  const links = [
    { url: 'https://fixture.example/first.mp4', type: 'direct', server_name: 'MP4 only' },
    {
      url: 'https://fixture.example/second/master.m3u8', type: 'direct', server_name: 'URL plus deep link',
      deep_link: 'tdmvideo://play?url=https%3A%2F%2Fother.fixture%2Fepisode.mp4&ua=ExternalFixture'
    },
    { url: 'https://fixture.example/wrapper/third', type: 'embed', server_name: 'HTML wrapper' },
    {
      url: 'https://fixture.example/episode/fourth.mp4', type: 'direct', server_name: 'Fixture server 4',
      deep_link: 'tdmvideo://play?url=https%3A%2F%2Ffixture.example%2Fdeep-target.mp4'
    }
  ];
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.hostname !== 'ostv-11-11.xyz') mediaFetches.push(url.href);
    assert.equal(url.pathname, '/api/episodes/show.php');
    assert.equal(url.searchParams.get('id'), '731');
    return apiResponse({ id: 731, watch_links: links });
  });

  const listing = await plugin.getStreams({ id: 'series_episode:731', mode: 'options' });
  assert.deepEqual(Array.from(listing.options, option => option.title), [
    'MP4 only', 'URL plus deep link', 'HTML wrapper', 'Fixture server 4'
  ]);
  assert.equal(listing.options.length, 4);

  const first = await plugin.resolveStreamOption({ id: 'series_episode:731', token: listing.options[0].token });
  assert.equal(first.streams[0].url, links[0].url, 'URL-only MP4 is retained as a playable candidate');

  const second = await plugin.resolveStreamOption({ id: 'series_episode:731', token: listing.options[1].token });
  assert.equal(second.streams[0].url, links[1].url, 'the WatchLink URL remains the media candidate');
  assert.equal(second.streams[0].type, 'm3u8');

  const fourth = await plugin.resolveStreamOption({ id: 'series_episode:731', token: listing.options[3].token });
  assert.equal(fourth.streams.length, 1);
  assert.equal(fourth.streams[0].url, links[3].url);
  assert.equal(fourth.streams[0].type, 'video');
  assert.equal(mediaFetches.length, 0, 'direct candidates are not probed or downloaded');
});

test('offline deep_link-only TDM option becomes a normal HTTP stream, never a custom Media3 URI', async () => {
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    assert.equal(url.pathname, '/api/anime/episodes/show.php');
    assert.equal(url.searchParams.get('id'), '812');
    return apiResponse({ id: 812, watch_links: [{
      deep_link: 'tdmvideo://play?url=https%3A%2F%2Ffixture.example%2Fepisode.mp4',
      server_name: 'External player only',
      type: 'direct'
    }] });
  });

  const listing = await plugin.getStreams({ id: 'anime_episode:812', mode: 'options' });
  assert.equal(listing.options.length, 1, 'a supported TDM deep link contains a safe HTTP candidate');
  const resolved = await plugin.resolveStreamOption({ id: 'anime_episode:812', token: listing.options[0].token });
  assert.equal(resolved.streams[0].url, 'https://fixture.example/episode.mp4');
  assert.equal(resolved.streams[0].url.startsWith('tdmvideo:'), false);
});

test('embed links prefer an HTTP deep_link, while unsupported custom schemes fall back to HTTP url', () => {
  const h = loadPlugin(async () => { throw new Error('classification must not fetch'); }).__test;
  assert.equal(h.playbackTarget({
    url: 'https://cdn.example.test/warning.mp4',
    deep_link: 'https://embed.example.test/watch/episode',
    type: 'embed'
  }).url, 'https://embed.example.test/watch/episode');
  assert.equal(h.playbackTarget({
    url: 'https://cdn.example.test/episode.mp4',
    deep_link: 'unknownplayer://play?id=12',
    type: 'direct'
  }).url, 'https://cdn.example.test/episode.mp4');
  assert.equal(h.playbackTarget({
    url: 'https://cdn.example.test/fallback.mp4',
    deep_link: 'tdmvideo://play?url=javascript%3Aalert(1)',
    type: 'direct'
  }).url, 'https://cdn.example.test/fallback.mp4');
});

test('Yandex aliases are boundary-matched and HTTP failures remain failures', async () => {
  const h = loadPlugin(async () => { throw new Error('classification must not fetch'); }).__test;
  assert.equal(h.isYandex('https://yandex.ru/video.mp4'), true);
  assert.equal(h.isYandex('https://downloader.disk.yandex.ru/video.mp4'), true);
  assert.equal(h.isYandex('https://storage.yandexcloud.net/video.mp4'), false, 'unconfirmed alias is not added');
  assert.equal(h.isYandex('https://yandex.ru.evil.test/video.mp4'), false);
  assert.equal(h.isYandex('https://notyandex.ru/video.mp4'), false);

  const denied = loadPlugin(async (url) => httpResponse({ status: 403, url, contentType: 'text/html', body: '<html>denied</html>' }));
  assert.equal((await denied.__test.resolveLink({ url: 'https://downloader.disk.yandex.ru/disk/denied', type: 'direct' })).length, 0);
});

test('MIME-only HLS is returned with the HLS stream type', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/mime-hls';
  const finalUrl = 'https://cdn.example.test/live?id=fixture';
  const plugin = loadPlugin(async (url) => {
    if (url === wrapper) return httpResponse({ status: 200, url: finalUrl, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' });
    throw new Error(`unexpected URL ${url}`);
  });
  const streams = await plugin.__test.resolveLink({ url: wrapper, type: 'direct' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, finalUrl);
  assert.equal(streams[0].type, 'm3u8');
});

test('a nested wrapper loop terminates without repeating a request', async () => {
  const a = 'https://newcdn.seriesmp4.com/watch/a';
  const b = 'https://player.example.test/watch/b';
  const requests = [];
  const plugin = loadPlugin(async (url) => {
    requests.push(url);
    if (url === a) return httpResponse({ status: 200, url, contentType: 'text/html', body: `<iframe src="${b}"></iframe>` });
    if (url === b) return httpResponse({ status: 200, url, contentType: 'text/html', body: `<iframe src="${a}"></iframe>` });
    throw new Error(`unexpected URL ${url}`);
  });
  assert.equal((await plugin.__test.resolveLink({ url: a, type: 'direct' })).length, 0);
  assert.deepEqual(requests, [a, b]);
});

test('an extension-looking final URL that responds with HTML is rejected', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/html-final';
  const finalUrl = 'https://downloader.disk.yandex.ru/disk/final.mp4';
  const plugin = loadPlugin(async (url) => {
    if (url === wrapper) return httpResponse({ status: 200, url: finalUrl, contentType: 'text/html', body: '<html>not media</html>' });
    throw new Error(`unexpected URL ${url}`);
  });
  assert.equal((await plugin.__test.resolveLink({ url: wrapper, type: 'direct' })).length, 0);
});

test('bounded FetchBridge-style truncated HTML can resolve only a link in the returned prefix', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/truncated';
  const media = 'https://downloader.disk.yandex.ru/disk/early.mp4';
  const prefix = `<html><body>${media}</body></html>`;
  const boundedBridgeBody = prefix + 'x'.repeat(1024 * 1024 - prefix.length) + '\n...[truncated]';
  const plugin = loadPlugin(async (url) => {
    if (url === wrapper) return httpResponse({ status: 200, url, contentType: 'text/html', body: boundedBridgeBody });
    if (url === media) return httpResponse({ status: 206, url, contentType: 'video/mp4', body: 'partial' });
    throw new Error(`unexpected URL ${url}`);
  });
  const streams = await plugin.__test.resolveLink({ url: wrapper, type: 'direct' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, media);
});

test('production script stays free of Node-only and browser-only APIs', () => {
  assert.doesNotMatch(source, /\brequire\s*\(|\bBuffer\b|\bprocess\b|\bcheerio\b|\bdocument\b|\bwindow\b/);
  assert.match(source, /root\s*&&\s*root\.module/);
});

test('native episode identifiers are parsed as their original Oscar integer', () => {
  const h = loadPlugin(async () => { throw new Error('parsing must not fetch'); }).__test;
  assert.deepEqual(JSON.parse(JSON.stringify(h.parseId('series_episode:93051'))), { type: 'series_episode', id: 93051 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.parseId('anime_episode:8123'))), { type: 'anime_episode', id: 8123 });
});

test('STREAMS forwards the typed native episode number to Oscar without deriving it from season or index', async () => {
  const requests = [];
  const plugin = loadPlugin(async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url);
    if (url.hostname === 'ostv-11-11.xyz' && url.pathname === '/api/episodes/show.php') {
      return apiResponse({ id: 93051, watch_links: [
        { url: 'https://cdn.mediaoscar.com/video/episode.mp4?token=fixture', type: 'direct' }
      ] });
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const result = await plugin.getStreams({ id: 'series_episode:93051' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('id'), '93051');
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].url, 'https://cdn.mediaoscar.com/video/episode.mp4?token=fixture');
});

test('STREAMS resolves at most two slow links concurrently and preserves advertised order and quality', async () => {
  const delays = [90, 80, 70, 60];
  let active = 0;
  let peak = 0;
  let bodyReads = 0;
  const plugin = loadPlugin(async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if (url.hostname === 'ostv-11-11.xyz') {
      return apiResponse({ id: 3383, watch_links: delays.map((_, index) => ({
        url: `https://probe${index}.example/wrapper?signature=keep-${index}`,
        type: 'direct',
        quality: `${1080 - index * 180}p`,
        server_name: `Mirror ${index + 1}`
      })) });
    }
    const index = Number(url.hostname.match(/^probe(\d+)\./)[1]);
    assert.equal(options.headers.Range, 'bytes=0-65535');
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, delays[index]));
    active -= 1;
    return {
      ...httpResponse({
        status: 206,
        url: `https://media.example/video${index}.mp4?signature=keep-${index}`,
        contentType: 'video/mp4'
      }),
      text: async () => { bodyReads += 1; return 'must not read a media body'; }
    };
  });

  const started = performance.now();
  const result = await plugin.getStreams({ id: 'anime_episode:3383' });
  const elapsedMs = performance.now() - started;

  assert.equal(peak, 2);
  // Peak concurrency is the deterministic performance contract. Wall-clock
  // assertions made this test flaky under desktop/CI scheduling contention.
  assert.equal(bodyReads, 0, 'media response bodies must not be downloaded');
  assert.deepEqual(Array.from(result.streams, stream => stream.title), ['Mirror 1', 'Mirror 2', 'Mirror 3', 'Mirror 4']);
  assert.deepEqual(Array.from(result.streams, stream => stream.quality), ['1080p', '900p', '720p', '540p']);
  assert.deepEqual(Array.from(result.streams, stream => stream.url), [0, 1, 2, 3].map(index => `https://media.example/video${index}.mp4?signature=keep-${index}`));
  assert.equal(new Set(result.streams.map(stream => stream.url)).size, 4);
});

test('STREAMS isolates one resolver failure while the other worker continues', async () => {
  let active = 0;
  let peak = 0;
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.hostname === 'ostv-11-11.xyz') {
      return apiResponse({ id: 3383, watch_links: [
        { url: 'https://broken.example/wrapper', type: 'direct', server_name: 'Broken' },
        { url: 'https://working.example/wrapper', type: 'direct', server_name: 'Working', quality: '720p' }
      ] });
    }
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    if (url.hostname === 'broken.example') throw new Error('fixture failure');
    return httpResponse({ status: 206, url: 'https://media.example/working.mp4', contentType: 'video/mp4' });
  });

  const result = await plugin.getStreams({ id: 'anime_episode:3383' });

  assert.equal(peak, 2);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].title, 'Working');
  assert.equal(result.streams[0].quality, '720p');
});

test('direct HLS batches remain probe-free under bounded resolution', async () => {
  const signedUrls = [0, 1, 2].map(index => `https://cdn.mediaoscar.com/fan-letter/${index}.m3u8?token=signed-${index}`);
  let calls = 0;
  const plugin = loadPlugin(async rawUrl => {
    calls += 1;
    const url = new URL(rawUrl);
    assert.equal(url.hostname, 'ostv-11-11.xyz', 'direct HLS must not be probed');
    return apiResponse({ id: 150, watch_links: signedUrls.map((streamUrl, index) => ({
      url: streamUrl,
      type: 'direct',
      quality: `${1080 - index * 360}p`,
      server_name: `Source ${index + 1}`
    })) });
  });

  const result = await plugin.getStreams({ id: 'anime:150' });

  assert.equal(calls, 1);
  assert.deepEqual(Array.from(result.streams, stream => stream.url), signedUrls);
  assert.equal(result.streams.length, 3);
});

test('lazy stream options expose every advertised quality without resolving wrappers', async () => {
  const requests = [];
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    requests.push(url);
    assert.equal(url.hostname, 'ostv-11-11.xyz');
    return apiResponse({ id: 3383, watch_links: [
      { url: 'https://newcdn.seriesmp4.com/watch/one', type: 'direct', quality: '1080p', server_name: 'Mirror 1' },
      { url: 'https://newcdn.seriesmp4.com/watch/two', type: 'direct', quality: '720p', server_name: 'Mirror 2' }
    ] });
  });

  const result = await plugin.getStreams({ id: 'anime_episode:3383', mode: 'options' });

  assert.equal(requests.length, 1, 'listing options must only call the Oscar API');
  assert.equal(result.options.length, 2);
  assert.deepEqual(Array.from(result.options, option => option.quality), ['1080p', '720p']);
  assert.ok(result.options.every(option => option.token && !option.url));
});

test('identified lazy options omit signed URLs and refresh the selected WatchLink by native ID', async () => {
  let listingRequests = 0;
  const oldUrl = 'https://cdn.mediaoscar.com/episode/old.m3u8?token=old-secret';
  const freshUrl = 'https://cdn.mediaoscar.com/episode/fresh.m3u8?token=new-secret';
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    assert.equal(url.pathname, '/api/anime/episodes/show.php');
    listingRequests += 1;
    const selected = listingRequests === 1 ? oldUrl : freshUrl;
    return apiResponse({ id: 3383, watch_links: [
      { id: 771, server_name: 'Via - Server 4', url: selected, type: 'direct', quality: '1080p' },
      { id: 772, server_name: 'Other', url: 'https://cdn.mediaoscar.com/episode/unselected.m3u8?token=untouched', type: 'direct' }
    ] });
  });

  const listed = await plugin.getStreams({ id: 'anime_episode:3383', mode: 'options' });
  const token = JSON.parse(listed.options[0].token);
  assert.equal(token.version, 3);
  assert.equal(token.nativeId, 'anime_episode:3383');
  assert.equal(token.link.watch_link_id, 771);
  assert.equal(token.link.url, undefined);
  assert.equal(token.link.deep_link, undefined);
  assert.equal(JSON.stringify(token).includes('old-secret'), false);
  await assert.rejects(
    plugin.resolveStreamOption({ id: 'anime_episode:3384', token: listed.options[0].token }),
    /invalid stream option identity/
  );
  assert.equal(listingRequests, 1, 'a mismatched native ID must fail before a refresh request');

  const resolved = await plugin.resolveStreamOption({ id: 'anime_episode:3383', token: listed.options[0].token });
  assert.equal(listingRequests, 2, 'only the selected option should request a fresh WatchLink list');
  assert.equal(resolved.streams[0].url, freshUrl);
  assert.equal(resolved.streams[0].url.includes('old-secret'), false);
});

test('selected lazy WatchLink refreshes URL, Cookie, User-Agent and Referer metadata without storing secrets in its token', async () => {
  let requestCount = 0;
  const oldDeepLink = 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Fold.m3u8&ua=OldUA&cookies=session%3Dold-cookie&referer=https%3A%2F%2Fwatch.mediaoscar.com%2Fold';
  const freshDeepLink = 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Ffresh.m3u8&ua=FreshUA&cookies=session%3Dfresh-cookie&referer=https%3A%2F%2Fwatch.mediaoscar.com%2Ffresh';
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    assert.equal(url.pathname, '/api/episodes/show.php');
    requestCount += 1;
    return apiResponse({ id: 93051, watch_links: [{
      id: 771,
      server_name: 'Via - Server 4',
      type: 'direct',
      url: requestCount === 1
        ? 'https://cdn.mediaoscar.com/old.m3u8?token=old-signed'
        : 'https://cdn.mediaoscar.com/fresh.m3u8?token=fresh-signed',
      deep_link: requestCount === 1 ? oldDeepLink : freshDeepLink
    }] });
  });

  const listing = await plugin.getStreams({ id: 'series_episode:93051', mode: 'options' });
  const tokenText = listing.options[0].token;
  assert.equal(tokenText.includes('old-cookie'), false);
  assert.equal(tokenText.includes('old-signed'), false);
  assert.equal(tokenText.includes('OldUA'), false);
  assert.equal(tokenText.includes('watch.mediaoscar.com/old'), false);

  const resolved = await plugin.resolveStreamOption({ id: 'series_episode:93051', token: tokenText });
  assert.equal(requestCount, 2, 'selection re-fetches the provider WatchLinks');
  assert.equal(resolved.streams[0].url, 'https://cdn.mediaoscar.com/fresh.m3u8?token=fresh-signed');
  assert.equal(resolved.streams[0].headers.Cookie, 'session=fresh-cookie');
  assert.equal(resolved.streams[0].headers['User-Agent'], 'FreshUA');
  assert.equal(resolved.streams[0].headers.Referer, 'https://watch.mediaoscar.com/fresh');
  assert.equal(JSON.stringify(resolved).includes('old-cookie'), false);
});

test('identified-by-descriptor options without a WatchLink ID refresh dynamic metadata without persisting URLs or cookies', async () => {
  let requestCount = 0;
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    assert.equal(url.pathname, '/api/movies/show.php');
    requestCount += 1;
    return apiResponse({ id: 6001, watch_links: [{
      server_name: 'Oscar CDN',
      type: 'direct',
      quality: '1080p',
      url: requestCount === 1
        ? 'https://cdn.mediaoscar.com/old.m3u8?token=old-signed'
        : 'https://cdn.mediaoscar.com/fresh.m3u8?token=fresh-signed',
      deep_link: requestCount === 1
        ? 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Fold.m3u8&cookies=session%3Dold-cookie'
        : 'tdmvideo://play?url=https%3A%2F%2Fcdn.mediaoscar.com%2Ffresh.m3u8&cookies=session%3Dfresh-cookie&ua=FreshUA'
    }] });
  });

  const listing = await plugin.getStreams({ id: 'movie:6001', mode: 'options' });
  const tokenText = listing.options[0].token;
  const token = JSON.parse(tokenText);
  assert.equal(token.version, 4);
  assert.equal(token.link.server_name, 'Oscar CDN');
  assert.equal(token.link.source_ordinal, 0);
  assert.equal(tokenText.includes('old-cookie'), false);
  assert.equal(tokenText.includes('old-signed'), false);
  assert.equal(token.link.url, undefined);
  assert.equal(token.link.deep_link, undefined);

  const resolved = await plugin.resolveStreamOption({ id: 'movie:6001', token: tokenText });
  assert.equal(requestCount, 2);
  assert.equal(resolved.streams[0].url, 'https://cdn.mediaoscar.com/fresh.m3u8?token=fresh-signed');
  assert.equal(resolved.streams[0].headers.Cookie, 'session=fresh-cookie');
  assert.equal(resolved.streams[0].headers['User-Agent'], 'FreshUA');
  assert.equal(JSON.stringify(resolved).includes('old-cookie'), false);
});

test('lazy options preserve anime parent and movie server counts without probes', async () => {
  const requests = [];
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    requests.push(url);
    assert.equal(url.hostname, 'ostv-11-11.xyz');
    const count = url.pathname === '/api/anime/show.php' ? 3 : 5;
    return apiResponse({
      id: Number(url.searchParams.get('id')),
      watch_links: Array.from({ length: count }, (_, index) => ({
        url: `https://cdn.mediaoscar.com/direct/${index}.m3u8?token=kept-${index}`,
        type: 'direct',
        quality: `${1080 - index * 120}p`,
        server_name: `Source ${index + 1}`
      }))
    });
  });

  const parent = await plugin.getStreams({ id: 'anime:150', mode: 'options' });
  const movie = await plugin.getStreams({ id: 'movie:4444', mode: 'options' });

  assert.equal(parent.options.length, 3);
  assert.equal(movie.options.length, 5);
  assert.equal(requests.length, 2, 'each lazy listing must perform only its Oscar API request');
  assert.deepEqual(requests.map(url => url.pathname), ['/api/anime/show.php', '/api/movies/show.php']);
});

test('only the selected lazy option is resolved and direct HLS keeps the fast path', async () => {
  const wrapper = 'https://newcdn.seriesmp4.com/watch/selected';
  const yandex = 'https://downloader.disk.yandex.ru/disk/selected';
  const finalUrl = 'https://downloader.disk.yandex.ru/disk/selected.mp4?token=signed';
  const directUrl = 'https://cdn.mediaoscar.com/live/direct.m3u8?token=signed';
  const requests = [];
  const plugin = loadPlugin(async (url, options) => {
    requests.push({ url, options });
    if (url === wrapper) return httpResponse({ status: 200, url, contentType: 'text/html', body: `<iframe src="${yandex}"></iframe>` });
    if (url === yandex) return httpResponse({ status: 206, url: finalUrl, contentType: 'video/mp4', body: 'partial' });
    throw new Error(`unexpected URL ${url}`);
  });
  const wrapperToken = plugin.__test.streamOption({ url: wrapper, type: 'direct', server_name: 'Mirror' }).token;
  const directToken = plugin.__test.streamOption({ url: directUrl, type: 'direct', server_name: 'Direct' }).token;

  const resolved = await plugin.resolveStreamOption({ id: 'anime_episode:3383', token: wrapperToken });
  assert.equal(resolved.streams.length, 1);
  assert.equal(resolved.streams[0].url, finalUrl);
  assert.deepEqual(requests.map(request => request.url), [wrapper, yandex]);

  requests.length = 0;
  const direct = await plugin.resolveStreamOption({ id: 'anime_episode:10549', token: directToken });
  assert.equal(direct.streams[0].url, directUrl);
  assert.equal(requests.length, 0, 'direct HLS must not receive a probe during selected resolution');
});

test('invalid and failed lazy options stay isolated and can be retried', async () => {
  let attempts = 0;
  const wrapper = 'https://newcdn.seriesmp4.com/watch/retry';
  const plugin = loadPlugin(async url => {
    attempts += 1;
    if (attempts === 1) return httpResponse({ status: 403, url, contentType: 'text/html', body: '<html>denied</html>' });
    return httpResponse({ status: 206, url: 'https://media.example/retry.mp4', contentType: 'video/mp4', body: 'partial' });
  });
  const token = plugin.__test.streamOption({ url: wrapper, type: 'direct', server_name: 'Retry' }).token;

  assert.deepEqual(Array.from((await plugin.resolveStreamOption({ id: 'anime_episode:3383', token })).streams), []);
  const retry = await plugin.resolveStreamOption({ id: 'anime_episode:3383', token });
  assert.equal(retry.streams[0].url, 'https://media.example/retry.mp4');
  await assert.rejects(plugin.resolveStreamOption({ id: 'anime_episode:3383', token: '{"version":2}' }), /invalid stream option token/);
});

test('lazy listing separates time to server list from selected server resolution', async t => {
  const links = [0, 1].map(index => ({
    url: `https://slow${index}.example/wrapper`, type: 'direct', server_name: `Mirror ${index + 1}`
  }));
  const plugin = loadPlugin(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.hostname === 'ostv-11-11.xyz') {
      await new Promise(resolve => setTimeout(resolve, 20));
      return apiResponse({ id: 3383, watch_links: links });
    }
    await new Promise(resolve => setTimeout(resolve, 80));
    return httpResponse({ status: 206, url: `https://media.example/${url.hostname}.mp4`, contentType: 'video/mp4' });
  });

  const legacyStart = performance.now();
  await plugin.getStreams({ id: 'anime_episode:3383' });
  const legacyMs = performance.now() - legacyStart;
  const listStart = performance.now();
  const listed = await plugin.getStreams({ id: 'anime_episode:3383', mode: 'options' });
  const listMs = performance.now() - listStart;
  const resolveStart = performance.now();
  await plugin.resolveStreamOption({ id: 'anime_episode:3383', token: listed.options[0].token });
  const resolveMs = performance.now() - resolveStart;

  assert.ok(listMs < legacyMs, `options ${listMs}ms should beat full resolution ${legacyMs}ms`);
  assert.ok(listMs < 70, `fixture option listing should be API-bound, got ${listMs}ms`);
  assert.ok(resolveMs >= 60, `selected fixture should include its resolver delay, got ${resolveMs}ms`);
  t.diagnostic(`fixture legacy=${legacyMs.toFixed(1)}ms list=${listMs.toFixed(1)}ms selectedResolve=${resolveMs.toFixed(1)}ms`);
});

test('live reference selector matches the requested server label rather than assuming its source ordinal', () => {
  const options = [
    { title: 'Server 8', token: JSON.stringify({ link: { server_name: 'Server 8' } }) },
    { title: 'Via — Server 4', token: JSON.stringify({ link: { server_name: 'Server 4' } }) },
    { title: 'Server 2', token: JSON.stringify({ link: { server_name: 'Server 2' } }) }
  ];
  const selected = selectTargetOption(options, 'Via — Server 4');
  assert.equal(selected.index, 1);
  assert.equal(selected.option.title, 'Via — Server 4');
  assert.equal(selectTargetOption([
    options[0], options[1], { title: 'Mirror Server 4', token: JSON.stringify({ link: { server_name: 'Mirror Server 4' } }) }
  ], 'Via — Server 4'), null, 'ambiguous server labels must not trigger a guessed selection');
});

test('existing evidence analyzer maps v2 option tokens by WatchLink ID and redacts signed queries', () => {
  const capture = {
    nativeEpisodeId: 'series_episode:93051',
    runtimeTrace: {
      events: [{
        requestUrl: 'https://ostv-11-11.xyz/api/episodes/show.php?id=93051',
        responseBody: { data: { watch_links: [{
          id: 771,
          server_name: 'Via - Server 4',
          type: 'direct',
          quality: '1080p',
          duration_seconds: 61,
          url: 'https://warning.example/warning.mp4?token=PRIVATE_QUERY_SENTINEL',
          deep_link: 'tdmvideo://play?url=https%3A%2F%2Fepisode.example%2Fwatch.mp4%3Fsig%3DPRIVATE_QUERY_SENTINEL'
        }] } }
      }],
      yumeListing: [{
        title: 'Via - Server 4',
        token: JSON.stringify({ version: 2, ordinal: 3, link: {
          watch_link_id: 771,
          url: 'https://warning.example/warning.mp4?token=PRIVATE_QUERY_SENTINEL',
          deep_link: 'tdmvideo://play?url=https%3A%2F%2Fepisode.example%2Fwatch.mp4%3Fsig%3DPRIVATE_QUERY_SENTINEL',
          selected_url: 'https://episode.example/watch.mp4?sig=PRIVATE_QUERY_SENTINEL',
          selected_field: 'deep_link.url',
          server_name: 'Via - Server 4', type: 'direct', quality: '1080p'
        } })
      }],
      selectedYumeOrdinal: 1
    }
  };
  const report = summarizeWatchLinks(capture);
  assert.equal(report.watchLinks[0].id, 771);
  assert.equal(report.yumeSelection.matchedWatchLink.id, 771);
  assert.equal(report.yumeSelection.selectedField, 'deep_link.url');
  assert.equal(report.yumeSelection.selectedCandidate.hostname, 'episode.example');
  assert.deepEqual(JSON.parse(JSON.stringify(report.watchLinks[0].durationMetadata)), {
    sourceField: 'duration_seconds', value: 61, unit: 'seconds'
  });
  assert.equal(JSON.stringify(report).includes('PRIVATE_QUERY_SENTINEL'), false);
});

test('existing evidence analyzer maps refreshed v3 option tokens without a stored signed URL', () => {
  const report = summarizeWatchLinks({
    nativeEpisodeId: 'series_episode:93051',
    runtimeTrace: {
      events: [{ requestUrl: 'https://ostv-11-11.xyz/api/episodes/show.php?id=93051', responseBody: { data: { watch_links: [
        { id: 771, server_name: 'Via - Server 4', type: 'direct', quality: '1080p', url: 'https://cdn.example/new.m3u8?token=PRIVATE_REFRESHED' }
      ] } } }],
      yumeListing: [{ title: 'Via - Server 4', token: JSON.stringify({ version: 3, nativeId: 'series_episode:93051', link: {
        watch_link_id: 771, selected_field: 'url', server_name: 'Via - Server 4', type: 'direct', quality: '1080p'
      } }) }],
      selectedYumeOrdinal: 1,
      playerStream: { url: 'https://cdn.example/new.m3u8?token=PRIVATE_REFRESHED', type: 'm3u8' }
    }
  });
  assert.equal(report.yumeSelection.matchedWatchLink.id, 771);
  assert.equal(report.yumeSelection.selectedField, 'url');
  assert.equal(JSON.stringify(report).includes('PRIVATE_REFRESHED'), false);
});

test('WatchLink evidence analyzer redacts short CDN path tokens after /t/', () => {
  const report = summarizeWatchLinks({
    watchLinks: [{
      id: 772,
      server_name: 'CDN',
      type: 'direct',
      quality: '1080p',
      url: 'https://cdn.example/t/shorttoken/files/episode/index.m3u8?cookie=PRIVATE_COOKIE_SENTINEL'
    }],
    playerCandidate: {
      url: 'https://cdn.example/t/shorttoken/files/episode/index.m3u8?cookie=PRIVATE_COOKIE_SENTINEL',
      type: 'm3u8'
    },
    hops: [{
      url: 'https://cdn.example/t/shorttoken/files/episode/index.m3u8?cookie=PRIVATE_COOKIE_SENTINEL',
      status: 200
    }]
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('shorttoken'), false);
  assert.equal(serialized.includes('PRIVATE_COOKIE_SENTINEL'), false);
  assert.equal(report.watchLinks[0].url.pathname, '/t/[REDACTED]/files/episode/index.m3u8');
  assert.equal(report.playerCandidate.url.pathname, '/t/[REDACTED]/files/episode/index.m3u8');
  assert.equal(report.hops[0].from.pathname, '/t/[REDACTED]/files/episode/index.m3u8');
});

test('catalog filters forward only provider-supported scalar keys', async () => {
  let requestUrl;
  const plugin = loadPlugin(async url => {
    requestUrl = new URL(url);
    return apiResponse([{ id: 55, title_en: 'Filtered series' }], { page: 1, page_count: 1 });
  });
  await plugin.getCatalog({ catalogId: 'series', type: 'series', filters: {
    year: 2024, country: 'US', genre_id: 8, sort_by: 'newest', '__proto__': 'bad', unknown: 'discard'
  } });
  assert.equal(requestUrl.searchParams.get('year'), '2024');
  assert.equal(requestUrl.searchParams.get('country'), 'US');
  assert.equal(requestUrl.searchParams.get('genre_id'), '8');
  assert.equal(requestUrl.searchParams.get('sort_by'), 'newest');
  assert.equal(requestUrl.searchParams.has('unknown'), false);
});

test('catalog and details normalize compatible envelope and pagination aliases', async () => {
  let call = 0;
  const plugin = loadPlugin(async url => {
    call += 1;
    if (call === 1) return {
      ok: true, status: 200,
      json: async () => ({ status: 'success', data: { items: [{ id: 42, title_en: 'Wrapped list' }] },
        meta: { currentPage: 2, totalPages: 4, totalItems: 31, pageSize: 10 } })
    };
    return {
      ok: true, status: 200,
      json: async () => ({ status: 'success', data: { data: { id: 42, title_en: 'Nested detail' } } })
    };
  });
  const page = await plugin.getCatalog({ catalogId: 'movies', type: 'movie', limit: 10 });
  assert.equal(page.items[0].nativeId, 'movie:42');
  assert.equal(page.page.nextCursor, '3');
  assert.equal(page.page.total, 31);
  const detail = await plugin.getDetails({ id: 'movie:42' });
  assert.equal(detail.item.nativeId, 'movie:42');
  assert.equal(detail.item.title, 'Nested detail');
});

test('API client retries transient 502/503/504 responses but never retries 403', async () => {
  let transientCalls = 0;
  const transient = loadPlugin(async () => {
    transientCalls += 1;
    if (transientCalls < 3) return { ok: false, status: transientCalls === 1 ? 503 : 502, json: async () => ({}) };
    return apiResponse([{ id: 9, title_en: 'Recovered' }], { page: 1, page_count: 1 });
  });
  const recovered = await transient.getCatalog({ catalogId: 'movies', type: 'movie' });
  assert.equal(recovered.items[0].nativeId, 'movie:9');
  assert.equal(transientCalls, 3);

  let deniedCalls = 0;
  const denied = loadPlugin(async () => { deniedCalls += 1; return { ok: false, status: 403, json: async () => ({}) }; });
  await assert.rejects(denied.getCatalog({ catalogId: 'movies', type: 'movie' }), /HTTP 403/);
  assert.equal(deniedCalls, 1);
});

test('API client applies a bounded server Date offset to subsequent signatures', async () => {
  let calls = 0;
  let secondTimestamp;
  const targetTime = Math.floor(Date.now() / 1000) + 120;
  const date = new Date(targetTime * 1000).toUTCString();
  const plugin = loadPlugin(async (url, options) => {
    calls += 1;
    if (calls === 1) return {
      ok: false, status: 503,
      headers: { get: key => String(key).toLowerCase() === 'date' ? date : null },
      json: async () => ({})
    };
    secondTimestamp = Number(options.headers['X-Iron-Ts']);
    return apiResponse([{ id: 10, title_en: 'Clock corrected' }], { page: 1, page_count: 1 });
  });
  await plugin.getCatalog({ catalogId: 'movies', type: 'movie' });
  assert.equal(calls, 2);
  assert.ok(Math.abs(secondTimestamp - targetTime) <= 1);
  assert.ok(Math.abs(plugin.__test.clockOffset() - (targetTime - Math.floor(Date.now() / 1000))) <= 1);
});
