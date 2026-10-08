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
