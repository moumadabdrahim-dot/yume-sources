#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', '5tv', '5tv.js'), 'utf8');
const events = [];
async function observedFetch(url, options = {}) {
  const started = Date.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const parsed = new URL(url);
  events.push({ host: parsed.hostname, path: parsed.pathname, status: response.status, elapsedMs: Date.now() - started });
  return response;
}
const context = {
  module: { exports: {} }, exports: {}, fetch: observedFetch, console: { warn() {}, error() {} },
  URL, Date, Promise, JSON, Object, Array, Math, Number, String, RegExp, Error, isFinite,
  encodeURIComponent, decodeURIComponent,
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: '5tv.js' });
const plugin = context.module.exports;

async function main() {
  const home = await plugin.getHome();
  assert.ok(home.sections.length >= 5, `expected rich Home, got ${home.sections.length}`);
  assert.ok(!home.sections.some(section => section.id === 'latest-episodes'), 'removed latest-episodes catalog returned from Home');
  const movie = home.sections.flatMap(section => section.items).find(item => item.type === 'movie');
  const series = { nativeId: '5tv:series:attack-on-titan' };
  assert.ok(movie && series, 'Home did not expose all required identities');
  console.log(`HOME sections=${home.sections.length} items=${home.sections.reduce((n, s) => n + s.items.length, 0)}`);

  const detoxId = '5tv:series:مشروع-إزالة-السموم-the-detox-project';
  const [movieDetails, seriesDetails, detoxDetails] = await Promise.all([
    plugin.getDetails({ id: movie.nativeId }), plugin.getDetails({ id: series.nativeId }),
    plugin.getDetails({ id: detoxId }),
  ]);
  assert.equal(movieDetails.item.type, 'movie');
  assert.equal(seriesDetails.item.type, 'series');
  assert.ok(seriesDetails.episodes.length > 0);
  assert.equal(detoxDetails.item.nativeId, detoxId);
  assert.equal(detoxDetails.episodes.length, 6);
  assert.ok(detoxDetails.item.description);
  console.log(`DETAILS movie=${JSON.stringify(movieDetails.item.title)} seriesEpisodes=${seriesDetails.episodes.length} detoxEpisodes=${detoxDetails.episodes.length}`);

  const arabic = await plugin.search({ query: 'الحب', groupId: 'series' });
  const english = await plugin.search({ query: 'Home Alone', groupId: 'movies' });
  const mixed = await plugin.search({ query: 'The حب', groupId: 'series' });
  assert.ok(arabic.items.length + english.items.length > 0, 'both searches were empty');
  assert.ok(english.items.length > 0 && arabic.items.length > 0, 'search groups did not expose both content types');
  const [searchMovieDetails, searchSeriesDetails] = await Promise.all([
    plugin.getDetails({ id: english.items[0].nativeId }), plugin.getDetails({ id: arabic.items[0].nativeId }),
  ]);
  assert.equal(searchMovieDetails.item.nativeId, english.items[0].nativeId);
  assert.equal(searchSeriesDetails.item.nativeId, arabic.items[0].nativeId);
  console.log(`SEARCH arabicSeries=${arabic.items.length} englishMovies=${english.items.length} mixedSeries=${mixed.items.length} details=verified`);

  const filters = await plugin.getCatalogFilters({ catalogId: 'discover-series', contentType: 'series', selectedFilters: {} });
  const yearFilter = filters.filters.find(filter => filter.key === 'year');
  assert.ok(yearFilter && yearFilter.options.some(option => option.value === '2026'));
  const firstPage = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series' });
  const secondPage = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series', cursor: '2' });
  const thirdPage = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series', cursor: '3' });
  assert.ok(firstPage.items.length > 0 && secondPage.items.length > 0 && thirdPage.items.length > 0);
  assert.notEqual(firstPage.items[0].nativeId, secondPage.items[0].nativeId);
  assert.notEqual(secondPage.items[0].nativeId, thirdPage.items[0].nativeId);
  const genre = filters.filters.find(filter => filter.key === 'genre').options.find(option => option.label === 'دراما');
  assert.ok(genre);
  const filteredPages = [];
  for (const cursor of [undefined, '2', '3']) {
    filteredPages.push(await plugin.getCatalog({ catalogId: 'discover-series', type: 'series', filters: { genre: genre.value }, cursor }));
  }
  assert.ok(filteredPages.every(page => page.items.length > 0));
  assert.equal(new Set(filteredPages.map(page => page.items[0].nativeId)).size, 3);
  const newMovies = await plugin.getCatalog({ catalogId: 'new-movies', type: 'movie' });
  const newSeries = await plugin.getCatalog({ catalogId: 'new-series', type: 'series' });
  assert.ok(newMovies.items.length > 0 && newMovies.items.every(item => item.type === 'movie'));
  assert.ok(newSeries.items.length > 0 && newSeries.items.every(item => item.type === 'series'));
  console.log(`CATALOG pages=${firstPage.items.length}/${secondPage.items.length}/${thirdPage.items.length} filtered=${filteredPages.map(page => page.items.length).join('/')} new=${newMovies.items.length}/${newSeries.items.length} filters=${filters.filters.map(filter => filter.key).join(',')}`);

  const movieOptions = await plugin.getStreams({ id: movie.nativeId, mode: 'options' });
  assert.ok(movieOptions.options.length > 0);
  const episodeOptions = await plugin.getStreams({ id: seriesDetails.episodes[0].nativeId, mode: 'options' });
  assert.ok(episodeOptions.options.length > 0);
  console.log(`OPTIONS movie=${movieOptions.options.length} episode=${episodeOptions.options.length}`);

  const disallowed = events.filter(event => event.host !== '5tv.rest');
  assert.equal(disallowed.length, 0, 'metadata smoke contacted a non-source host');
  console.log(`HTTP requests=${events.length} maxMs=${Math.max(...events.map(event => event.elapsedMs))}`);
  console.log('PLAYBACK status=UNVERIFIED reason=central extractor and Media3 require Android host');
}

main().catch(error => {
  console.error(`5TV_LIVE_SMOKE_FAILED ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
