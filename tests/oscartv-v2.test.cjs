const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins/oscartv-v2.js'), 'utf8');
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
    Utf8: { parse: value => wordArray(Buffer.from(String(value), 'utf8')) },
    Hex: { stringify: value => bytesOf(value).toString('hex') }
  },
  lib: { WordArray: {
    create: (words, size) => wordArray(Buffer.isBuffer(words) ? words.subarray(0, size) : Array.from({ length: size }, (_, i) => (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255)),
    random: size => wordArray(Buffer.from(Array.from({ length: size }, (_, i) => i + 1)))
  } },
  SHA256: value => wordArray(crypto.createHash('sha256').update(bytesOf(value)).digest()),
  HmacSHA256: (message, key) => wordArray(crypto.createHmac('sha256', bytesOf(key)).update(Buffer.from(String(message))).digest())
};
function loadPlugin(fetchImpl) {
  const module = { exports: {} };
  const context = { module, exports: module.exports, CryptoJS, __YUME_OSCAR_TESTING__: true, fetch: fetchImpl,
    console, Date, URL, TextEncoder, Uint8Array, ArrayBuffer, isFinite, encodeURIComponent, decodeURIComponent };
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

test('v2 exports catalog/details/streams and preserves the deterministic Iron signer', () => {
  const plugin = loadPlugin(async () => { throw new Error('unexpected network'); });
  const vector = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/iron-signer.json'), 'utf8'));
  const [pathPart, timestamp, nonce] = vector.source.split('|');
  assert.equal(plugin.getHome, undefined);
  assert.equal(plugin.search, undefined);
  assert.equal(typeof plugin.getCatalog, 'function');
  assert.equal(plugin.__test.sign(pathPart, timestamp, nonce), vector.expectedSignature);
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
  assert.ok(requests.every(({ options }) => options.headers['X-Iron-Sig'] && options.headers['X-Iron-Ts'] && options.headers['X-Iron-Nonce']));
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
  assert.equal(requests[0].options.headers.Range, 'bytes=0-65535');
  assert.equal(requests[1].options.headers.Referer, 'https://newcdn.seriesmp4.com/watch/1');
  assert.equal(requests[1].options.headers.Range, 'bytes=0-65535');
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
    if (url.hostname === 'ostvapp.cam') {
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
  assert.equal(streams[0].headers.Referer, wrapper);
  assert.deepEqual(requests.map(request => request.url), [wrapper, media]);
  assert.ok(requests.every(request => request.options.headers.Range === 'bytes=0-65535'));
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

test('deep_link remains metadata for User-Agent while the HTTP url is the playable target', async () => {
  let fetches = 0;
  const plugin = loadPlugin(async () => { fetches += 1; throw new Error('direct media must not fetch'); });
  const url = 'https://cdn.mediaoscar.com/live/master.m3u8?token=signed';
  const streams = await plugin.__test.resolveLink({
    url,
    deep_link: 'tdmvideo://play?url=https%3A%2F%2Fother.example%2Fvideo.mp4&user_agent=Fixture%20Player',
    type: 'direct'
  });
  assert.equal(fetches, 0);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, url);
  assert.equal(streams[0].headers['User-Agent'], 'Fixture Player');
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
    if (url.hostname === 'ostvapp.cam' && url.pathname === '/api/episodes/show.php') {
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
