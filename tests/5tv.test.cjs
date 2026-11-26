const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'plugins', '5tv', '5tv.js');
const manifestPath = path.join(root, 'plugins', '5tv', 'manifest.json');
const fixtureDir = path.join(__dirname, 'fixtures', '5tv');
const script = fs.readFileSync(scriptPath, 'utf8');
const fixture = name => fs.readFileSync(path.join(fixtureDir, name), 'utf8');
const homeCatalogs = [
  ['korean-drama', 'series', 'الدراما الكورية'],
  ['chinese-drama', 'series', 'الدراما الصينية'],
  ['japanese-drama', 'series', 'الدراما اليابانية'],
  ['foreign-movies', 'movie', 'الأفلام الأجنبية'],
  ['korean-movies', 'movie', 'الأفلام الكورية'],
  ['asian-programs', 'series', 'البرامج الآسيوية'],
  ['anime-series', 'series', 'مسلسلات الأنمي'],
];
const catalogPaths = {
  'korean-drama': '/category/%D8%A7%D9%84%D8%AF%D8%B1%D8%A7%D9%85%D8%A7-%D8%A7%D9%84%D9%83%D9%88%D8%B1%D9%8A%D8%A9/',
  'chinese-drama': '/category/%D8%A7%D9%84%D8%AF%D8%B1%D8%A7%D9%85%D8%A7-%D8%A7%D9%84%D8%B5%D9%8A%D9%86%D9%8A%D8%A9/',
  'japanese-drama': '/category/%D8%A7%D9%84%D8%AF%D8%B1%D8%A7%D9%85%D8%A7-%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86%D9%8A%D8%A9/',
  'foreign-movies': '/category/%D8%A7%D9%84%D8%A3%D9%81%D9%84%D8%A7%D9%85-%D8%A7%D9%84%D8%A3%D8%AC%D9%86%D8%A8%D9%8A%D8%A9/',
  'korean-movies': '/category/%D8%A7%D9%84%D8%A3%D9%81%D9%84%D8%A7%D9%85-%D8%A7%D9%84%D9%83%D9%88%D8%B1%D9%8A%D8%A9/',
  'asian-programs': '/category/%D8%A7%D9%84%D8%A8%D8%B1%D8%A7%D9%85%D8%AC-%D8%A7%D9%84%D8%A3%D8%B3%D9%8A%D9%88%D9%8A%D8%A9/',
  'anime-series': '/category/%D8%A3%D9%86%D9%85%D9%8A/',
};
function homeRoutes() {
  return Object.fromEntries(homeCatalogs.map(([id, type]) => [
    `https://5tv.rest${catalogPaths[id]}`, type === 'movie' ? fixture('catalog.html') : fixture('tax-catalog.html'),
  ]));
}

function htmlResponse(body, url, status = 200) {
  return { ok: status >= 200 && status < 300, status, url, async text() { return body; } };
}

function loadPlugin(routes = {}, extra = {}) {
  const calls = [];
  const diagnostics = [];
  const context = {
    module: { exports: {} }, exports: {}, console, Date, Promise, JSON, Object, Array, Math,
    Number, String, RegExp, Error, isFinite, encodeURIComponent, decodeURIComponent,
    __YUME_5TV_TESTING__: true,
    __yume_diagnostic(value) { diagnostics.push(JSON.parse(value)); },
    async fetch(url, options = {}) {
      calls.push({ url, options });
      const route = routes[url];
      if (!route) throw new Error(`unexpected route ${url}`);
      const value = await (typeof route === 'function' ? route(url, options) : route);
      return htmlResponse(value.body || value, value.url || url, value.status || 200);
    },
    ...extra,
  };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: scriptPath });
  return { plugin: context.module.exports, calls, diagnostics };
}

test('manifest declares an isolated API v2 release candidate with stable catalogs', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.apiVersion, 2);
  assert.equal(manifest.version, '0.2.0-rc.3');
  assert.equal(manifest.scrapers.length, 1);
  const source = manifest.scrapers[0];
  assert.equal(source.id, '5tv');
  assert.equal(source.pluginId, '5tv');
  assert.equal(source.autoInstall, false);
  assert.deepEqual(source.capabilities, ['home', 'search', 'details', 'streams']);
  assert.ok(!source.catalogs.some(row => row.id === 'latest-episodes'));
  assert.deepEqual(source.catalogs.filter(row => row.capabilities.includes('home')).map(row => [row.id, row.type, row.title]), homeCatalogs);
  assert.ok(source.catalogs.filter(row => row.capabilities.includes('home')).every(row => row.presentation.posterShape === 'portrait'));
  assert.ok(!source.catalogs.some(row => ['latest-series', 'latest-movies', 'upcoming-series', 'korean-picks', 'romance-series', 'asian-drama'].includes(row.id)));
  assert.ok(source.catalogs.some(row => row.id === 'discover-movies' && row.filters.every(filter => filter.dynamic)));
  assert.ok(source.catalogs.some(row => row.id === 'discover-series' && row.filters.every(filter => filter.dynamic)));
});

test('native identities are reversible, source-scoped, and separate all kinds', () => {
  const { plugin } = loadPlugin();
  assert.deepEqual({ ...plugin.__test.parseId('5tv:movie:home-alone-1990') }, { kind: 'm', slug: 'home-alone-1990' });
  assert.deepEqual({ ...plugin.__test.parseId('5tv:series:هجوم-العمالقة') }, { kind: 's', slug: 'هجوم-العمالقة' });
  assert.deepEqual({ ...plugin.__test.parseId('5tv:episode:show-2x16') }, { kind: 'e', slug: 'show-2x16' });
  assert.deepEqual({ ...plugin.__test.parseId('5tv:series:episode@show-2x16') }, { kind: 'a', slug: 'show-2x16' });
  assert.throws(() => plugin.__test.parseId('5tv:series:bad id'), /INVALID_NATIVE_ID/);
  assert.throws(() => plugin.__test.parseId('5tv:s:legacy-id'), /INVALID_NATIVE_ID/);
});

test('URL policy accepts only exact public 5tv content URLs', () => {
  const { plugin } = loadPlugin();
  assert.deepEqual({ ...plugin.__test.pathParts('https://5tv.rest/movie/home-alone-1990/') }, { kind: 'movie', slug: 'home-alone-1990' });
  assert.equal(plugin.__test.pathParts('https://evil.example/movie/home-alone-1990/'), null);
  assert.equal(plugin.__test.pathParts('http://5tv.rest/movie/home-alone-1990/'), null);
  assert.equal(plugin.__test.pathParts('https://5tv.rest/wp-admin/'), null);
});

test('access verification pages are classified explicitly without attempting a bypass', async () => {
  const body = '<html><title>Just a moment...</title><body>Please wait while your request is being verified...</body></html>';
  const url = `https://5tv.rest${catalogPaths['korean-drama']}`;
  const { plugin, diagnostics } = loadPlugin({ [url]: body });
  assert.equal(plugin.__test.isVerificationPage(body), true);
  await assert.rejects(() => plugin.getCatalog({ catalogId: 'korean-drama', type: 'series' }), /ACCESS_VERIFICATION_REQUIRED/);
  assert.equal(diagnostics.at(-1).failureCode, 'ACCESS_VERIFICATION_REQUIRED');
});

test('Home loads exactly the seven ordered taxonomy catalogs with portrait-ready typed cards', async () => {
  const { plugin, calls } = loadPlugin(homeRoutes());
  const result = await plugin.getHome();
  assert.deepEqual(Array.from(result.sections, row => [row.id, row.title]), homeCatalogs.map(([id, , title]) => [id, title]));
  assert.equal(calls.length, 7);
  assert.ok(!result.sections.some(section => section.id === 'latest-episodes'));
  assert.ok(!result.sections.some(section => ['upcoming-series', 'latest-series', 'latest-movies', 'korean-picks', 'romance-series', 'asian-drama'].includes(section.id)));
  assert.ok(result.sections.every((section, index) => section.items.every(item => item.type === homeCatalogs[index][1] && item.poster)));
  assert.ok(result.sections.flatMap(section => section.items).every(item => {
    const parts = item.nativeId.split(':', 3);
    return parts.length === 3 && parts[0] === '5tv' && parts[1] === item.type && parts[2];
  }), 'every Home card must pass YumeTV source:type:id detail routing');
});

test('Home bounds taxonomy concurrency and isolates one failed catalog', async () => {
  let active = 0;
  let maxActive = 0;
  const routes = homeRoutes();
  Object.keys(routes).forEach(url => {
    const body = routes[url];
    routes[url] = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return url.includes(catalogPaths['chinese-drama']) ? { body: '<html></html>', status: 404 } : body;
    };
  });
  const { plugin, calls, diagnostics } = loadPlugin(routes);
  const result = await plugin.getHome();
  assert.equal(calls.length, 7);
  assert.ok(maxActive <= 4);
  assert.equal(result.sections.length, 6);
  assert.ok(!result.sections.some(section => section.id === 'chinese-drama'));
  assert.ok(diagnostics.some(event => event.stage === 'home_catalog_failed'));
});

test('The Detox Project details use the host-compatible series identity and expose six episodes', async () => {
  const url = 'https://5tv.rest/series/%D9%85%D8%B4%D8%B1%D9%88%D8%B9-%D8%A5%D8%B2%D8%A7%D9%84%D8%A9-%D8%A7%D9%84%D8%B3%D9%85%D9%88%D9%85-the-detox-project/';
  const id = '5tv:series:مشروع-إزالة-السموم-the-detox-project';
  const detox = fixture('series.html')
    .replaceAll('Attack on Titan', 'مشروع إزالة السموم The Detox Project')
    .replaceAll('attack-on-titan', 'مشروع-إزالة-السموم-the-detox-project');
  const { plugin } = loadPlugin({ [url]: detox });
  const result = await plugin.getDetails({ id });
  assert.equal(result.item.nativeId, id);
  assert.equal(result.item.type, 'series');
  assert.ok(result.item.description);
  assert.ok(result.episodes.length >= 4);
  assert.ok(result.episodes.every(episode => episode.nativeId.startsWith('5tv:episode:')));
});

test('search encodes the query and separates movies from series', async () => {
  const encoded = 'https://5tv.rest/search/?q=home%20alone%20%26%20family';
  const { plugin, calls } = loadPlugin({ [encoded]: fixture('search.html') });
  const movies = await plugin.search({ query: 'home alone & family', groupId: 'movies' });
  assert.equal(movies.items.length, 6);
  assert.ok(movies.items.every(item => item.type === 'movie'));
  assert.equal(calls[0].url, encoded);
  const empty = loadPlugin({ 'https://5tv.rest/search/?q=nothing': '<html><body><div class="ftv-search-grid"></div></body></html>' });
  assert.equal((await empty.plugin.search({ query: 'nothing', groupId: 'series' })).items.length, 0);
});

test('movie details preserve source metadata and expose parent streams', async () => {
  const url = 'https://5tv.rest/movie/home-alone-1990/';
  const { plugin } = loadPlugin({ [url]: fixture('movie.html') });
  const result = await plugin.getDetails({ id: '5tv:movie:home-alone-1990' });
  assert.equal(result.item.nativeId, '5tv:movie:home-alone-1990');
  assert.equal(result.item.type, 'movie');
  assert.equal(result.item.title, 'Home Alone 1990');
  assert.equal(result.item.year, 1990);
  assert.deepEqual(Array.from(result.item.genres), ['عائلي', 'كوميدي']);
  assert.equal(result.item.hasParentStreams, true);
});

test('series details parse explicit season panels and stable episode identities', async () => {
  const url = 'https://5tv.rest/series/attack-on-titan/';
  const { plugin } = loadPlugin({ [url]: fixture('series.html') });
  const result = await plugin.getDetails({ id: '5tv:series:attack-on-titan' });
  assert.equal(result.item.title, 'Attack on Titan');
  assert.equal(result.item.hasParentStreams, false);
  assert.deepEqual(Array.from(result.episodes, ep => `${ep.season}:${ep.episode}`), ['1:1', '1:2', '2:1', '2:2']);
  assert.equal(new Set(result.episodes.map(ep => ep.nativeId)).size, 4);
});

test('latest-episode alias follows the explicit parent link without changing requested identity', async () => {
  const episodeUrl = 'https://5tv.rest/episode/%D8%A7%D9%84%D9%85%D8%AC%D8%AF-%D9%8A%D8%AA%D9%84%D8%A7%D8%B4%D9%89-the-glory-fades-2x16/';
  const parentUrl = 'https://5tv.rest/series/%d8%a7%d9%84%d9%85%d8%ac%d8%af-%d9%8a%d8%aa%d9%84%d8%a7%d8%b4%d9%89-the-glory-fades/';
  const id = '5tv:series:episode@المجد-يتلاشى-the-glory-fades-2x16';
  const { plugin, calls } = loadPlugin({ [episodeUrl]: fixture('episode.html'), [parentUrl]: fixture('parent-series.html') });
  const result = await plugin.getDetails({ id });
  assert.equal(result.item.nativeId, id);
  assert.equal(result.item.type, 'series');
  assert.match(result.item.title, /The Glory Fades/i);
  assert.ok(result.episodes.some(ep => ep.season === 2));
  assert.deepEqual(Array.from(calls, call => call.url), [episodeUrl, parentUrl]);
});

test('Arabic, Persian, and Latin digits produce explicit episode numbers', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin.__test.normalizeDigits('الحلقة ٨'), 'الحلقة 8');
  assert.equal(plugin.__test.normalizeDigits('الحلقة ۸'), 'الحلقة 8');
  assert.equal(plugin.__test.normalizeDigits('episode 8'), 'episode 8');
});

test('stream options preserve source order, exact selected URL, and proven labels', async () => {
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const id = '5tv:movie:home-alone-1990';
  const { plugin } = loadPlugin({ [page]: fixture('movie.html') });
  const result = await plugin.getStreams({ id, mode: 'options' });
  assert.equal(result.options.length, 2);
  assert.deepEqual(Array.from(result.options, option => option.name), ['71Stream', 'Ultra4Vid']);
  const first = JSON.parse(result.options[0].token);
  const second = JSON.parse(result.options[1].token);
  assert.equal(first.url, 'https://71stream.one/embed/PD4AEWZuud');
  assert.equal(second.url, 'https://ult4vid.one/embed/7SmMlbb4jjlgbPk');
  assert.equal(first.id, id);
  assert.equal(first.page, page);
});

test('stream options include the main player and playable download choices without duplicates', () => {
  const id = '5tv:movie:sample';
  const page = 'https://5tv.rest/movie/sample/';
  const html = `
    <iframe class="ftv-player-iframe" src="https://one.example/embed/a"></iframe>
    <button class="ftv-watch-tab" data-server-url="https://one.example/embed/a"><strong>One</strong></button>
    <button class="ftv-watch-tab" data-server-url="https://two.example/embed/b"><strong>Two</strong><small>720p</small></button>
    <article class="ftv-download-server"><strong>Download One</strong><a href="https://download.example/file/a"></a></article>
    <article class="ftv-download-server"><strong>Duplicate</strong><a href="https://two.example/embed/b"></a></article>`;
  const { plugin } = loadPlugin();
  const options = plugin.__test.serverOptions(html, id, page);
  assert.equal(options.length, 3);
  assert.deepEqual(Array.from(options, option => JSON.parse(option.token).kind), ['player', 'server', 'download']);
  assert.deepEqual(Array.from(options, option => JSON.parse(option.token).url), [
    'https://one.example/embed/a', 'https://two.example/embed/b', 'https://download.example/file/a',
  ]);
  assert.equal(options[1].quality, '720p');
});

test('resolver sends only the selected option to the central extractor and preserves media headers', async () => {
  const id = '5tv:movie:home-alone-1990';
  const token = JSON.stringify({ v: 1, id, url: 'https://71stream.one/embed/PD4AEWZuud', page: 'https://5tv.rest/movie/home-alone-1990/', ordinal: 0, name: '71Stream' });
  const extractorCalls = [];
  const { plugin } = loadPlugin({}, {
    async __yume_extract_v1(raw) {
      extractorCalls.push(JSON.parse(raw));
      return JSON.stringify({ streams: [{ url: 'https://cdn.example/video/master.m3u8', type: 'hls', headers: { Referer: 'https://71stream.one/' } }] });
    },
  });
  const result = await plugin.resolveStreamOption({ id, token });
  assert.equal(extractorCalls.length, 1);
  assert.equal(extractorCalls[0].url, 'https://71stream.one/embed/PD4AEWZuud');
  assert.equal(extractorCalls[0].referrer, 'https://5tv.rest/movie/home-alone-1990/');
  assert.equal(result.streams[0].type, 'hls');
  assert.equal(result.streams[0].quality, undefined);
  assert.equal(result.streams[0].headers.Referer, 'https://71stream.one/');
});

test('resolver rejects cross-item, insecure, and malformed option tokens', async () => {
  const { plugin } = loadPlugin({}, { async __yume_extract_v1() { throw new Error('must not run'); } });
  const base = { v: 1, id: '5tv:movie:home-alone-1990', url: 'https://71stream.one/embed/x', page: 'https://5tv.rest/movie/home-alone-1990/', ordinal: 0, name: '71Stream' };
  await assert.rejects(() => plugin.resolveStreamOption({ id: '5tv:movie:other', token: JSON.stringify(base) }), /INVALID_STREAM_TOKEN/);
  await assert.rejects(() => plugin.resolveStreamOption({ id: base.id, token: JSON.stringify({ ...base, url: 'http://71stream.one/embed/x' }) }), /INVALID_STREAM_TOKEN/);
  await assert.rejects(() => plugin.resolveStreamOption({ id: base.id, token: '{bad' }), /INVALID_STREAM_TOKEN/);
});

test('pagination advances only when the next page link is present', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin.__test.hasNextPage(fixture('catalog.html'), 1), true);
  assert.equal(plugin.__test.hasNextPage('<html><body></body></html>', 1), false);
});

test('category catalogs support the verified tax-card layout', async () => {
  const url = 'https://5tv.rest/category/%D8%A3%D9%86%D9%85%D9%8A/';
  const { plugin } = loadPlugin({ [url]: fixture('tax-catalog.html') });
  const result = await plugin.getCatalog({ catalogId: 'anime-series', type: 'series' });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.type === 'series' && item.nativeId.startsWith('5tv:series:')));
  assert.equal(result.items[0].year, 2026);
  assert.equal(result.page.nextCursor, '2');
});

test('custom catalog pagination preserves taxonomy path through page three and stops at the end', async () => {
  const path = catalogPaths['korean-drama'];
  const page1 = `https://5tv.rest${path}`;
  const page2 = `https://5tv.rest${path.replace(/\/$/, '')}/page/2/`;
  const page3 = `https://5tv.rest${path.replace(/\/$/, '')}/page/3/`;
  const first = fixture('tax-catalog.html');
  const second = first.replaceAll('devils-crest', 'second-page').replaceAll('/page/2/', '/page/3/');
  const third = first.replaceAll('devils-crest', 'third-page').replace(/<a class="page-numbers"[\s\S]*$/i, '</body></html>');
  const { plugin, calls } = loadPlugin({ [page1]: first, [page2]: second, [page3]: third });
  const a = await plugin.getCatalog({ catalogId: 'korean-drama', type: 'series' });
  const b = await plugin.getCatalog({ catalogId: 'korean-drama', type: 'series', cursor: '2' });
  const c = await plugin.getCatalog({ catalogId: 'korean-drama', type: 'series', cursor: '3' });
  assert.equal(a.page.nextCursor, '2');
  assert.equal(b.page.nextCursor, '3');
  assert.equal(c.page.hasMore, false);
  assert.notEqual(a.items[0].nativeId, b.items[0].nativeId);
  assert.notEqual(b.items[0].nativeId, c.items[0].nativeId);
  assert.deepEqual(Array.from(calls, call => call.url), [page1, page2, page3]);
});

test('catalog failures distinguish HTTP errors, invalid HTML, and access verification', async () => {
  const url = `https://5tv.rest${catalogPaths['korean-drama']}`;
  await assert.rejects(() => loadPlugin({ [url]: { body: '<html></html>', status: 404 } }).plugin.getCatalog({ catalogId: 'korean-drama', type: 'series' }), /HTTP_404/);
  await assert.rejects(() => loadPlugin({ [url]: 'not html' }).plugin.getCatalog({ catalogId: 'korean-drama', type: 'series' }), /EXPECTED_HTML/);
  await assert.rejects(() => loadPlugin({ [url]: '<html>Please wait while your request is being verified</html>' }).plugin.getCatalog({ catalogId: 'korean-drama', type: 'series' }), /ACCESS_VERIFICATION_REQUIRED/);
});

test('discover filters are derived from live route shapes and reject unsupported combinations', async () => {
  const discoverUrl = 'https://5tv.rest/discover/';
  const genreUrl = 'https://5tv.rest/genre/%D8%AF%D8%B1%D8%A7%D9%85%D8%A7/';
  const genrePage2Url = 'https://5tv.rest/genre/%D8%AF%D8%B1%D8%A7%D9%85%D8%A7/page/2/';
  const { plugin, calls } = loadPlugin({
    [discoverUrl]: fixture('discover.html'),
    [genreUrl]: fixture('tax-catalog.html'),
    [genrePage2Url]: fixture('tax-catalog.html').replace('/page/2/', '/page/3/'),
  });
  const filters = await plugin.getCatalogFilters({ catalogId: 'discover-series', contentType: 'series', selectedFilters: {} });
  assert.deepEqual(Array.from(filters.filters, filter => filter.key), ['category', 'genre', 'country', 'year']);
  assert.equal(filters.filters.find(filter => filter.key === 'category').options[0].label, 'الأفلام الأجنبية');
  assert.ok(filters.filters.find(filter => filter.key === 'genre').options.some(option => option.label === 'دراما'));
  const page = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters: { genre: 'دراما' } });
  assert.ok(page.items.every(item => item.type === 'series'));
  assert.equal(calls.at(-1).url, genreUrl);
  const secondPage = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters: { genre: 'دراما' }, cursor: '2' });
  assert.equal(calls.at(-1).url, genrePage2Url);
  assert.equal(secondPage.page.nextCursor, '3');
  await assert.rejects(
    () => plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters: { genre: 'دراما', year: '2026' } }),
    /FILTER_COMBINATION_UNSUPPORTED/,
  );
});
