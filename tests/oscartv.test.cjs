const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins/oscartv.js'), 'utf8');
function makeWordArray(bytes) {
  const buf = Buffer.from(bytes);
  const words = [];
  for (let i = 0; i < buf.length; i++) words[i >>> 2] = (words[i >>> 2] || 0) | (buf[i] << (24 - (i % 4) * 8));
  return { words, sigBytes: buf.length, _bytes: buf, toString(enc) { return enc === 'hex' ? buf.toString('hex') : buf.toString('hex'); } };
}
function bytesOf(value) {
  if (Buffer.isBuffer(value._bytes)) return value._bytes;
  const out = Buffer.alloc(value.sigBytes);
  for (let i = 0; i < value.sigBytes; i++) out[i] = (value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
  return out;
}
const CryptoJS = {
  enc: {
    Utf8: { parse: s => makeWordArray(Buffer.from(String(s), 'utf8')) },
    Hex: { stringify: w => bytesOf(w).toString('hex') }
  },
  lib: { WordArray: {
    create: (words, sigBytes) => {
      if (Buffer.isBuffer(words)) return makeWordArray(words.subarray(0, sigBytes));
      const out = Buffer.alloc(sigBytes);
      for (let i = 0; i < sigBytes; i++) out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
      return makeWordArray(out);
    },
    random: n => makeWordArray(Buffer.from(Array.from({ length: n }, (_, i) => i + 1)))
  } },
  SHA256: input => makeWordArray(crypto.createHash('sha256').update(bytesOf(input)).digest()),
  HmacSHA256: (message, key) => makeWordArray(crypto.createHmac('sha256', bytesOf(key)).update(Buffer.from(String(message))).digest())
};
function loadPlugin() {
  const module = { exports: {} };
  const context = { module, exports: module.exports, CryptoJS, __YUME_OSCAR_TESTING__: true,
    fetch: async () => { throw new Error('unexpected network in unit test'); }, console,
    Date, URL, TextEncoder, Uint8Array, ArrayBuffer, isFinite, encodeURIComponent, decodeURIComponent };
  vm.runInNewContext(source, context, { filename: 'oscartv.js' });
  return module.exports;
}
const plugin = loadPlugin();
const h = plugin.__test;

test('native IDs encode and decode stable typed Oscar identity', () => {
  assert.equal(h.nativeId('movie', 123), 'movie:123');
  assert.deepEqual(JSON.parse(JSON.stringify(h.parseId('series_episode:9001'))), { type: 'series_episode', id: 9001 });
  assert.throws(() => h.parseId('movie:0'), /malformed native id/);
  assert.throws(() => h.parseId('series:1:extra'), /malformed native id/);
  assert.throws(() => h.parseId('anime:999999999999999999999999'), /supported integer range/);
});

test('Iron signer matches deterministic reference vector and signs only raw path', () => {
  const vector = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/iron-signer.json'), 'utf8'));
  const [pathPart, timestamp, nonce] = vector.source.split('|');
  assert.equal(h.sign(pathPart, timestamp, nonce), vector.expectedSignature);
  assert.equal(h.signedPath('https://host.test/api/a%2Fb/?q=x'), '/api/a%2Fb/');
  assert.equal(h.sign('https://host.test/api/a?x=1', timestamp, nonce), h.sign('/api/a?x=2', timestamp, nonce));
});

test('catalog normalization keeps native ID and source metadata without TMDB', () => {
  const item = h.mapMedia({ id: 44, title_ar: 'عنوان', title_en: 'Title', poster: '/uploads/p.jpg', banner: 'https://img.test/b.jpg', release_year: '2024', rating: '8.1', story: 'plot', genres: ['Drama'] }, 'anime');
  assert.equal(item.nativeId, 'anime:44');
  assert.equal(item.title, 'عنوان');
  assert.equal(item.originalTitle, 'Title');
  assert.equal(item.poster, 'https://ostvapp.cam/uploads/p.jpg');
  assert.equal(item.year, 2024);
  assert.deepEqual(JSON.parse(JSON.stringify(item.genres)), ['Drama']);
  assert.equal(item.externalIds, undefined);
});

test('details retain only provided metadata and native identity', () => {
  const item = h.detailsItem({ id: 5, title_en: 'Five', runtime: 121 }, 'movie', 5);
  assert.equal(item.nativeId, 'movie:5');
  assert.equal(item.runtime, 121);
  assert.equal(item.description, undefined);
});

test('direct media and wrapper classification is bounded', () => {
  assert.equal(h.directMedia('https://cdn.test/a.m3u8?token=x'), true);
  assert.equal(h.directMedia('https://cdn.test/video', 'video/mp4'), true);
  assert.equal(h.directMedia('https://cdn.test/video?id=9', '', 'direct'), true);
  assert.equal(h.directMedia('https://cdn.test/watch?id=1', 'text/html'), false);
  assert.equal(h.isSeriesMp4('https://cdn.seriesmp4.com/file.mp4'), true);
});

test('quality parser normalizes common resolution labels', () => {
  assert.equal(h.qualityOf('Full HD 1080p'), '1080p');
  assert.equal(h.qualityOf('HD'), 'HD');
  assert.equal(h.qualityOf(''), undefined);
});
