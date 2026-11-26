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
  assert.equal(manifest.version, '0.2.0-rc.6');
  assert.equal(manifest.scrapers[0].version, '0.2.0-rc.6');
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
  assert.deepEqual(source.catalogs.find(row => row.id === 'discover-movies').filters.map(filter => filter.key), ['category', 'genre', 'year']);
  assert.deepEqual(source.catalogs.find(row => row.id === 'discover-series').filters.map(filter => filter.key), ['category', 'genre', 'year']);
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
  assert.equal(first.objectId, 110058);
  assert.equal(first.serverId, 542395);
  assert.equal(second.serverId, 542396);
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

test('stream options reject the observed broken Send undef download without hiding valid Send links', () => {
  const id = '5tv:movie:sample';
  const page = 'https://5tv.rest/movie/sample/';
  const html = `
    <article class="ftv-download-server"><strong>Broken</strong><a href="https://send.now/undef"></a></article>
    <article class="ftv-download-server"><strong>Valid</strong><a href="https://send.now/1AbCd"></a></article>`;
  const { plugin } = loadPlugin();
  const options = plugin.__test.serverOptions(html, id, page);
  assert.equal(options.length, 1);
  assert.equal(JSON.parse(options[0].token).url, 'https://send.now/1AbCd');
});

test('resolver sends only the selected option to the central extractor and preserves media headers', async () => {
  const id = '5tv:movie:home-alone-1990';
  const token = JSON.stringify({ v: 1, id, url: 'https://one.example/embed/PD4AEWZuud', page: 'https://5tv.rest/movie/home-alone-1990/', ordinal: 0, name: 'One' });
  const extractorCalls = [];
  const { plugin } = loadPlugin({}, {
    async __yume_extract_v1(raw) {
      extractorCalls.push(JSON.parse(raw));
      return JSON.stringify({ streams: [{ url: 'https://cdn.example/video/master.m3u8', type: 'hls', headers: { Referer: 'https://71stream.one/' } }] });
    },
  });
  const result = await plugin.resolveStreamOption({ id, token });
  assert.equal(extractorCalls.length, 1);
  assert.equal(extractorCalls[0].url, 'https://one.example/embed/PD4AEWZuud');
  assert.equal(extractorCalls[0].referrer, 'https://5tv.rest/movie/home-alone-1990/');
  assert.equal(result.streams[0].type, 'hls');
  assert.equal(result.streams[0].quality, undefined);
  assert.equal(result.streams[0].headers.Referer, 'https://71stream.one/');
});

test('selected 71Stream requests a fresh signed embed URL and forwards it to the central extractor', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const embed = 'https://71stream.one/embed/PD4AEWZuud';
  const signed = `${embed}?ftv_exp=4102444800&ftv_sig=short-lived-test-signature`;
  const routes = { [page]: fixture('movie.html') };
  const extractorCalls = [];
  const { plugin, calls } = loadPlugin(routes, {
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (url.endsWith('/wp-admin/admin-ajax.php')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Origin, 'https://5tv.rest');
        assert.equal(options.headers.Referer, page);
        return htmlResponse(JSON.stringify({ success: true, data: { url: signed } }), url);
      }
      const route = routes[url];
      if (!route) throw new Error(`unexpected route ${url}`);
      return htmlResponse(route, url);
    },
    async __yume_extract_v1(raw) {
      extractorCalls.push(JSON.parse(raw));
      return JSON.stringify({ streams: [{ url: 'https://cdn.example/video.mp4', type: 'mp4' }] });
    },
  });
  const options = await plugin.getStreams({ id });
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0, 'listing options must not request or cache signatures');
  const token = options.options.map(option => JSON.parse(option.token)).find(value => value.url === embed);
  const result = await plugin.resolveStreamOption({ id, token: JSON.stringify(token) });
  const access = calls.find(call => call.options.method === 'POST');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1, 'only the selected server should be signed');
  const params = new URLSearchParams(access.options.body);
  assert.equal(access.url, 'https://5tv.rest/wp-admin/admin-ajax.php');
  assert.deepEqual([...params.entries()], [
    ['action', 'ftv_71_access_url'], ['object_id', '110058'], ['server_id', '542395'], ['server_type', 'watch'],
  ]);
  assert.equal(extractorCalls.length, 1);
  assert.equal(extractorCalls[0].url, signed);
  assert.equal(extractorCalls[0].scopeId, '5tv');
  assert.equal(result.streams[0].url, 'https://cdn.example/video.mp4');
  assert.ok(!JSON.stringify(options).includes('ftv_sig='), 'the short-lived signature must not be stored in the option token');
});

test('selected Ultra4Vid uses its page server ID and validates the signed host and path', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const changedPage = fixture('movie.html').replace('"objectId":110058', '"objectId":901234').replace('data-server-id="542396"', 'data-server-id="987654"');
  const embed = 'https://ult4vid.one/embed/7SmMlbb4jjlgbPk';
  const signed = `${embed}?ftv_exp=4102444800&ftv_sig=another-short-lived-signature`;
  const routes = { [page]: changedPage };
  const extractorCalls = [];
  const { plugin, calls } = loadPlugin(routes, {
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (options.method === 'POST') return htmlResponse(JSON.stringify({ success: true, data: { url: signed } }), url);
      return htmlResponse(routes[url], url);
    },
    async __yume_extract_v1(raw) {
      extractorCalls.push(JSON.parse(raw));
      return JSON.stringify({ streams: [{ url: 'https://cdn.example/video.mp4', type: 'mp4' }] });
    },
  });
  const options = await plugin.getStreams({ id });
  const token = options.options.map(option => JSON.parse(option.token)).find(value => value.url === embed);
  await plugin.resolveStreamOption({ id, token: JSON.stringify(token) });
  const params = new URLSearchParams(calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(params.get('object_id'), '901234');
  assert.equal(params.get('server_id'), '987654');
  assert.equal(extractorCalls[0].url, signed);
  assert.throws(() => plugin.__test.signedAccessUrl(embed, 'https://evil.example/embed/7SmMlbb4jjlgbPk?ftv_exp=4102444800&ftv_sig=x', 1), /HOST_OR_PATH_MISMATCH/);
  assert.throws(() => plugin.__test.signedAccessUrl(embed, 'https://ult4vid.one/embed/other?ftv_exp=4102444800&ftv_sig=x', 1), /HOST_OR_PATH_MISMATCH/);
});

test('71Stream and Ultra4Vid download options never request a signed watch URL', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  for (const host of ['71stream.one', 'ult4vid.one']) {
    const downloadUrl = `https://${host}/download/file.mp4`;
    const html = `${fixture('movie.html')}<article class="ftv-download-server"><strong>Download</strong><a href="${downloadUrl}"></a></article>`;
    const extractorCalls = [];
    const { plugin, calls } = loadPlugin({ [page]: html }, {
      async __yume_extract_v1(raw) {
        extractorCalls.push(JSON.parse(raw));
        return JSON.stringify({ streams: [{ url: 'https://cdn.example/file.mp4', type: 'mp4' }] });
      },
    });
    const listed = await plugin.getStreams({ id });
    const option = listed.options.find(row => JSON.parse(row.token).url === downloadUrl);
    const token = JSON.parse(option.token);
    assert.equal(token.kind, 'download');
    await plugin.resolveStreamOption({ id, token: JSON.stringify(token) });
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 0, `${host} download must not call ftv_71_access_url`);
    assert.equal(extractorCalls[0].url, downloadUrl, 'the original download URL must be passed unchanged');
  }
});

test('unplayable 71Stream and Ultra4Vid download links are not reported as video sources', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  for (const host of ['71stream.one', 'ult4vid.one']) {
    const downloadUrl = `https://${host}/download/file`;
    const html = `${fixture('movie.html')}<article class="ftv-download-server"><strong>Download</strong><a href="${downloadUrl}"></a></article>`;
    const { plugin, calls } = loadPlugin({ [page]: html }, {
      async __yume_extract_v1() { return JSON.stringify({ streams: [] }); },
    });
    const listed = await plugin.getStreams({ id });
    const option = listed.options.find(row => JSON.parse(row.token).url === downloadUrl);
    await assert.rejects(() => plugin.resolveStreamOption({ id, token: option.token }), /5TV_NO_PLAYABLE_STREAM/);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('stale rc.4 watch token refreshes metadata once and matches the current link and kind', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const embed = 'https://71stream.one/embed/PD4AEWZuud';
  const signed = `${embed}?ftv_exp=4102444800&ftv_sig=private-short-lived-value`;
  const token = { v: 1, id, url: embed, page, ordinal: 0, name: '71Stream', kind: 'server' };
  const calls = [];
  const diagnostics = [];
  const { plugin } = loadPlugin({}, {
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (options.method === 'POST') return htmlResponse(JSON.stringify({ success: true, data: { url: signed } }), url);
      if (url === page) return htmlResponse(fixture('movie.html'), url);
      throw new Error(`unexpected route ${url}`);
    },
    __yume_diagnostic(value) { diagnostics.push(JSON.parse(value)); },
    async __yume_extract_v1(raw) {
      assert.equal(JSON.parse(raw).url, signed);
      return JSON.stringify({ streams: [{ url: 'https://cdn.example/file.mp4', type: 'mp4' }] });
    },
  });
  await plugin.resolveStreamOption({ id, token: JSON.stringify(token) });
  assert.equal(calls.filter(call => call.url === page).length, 1, 'one bounded refresh fetches the current page');
  const params = new URLSearchParams(calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(params.get('object_id'), '110058');
  assert.equal(params.get('server_id'), '542395');
  const correlated = diagnostics.filter(event => event.attemptId);
  assert.ok(correlated.length >= 5);
  assert.equal(new Set(correlated.map(event => event.attemptId)).size, 1);
  assert.ok(!JSON.stringify(diagnostics).includes('private-short-lived-value'));
  assert.ok(!JSON.stringify(diagnostics).includes('ftv_sig='));
});

test('stale signed option fails specifically when link or kind cannot be matched', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const tokenBase = { v: 1, id, page, ordinal: 0, name: '71Stream', kind: 'server' };
  const { plugin: mismatchPlugin, calls: mismatchCalls } = loadPlugin({ [page]: fixture('movie.html') }, {
    async __yume_extract_v1() { return JSON.stringify({ streams: [] }); },
  });
  await assert.rejects(() => mismatchPlugin.resolveStreamOption({ id, token: JSON.stringify({ ...tokenBase, url: 'https://71stream.one/embed/no-longer-listed' }) }), /5TV_SIGNED_OPTION_REFRESH_NOT_MATCHED/);
  assert.equal(mismatchCalls.filter(call => call.options.method === 'POST').length, 0);

  const legacyToken = { ...tokenBase, kind: undefined, url: 'https://71stream.one/embed/PD4AEWZuud' };
  const { plugin: legacyPlugin, calls: legacyCalls } = loadPlugin({ [page]: fixture('movie.html') }, {
    async __yume_extract_v1() { return JSON.stringify({ streams: [] }); },
  });
  await assert.rejects(() => legacyPlugin.resolveStreamOption({ id, token: JSON.stringify(legacyToken) }), /5TV_SIGNED_OPTION_TYPE_MISSING/);
  assert.equal(legacyCalls.filter(call => call.options.method === 'POST').length, 0);
});

test('stale signed option with missing current server metadata fails before the signing request', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const currentPage = fixture('movie.html').replace('data-server-id="542395"', '');
  const token = { v: 1, id, url: 'https://71stream.one/embed/PD4AEWZuud', page, ordinal: 0, name: '71Stream', kind: 'server' };
  const { plugin, calls } = loadPlugin({ [page]: currentPage }, {
    async __yume_extract_v1() { return JSON.stringify({ streams: [] }); },
  });
  await assert.rejects(() => plugin.resolveStreamOption({ id, token: JSON.stringify(token) }), /5TV_ACCESS_METADATA_MISSING/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
});

test('movie and episode pages without server controls report NO_STREAM_OPTIONS with page context', async () => {
  const cases = [
    ['5tv:movie:missing', 'https://5tv.rest/movie/missing/'],
    ['5tv:episode:missing-1x1', 'https://5tv.rest/episode/missing-1x1/'],
  ];
  for (const [id, url] of cases) {
    const { plugin, diagnostics } = loadPlugin({ [url]: '<html><body><main>Page has no player or server blocks</main></body></html>' });
    await assert.rejects(() => plugin.getStreams({ id }), /5TV_NO_STREAM_OPTIONS/);
    const event = diagnostics.find(row => row.stage === 'stream_options_result');
    assert.equal(event.responseKind, 'html_without_options');
    assert.equal(event.sourceCount, 0);
    assert.equal(event.httpStatus, 200);
    assert.ok(event.attemptId);
  }
});

test('extractor diagnostics report safe HTTP, candidate, accepted, and rejection summaries per attempt', async () => {
  const id = '5tv:movie:home-alone-1990';
  const page = 'https://5tv.rest/movie/home-alone-1990/';
  const embed = 'https://71stream.one/embed/x';
  const token = JSON.stringify({ v: 1, id, url: embed, page, ordinal: 0, name: '71Stream', kind: 'server', objectId: 1, serverId: 2 });
  const { plugin, diagnostics } = loadPlugin({}, {
    async fetch(url) { return htmlResponse(JSON.stringify({ success: true, data: { url: `${embed}?ftv_exp=4102444800&ftv_sig=hidden` } }), url); },
    async __yume_extract_v1() {
      return JSON.stringify({ streams: [], diagnostics: [
        { stage: 'PARSE', outcome: 'CANDIDATES', candidateCount: 2 },
        { stage: 'REQUEST', outcome: 'HTTP_FAILURE', httpStatus: 403, candidateCount: 2, acceptedCount: 0, errorKind: 'HTTP_403' },
        { stage: 'VERIFY', outcome: 'EMPTY', candidateCount: 2, validCount: 0 },
      ], errorCode: 'HTTP_REFUSED' });
    },
  });
  await assert.rejects(() => plugin.resolveStreamOption({ id, token }), /NO_PLAYABLE_STREAM/);
  const event = diagnostics.find(row => row.stage === 'extractor_result');
  assert.equal(event.httpStatus, 403);
  assert.equal(event.candidateCount, 2);
  assert.equal(event.acceptedCount, 0);
  assert.equal(event.extractorStage, 'REQUEST');
  assert.equal(event.extractorOutcome, 'HTTP_FAILURE');
  assert.equal(event.extractorErrorKind, 'HTTP_403');
  assert.equal(event.failureCode, 'HTTP_REFUSED');
  assert.ok(!JSON.stringify(diagnostics).includes('ftv_sig='));
});

test('signed access rejects expired, rejected, and malformed responses without calling the extractor', async () => {
  const embed = 'https://71stream.one/embed/example';
  assert.throws(() => pluginSignedAccessForTest(embed), /ACCESS_URL_EXPIRED/);

  async function attempt(responseBody, expectedError) {
    const id = '5tv:movie:home-alone-1990';
    const page = 'https://5tv.rest/movie/home-alone-1990/';
    const token = JSON.stringify({ v: 1, id, url: embed, page, ordinal: 0, name: '71Stream', kind: 'server', objectId: 110058, serverId: 542395 });
    let extractorCalled = false;
    const { plugin } = loadPlugin({}, {
      async fetch() { return htmlResponse(responseBody, 'https://5tv.rest/wp-admin/admin-ajax.php'); },
      async __yume_extract_v1() { extractorCalled = true; return JSON.stringify({ streams: [] }); },
    });
    await assert.rejects(() => plugin.resolveStreamOption({ id, token }), expectedError);
    assert.equal(extractorCalled, false);
  }
  await attempt(JSON.stringify({ success: false, data: { url: '' } }), /ACCESS_URL_REJECTED/);
  await attempt('not-json', /ACCESS_URL_INVALID_JSON/);
  await attempt(JSON.stringify({ success: true, data: { url: `${embed}?ftv_exp=1&ftv_sig=expired` } }), /ACCESS_URL_EXPIRED/);
});

function pluginSignedAccessForTest(embed) {
  const { plugin } = loadPlugin();
  return plugin.__test.signedAccessUrl(embed, `${embed}?ftv_exp=1&ftv_sig=expired`, 2);
}

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

test('advanced discover filters come from the real search form and are type specific', async () => {
  const searchUrl = 'https://5tv.rest/search/';
  const { plugin } = loadPlugin({ [searchUrl]: fixture('discover.html') });
  const series = await plugin.getCatalogFilters({ catalogId: 'discover-series', contentType: 'series', selectedFilters: {} });
  const movies = await plugin.getCatalogFilters({ catalogId: 'discover-movies', contentType: 'movie', selectedFilters: {} });
  assert.deepEqual(Array.from(series.filters, filter => filter.key), ['category', 'genre', 'year']);
  assert.deepEqual(Array.from(movies.filters, filter => filter.key), ['category', 'genre', 'year']);
  const seriesCategories = series.filters.find(filter => filter.key === 'category').options;
  const movieCategories = movies.filters.find(filter => filter.key === 'category').options;
  assert.ok(seriesCategories.some(option => option.label === 'الدراما الكورية'));
  assert.ok(seriesCategories.some(option => option.label === 'البرامج الأسيوية'));
  assert.ok(seriesCategories.some(option => option.label === 'أنمي'));
  assert.ok(seriesCategories.every(option => !option.label.startsWith('الأفلام ')));
  assert.ok(movieCategories.some(option => option.label === 'الأفلام الأجنبية'));
  assert.ok(movieCategories.every(option => option.label.startsWith('الأفلام ')));
  assert.ok(!seriesCategories.some(option => option.label === 'اسيوي'));
  assert.ok(!movieCategories.some(option => option.label === 'اسيوي'));
  assert.ok(!series.filters.find(filter => filter.key === 'genre').options.some(option => option.label === 'فيلم تلفزيوني'));
  assert.ok(!movies.filters.find(filter => filter.key === 'genre').options.some(option => option.label === 'مسلسل يومي'));
  assert.deepEqual(Array.from(series.filters.find(filter => filter.key === 'year').options, option => [option.value, option.label]), [['11', '2026'], ['79', '2025']]);
});

function filteredSearchPage(body, nextPage) {
  const withoutPager = body.replace(/<a\b[^>]*class=["'][^"']*page-numbers[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '');
  const pager = nextPage == null ? '' : `<a class="next page-numbers" href="https://www.5tv.rest/search/?q=&amp;category%5B0%5D=15&amp;genre%5B0%5D=23&amp;ftv_year_filter%5B0%5D=79&amp;pg=${nextPage}">التالي</a>`;
  return withoutPager.replace('</body>', `${pager}</body>`);
}

test('advanced discover combines filters and preserves them through pages one, two, and three', async () => {
  const routes = {};
  const { plugin, calls } = loadPlugin(routes);
  const filters = { category: '15', genre: '23', year: '79' };
  const urls = [1, 2, 3].map(page => `https://5tv.rest${plugin.__test.discoverSearchPath('series', filters, page)}`);
  routes[urls[0]] = filteredSearchPage(fixture('tax-catalog.html'), 2);
  routes[urls[1]] = filteredSearchPage(fixture('tax-catalog.html').replaceAll('devils-crest', 'second-page'), 3);
  routes[urls[2]] = filteredSearchPage(fixture('tax-catalog.html').replaceAll('devils-crest', 'third-page'), null);
  const first = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters });
  const second = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters, cursor: '2' });
  const third = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters, cursor: '3' });
  assert.deepEqual(Array.from(calls, call => call.url), urls);
  assert.ok(urls[0].includes('category%5B%5D=15') && urls[0].includes('genre%5B%5D=23') && urls[0].includes('ftv_year_filter%5B%5D=79'));
  assert.ok(!urls[0].includes('pg='));
  assert.ok(urls[1].endsWith('&pg=2'));
  assert.ok(urls[2].endsWith('&pg=3'));
  assert.equal(first.page.nextCursor, '2');
  assert.equal(second.page.nextCursor, '3');
  assert.equal(third.page.hasMore, false);
  assert.ok(first.items.every(item => item.type === 'series'));
  assert.notEqual(first.items[0].nativeId, second.items[0].nativeId);
  assert.notEqual(second.items[0].nativeId, third.items[0].nativeId);
});

test('genre or year-only discover requests inject all categories for the selected content type', () => {
  const { plugin } = loadPlugin();
  const moviePath = plugin.__test.discoverSearchPath('movie', { genre: '6', year: '74' }, 1);
  const seriesPath = plugin.__test.discoverSearchPath('series', { genre: '25', year: '11' }, 2);
  const movieCategories = new URL(`https://5tv.rest${moviePath}`).searchParams.getAll('category[]');
  const seriesCategories = new URL(`https://5tv.rest${seriesPath}`).searchParams.getAll('category[]');
  assert.ok(movieCategories.includes('88'));
  assert.ok(movieCategories.includes('68'));
  assert.ok(!movieCategories.includes('15'));
  assert.ok(seriesCategories.includes('15'));
  assert.ok(seriesCategories.includes('174'));
  assert.ok(!seriesCategories.includes('88'));
  assert.ok(seriesPath.includes('genre%5B%5D=25'));
  assert.ok(seriesPath.includes('ftv_year_filter%5B%5D=11'));
  assert.ok(seriesPath.endsWith('&pg=2'));
});

test('every visible filter option is forwarded under the matching live form field', () => {
  const { plugin } = loadPlugin();
  const html = fixture('discover.html');
  for (const type of ['movie', 'series']) {
    const filters = plugin.__test.categoryOptions(html, type);
    const genres = plugin.__test.searchFormOptions(html, 'genre').filter(option =>
      type === 'movie' ? option.label !== 'مسلسل يومي' : option.label !== 'فيلم تلفزيوني',
    );
    const years = plugin.__test.searchFormOptions(html, 'ftv_year_filter');
    for (const option of filters) {
      const params = new URL(`https://5tv.rest${plugin.__test.discoverSearchPath(type, { category: option.value }, 1)}`).searchParams;
      assert.deepEqual(params.getAll('category[]'), [option.value]);
    }
    for (const option of genres) {
      const params = new URL(`https://5tv.rest${plugin.__test.discoverSearchPath(type, { genre: option.value }, 1)}`).searchParams;
      assert.deepEqual(params.getAll('genre[]'), [option.value]);
      assert.ok(params.getAll('category[]').length > 0);
    }
    for (const option of years) {
      const params = new URL(`https://5tv.rest${plugin.__test.discoverSearchPath(type, { year: option.value }, 1)}`).searchParams;
      assert.deepEqual(params.getAll('ftv_year_filter[]'), [option.value]);
      assert.ok(params.getAll('category[]').length > 0);
    }
  }
});

test('search pagination parser recognizes the actual pg query links', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin.__test.hasNextPage('<a class="page-numbers" href="https://www.5tv.rest/search/?q&amp;genre%5B0%5D=23&amp;pg=2">2</a>', 1), true);
  assert.equal(plugin.__test.hasNextPage('<a class="page-numbers" href="https://www.5tv.rest/search/?q&amp;genre%5B0%5D=23&amp;pg=3">3</a>', 1), false);
});

test('an incompatible category is cleared without a technical combination error', async () => {
  const url = 'https://5tv.rest/latest-series/';
  const { plugin, calls } = loadPlugin({ [url]: filteredSearchPage(fixture('tax-catalog.html'), null) });
  const result = await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters: { category: '88' } });
  assert.equal(calls[0].url, url);
  assert.ok(result.items.every(item => item.type === 'series'));
  assert.equal(result.page.hasMore, false);
});

test('empty filtered results are successful while network failures remain errors', async () => {
  const routes = {};
  const { plugin } = loadPlugin(routes);
  const filters = { category: '68', genre: '25' };
  const url = `https://5tv.rest${plugin.__test.discoverSearchPath('movie', filters, 1)}`;
  routes[url] = '<html><body><div class="ftv-search-empty">لا توجد نتائج مطابقة</div></body></html>';
  const empty = await plugin.getCatalog({ catalogId: 'discover-movies', type: 'movie', filters });
  assert.deepEqual(Array.from(empty.items), []);
  assert.equal(empty.page.hasMore, false);
  const failed = loadPlugin().plugin;
  await assert.rejects(() => failed.getCatalog({ catalogId: 'discover-movies', type: 'movie', filters }), /NETWORK_ERROR/);
});
