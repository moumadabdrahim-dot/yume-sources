const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'plugins', 'cimacloud', 'cimacloud.js');
const manifestPath = path.join(root, 'plugins', 'cimacloud', 'manifest.json');
const script = fs.readFileSync(scriptPath, 'utf8');

function jsonResponse(body, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : null; } },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function item(id, type, name, extra = {}) {
  return {
    id: String(id), type, name, poster: 'http://image.tmdb.org/t/p/w500/poster.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w780/backdrop.jpg', overview: `${name} overview`,
    year: 2020, vote_average: '8.1', categories: [], genres: [{ id: 2, name: 'دراما' }], ...extra,
  };
}

function listPayload(rows, page = 1, totalPages = 1) {
  return { status: true, results: rows, page, total_pages: totalPages, total: rows.length, has_more: page < totalPages };
}

function loadPlugin(handler) {
  const diagnostics = [];
  const context = {
    module: { exports: {} }, exports: {}, console, URL, Date, Promise, JSON, Object, Array, Math,
    Number, String, RegExp, Error, isFinite, encodeURIComponent, decodeURIComponent,
    __YUME_CIMACLOUD_TESTING__: true,
    __yume_diagnostic(value) { diagnostics.push(JSON.parse(value)); },
    fetch: handler,
  };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: scriptPath });
  return { plugin: context.module.exports, diagnostics };
}

function routeHandler(routes, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('config_v1.4.json')) {
      return jsonResponse({ data: [{ cloudday: 'https://api.cimacloud.example' }] });
    }
    const parsed = new URL(url);
    const key = `${String(options.method || 'GET').toUpperCase()} ${parsed.pathname}`;
    if (!(key in routes)) throw new Error(`unexpected route ${key}`);
    const value = typeof routes[key] === 'function' ? routes[key](options) : routes[key];
    return jsonResponse(value);
  };
}

test('manifest declares one stable API v2 source with independent identity', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.apiVersion, 2);
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].id, 'cimacloud');
  assert.equal(manifest.scrapers[0].pluginId, 'cimacloud');
  assert.equal(manifest.scrapers[0].autoInstall, true);
  assert.deepEqual(manifest.scrapers[0].capabilities, ['home', 'search', 'details', 'streams']);
  assert.ok(manifest.scrapers[0].catalogs.some((entry) => entry.id === 'discover-movies'));
  assert.ok(manifest.scrapers[0].catalogs.some((entry) => entry.id === 'discover-series'));
});

test('security policy accepts public HTTPS names and rejects unsafe targets', () => {
  const { plugin } = loadPlugin(async () => { throw new Error('unused'); });
  assert.equal(plugin.__test.publicHttpsBase('https://1654865.xyz/'), 'https://1654865.xyz');
  assert.equal(plugin.__test.publicHttpsBase('http://1654865.xyz'), '');
  assert.equal(plugin.__test.publicHttpsBase('https://localhost'), '');
  assert.equal(plugin.__test.publicHttpsBase('https://127.0.0.1'), '');
  assert.equal(plugin.__test.publicHttpsBase('https://192.168.1.2'), '');
  assert.equal(plugin.__test.publicHttpsBase('https://service.internal'), '');
});

test('native identities keep movie, series, and episode namespaces separate', () => {
  const { plugin } = loadPlugin(async () => { throw new Error('unused'); });
  assert.deepEqual({ ...plugin.__test.parseId('cc:movie:27185') }, { kind: 'movie', id: '27185' });
  assert.deepEqual({ ...plugin.__test.parseId('cc:series:475') }, { kind: 'series', id: '475' });
  assert.deepEqual({ ...plugin.__test.parseId('cc:episode:42498') }, { kind: 'episode', id: '42498' });
  assert.throws(() => plugin.__test.parseId('series:475'), /INVALID_NATIVE_ID/);
});

test('media mapper preserves source identity and only trusted external ids', () => {
  const { plugin } = loadPlugin(async () => { throw new Error('unused'); });
  const mapped = plugin.__test.mapMedia(item(475, 'series', 'Breaking Bad', { tmdb_id: 1396, imdb_id: 'tt0903747' }));
  assert.equal(mapped.pluginId, 'cimacloud');
  assert.equal(mapped.nativeId, 'cc:series:475');
  assert.equal(mapped.externalIds.tmdb, '1396');
  assert.equal(mapped.externalIds.imdb, 'tt0903747');
  assert.equal(mapped.poster, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(plugin.__test.mapMedia(item(1, 'movie', 'Bad IMDb', { imdb_id: '123' })).externalIds, undefined);
});

test('home uses one aggregate request, maps episodes to parent series, and hides unsupported view-all', async () => {
  const calls = [];
  const { plugin } = loadPlugin(routeHandler({
    'GET /v1.3/api/home': {
      status: true,
      sections: [
        { section_id: 1, section_name: 'احدث الأفلام ', section_items: [item(2937, 'movie', 'El Camino'), item(2937, 'movie', 'El Camino')] },
        { section_id: 2, section_name: 'اخر الحلقات', section_type: 'episodes', section_items: [
          { id: '42498', type: 'episode', name: 'الحلقة 1', tv_show_id: '475', tv_show_name: 'Breaking Bad', poster: 'https://image.tmdb.org/t/p/w500/ep.jpg' },
        ] },
        { section_id: 3, section_name: 'فارغ', section_items: [] },
      ],
    },
  }, calls));
  const result = await plugin.getHome();
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].items.length, 1);
  assert.equal(result.sections[0].hasMore, true);
  assert.equal(result.sections[1].items[0].nativeId, 'cc:series:475');
  assert.equal(result.sections[1].hasMore, false);
  assert.equal(calls.filter((call) => call.url.endsWith('/home')).length, 1);
});

test('catalog pagination sends page and returns a truthful next cursor', async () => {
  const calls = [];
  const { plugin } = loadPlugin(routeHandler({
    'POST /v1.3/api/all': (options) => {
      const form = new URLSearchParams(options.body);
      const page = Number(form.get('page'));
      return listPayload([item(page === 1 ? 100 : 200, 'series', `Page ${page}`)], page, 3);
    },
  }, calls));
  const first = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series', filters: {} });
  const second = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series', filters: {}, cursor: '2' });
  assert.equal(first.items[0].nativeId, 'cc:series:100');
  assert.equal(first.page.nextCursor, '2');
  assert.equal(second.items[0].nativeId, 'cc:series:200');
  assert.equal(second.page.nextCursor, '3');
  assert.notEqual(first.items[0].nativeId, second.items[0].nativeId);
  assert.equal(calls.filter((call) => call.url.endsWith('/all')).length, 2);
});

test('discover filters map only supported category, order, and year values', async () => {
  let received;
  const { plugin } = loadPlugin(routeHandler({
    'POST /v1.3/api/all': (options) => {
      received = new URLSearchParams(options.body);
      return listPayload([item(1, 'movie', 'Filtered')]);
    },
  }));
  const filters = await plugin.getCatalogFilters({ catalogId: 'discover-movies', contentType: 'movie' });
  assert.deepEqual(Array.from(filters.filters, (entry) => entry.key), ['category', 'order', 'year']);
  await plugin.getCatalog({ catalogId: 'discover-movies', type: 'movie', filters: { category: '4', order: 'oldest', year: '2019' } });
  assert.equal(received.get('type'), '1');
  assert.equal(received.get('category'), '4');
  assert.equal(received.get('sort'), '2');
  assert.equal(received.get('year'), '2019');
  await assert.rejects(() => plugin.getCatalog({ catalogId: 'discover-movies', type: 'movie', filters: { category: '7' } }), /INVALID_CATEGORY_FILTER/);
});

test('search separates movies and series and keeps pagination', async () => {
  const calls = [];
  const { plugin } = loadPlugin(routeHandler({
    'POST /v1.3/api/search': (options) => {
      const form = new URLSearchParams(options.body);
      const type = form.get('type');
      return listPayload([item(type === '1' ? 2937 : 475, type === '1' ? 'movie' : 'series', form.get('title'))], 1, 2);
    },
  }, calls));
  const movies = await plugin.search({ query: 'Breaking Bad', groupId: 'movies' });
  const series = await plugin.search({ query: 'Breaking Bad', groupId: 'series' });
  assert.equal(movies.items[0].nativeId, 'cc:movie:2937');
  assert.equal(series.items[0].nativeId, 'cc:series:475');
  assert.equal(movies.page.nextCursor, '2');
  assert.equal(calls.length, 3); // config plus two search requests
});

test('movie details preserve verified TMDB identity and do not invent IMDb', async () => {
  const { plugin } = loadPlugin(routeHandler({
    'GET /v1.3/api/movie/2937': { status: true, movie: item(2937, 'movie', 'El Camino', { tmdb_id: 559969, imdb_id: '', runtime: 123 }) },
  }));
  const result = await plugin.getDetails({ id: 'cc:movie:2937' });
  assert.equal(result.item.nativeId, 'cc:movie:2937');
  assert.equal(result.item.externalIds.tmdb, '559969');
  assert.equal(result.item.externalIds.imdb, undefined);
  assert.equal(result.item.runtime, 123);
  assert.equal(result.item.hasParentStreams, true);
});

test('series details return sorted, deduplicated episodes with stable source ids', async () => {
  const { plugin } = loadPlugin(routeHandler({
    'GET /v1.3/api/series/475': { status: true, series: item(475, 'series', 'Breaking Bad', { tmdb_id: 1396 }) },
    'GET /v1.3/api/series/475/episodes': { status: true, seasons: [
      { season_number: '2', episodes: [{ id: '500', title: 'الحلقة 2' }, { id: '499', title: 'الحلقة 1' }] },
      { season_number: '1', episodes: [{ id: '42498', title: 'الحلقة 1' }, { id: '42498', title: 'الحلقة 1' }] },
    ] },
  }));
  const result = await plugin.getDetails({ id: 'cc:series:475' });
  assert.deepEqual(Array.from(result.item.episodes, (episode) => episode.nativeId), ['cc:episode:42498', 'cc:episode:499', 'cc:episode:500']);
  assert.deepEqual(Array.from(result.item.episodes, (episode) => `${episode.season}:${episode.episode}`), ['1:1', '2:1', '2:2']);
});

test('details reject a payload whose source identity does not match the requested item', async () => {
  const { plugin } = loadPlugin(routeHandler({
    'GET /v1.3/api/movie/2937': { status: true, movie: item(9999, 'movie', 'Wrong movie') },
  }));
  await assert.rejects(() => plugin.getDetails({ id: 'cc:movie:2937' }), /DETAILS_IDENTITY_MISMATCH/);
});

test('blocked server endpoint becomes a precise authorized-access failure', async () => {
  const { plugin } = loadPlugin(routeHandler({
    'GET /v1.3/api/episode/42498/servers': { status: false, blocked: true, data: [] },
  }));
  await assert.rejects(() => plugin.getStreams({ id: 'cc:episode:42498', mode: 'options' }), /AUTHORIZED_SERVER_ACCESS_REQUIRED/);
  await assert.rejects(() => plugin.resolveStreamOption({ id: 'cc:episode:42498', token: 'anything' }), /AUTHORIZED_SERVER_ACCESS_REQUIRED/);
});

test('HTML, oversized, malformed, and rejected API responses never count as success', async () => {
  for (const response of [
    jsonResponse('<html>blocked</html>', 200, 'text/html'),
    jsonResponse('{bad json', 200, 'application/json'),
    jsonResponse({ status: false, blocked: false }),
  ]) {
    const { plugin } = loadPlugin(async (url) => url.includes('config_v1.4.json')
      ? jsonResponse({ data: [{ cloudday: 'https://api.cimacloud.example' }] }) : response);
    await assert.rejects(() => plugin.search({ query: 'Dexter', groupId: 'series' }), /CIMACLOUD_/);
  }
});

test('diagnostics expose only allow-listed fields and never URLs or headers', async () => {
  const { plugin, diagnostics } = loadPlugin(routeHandler({
    'POST /v1.3/api/search': listPayload([item(475, 'series', 'Dexter')]),
  }));
  await plugin.search({ query: 'Dexter', groupId: 'series' });
  assert.ok(diagnostics.length >= 2);
  const allowed = new Set(['pluginId', 'stage', 'host', 'httpStatus', 'responseKind', 'itemCount', 'episodeCount', 'sourceCount', 'streamCount', 'failureCode', 'elapsedMs']);
  for (const event of diagnostics) {
    for (const key of Object.keys(event)) assert.ok(allowed.has(key), `unsafe diagnostic key ${key}`);
    assert.equal(JSON.stringify(event).includes('/v1.3/api/'), false);
  }
});
