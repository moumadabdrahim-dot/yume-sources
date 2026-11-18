const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '..', 'plugins', 'cimacloud', 'cimacloud.js');
const code = fs.readFileSync(scriptPath, 'utf8');
const diagnostics = [];
const context = {
  module: { exports: {} }, exports: {}, console, fetch, URL, Date, Promise, JSON, Object, Array, Math,
  Number, String, RegExp, Error, isFinite, encodeURIComponent, decodeURIComponent,
  __yume_diagnostic(value) { diagnostics.push(JSON.parse(value)); },
};
context.globalThis = context;
vm.runInNewContext(code, context, { filename: scriptPath });
const plugin = context.module.exports;

async function main() {
  const home = await plugin.getHome();
  assert.ok(home.sections.length >= 8, `expected rich home, got ${home.sections.length}`);
  assert.ok(home.sections.every((section) => section.items.length > 0));
  console.log(`HOME sections=${home.sections.length} items=${home.sections.reduce((n, s) => n + s.items.length, 0)}`);

  const pages = [];
  let cursor = null;
  for (let page = 1; page <= 3; page++) {
    const result = await plugin.getCatalog({ catalogId: 'latest-series', type: 'series', filters: {}, cursor });
    assert.ok(result.items.length > 0, `series page ${page} was empty`);
    pages.push(new Set(result.items.map((item) => item.nativeId)));
    cursor = result.page.nextCursor;
    console.log(`CATALOG page=${page} items=${result.items.length} hasMore=${result.page.hasMore}`);
  }
  for (let i = 0; i < pages.length; i++) for (let j = i + 1; j < pages.length; j++) {
    assert.equal([...pages[i]].some((id) => pages[j].has(id)), false, `catalog pages ${i + 1}/${j + 1} overlap`);
  }

  for (const query of ['Breaking Bad', 'Dexter', 'El Camino']) {
    const movie = await plugin.search({ query, groupId: 'movies' });
    const series = await plugin.search({ query, groupId: 'series' });
    assert.ok(movie.items.length + series.items.length > 0, `${query} had no results`);
    console.log(`SEARCH query=${JSON.stringify(query)} movies=${movie.items.length} series=${series.items.length}`);
  }

  const breakingBad = await plugin.getDetails({ id: 'cc:series:475' });
  const dexter = await plugin.getDetails({ id: 'cc:series:12052' });
  const elCamino = await plugin.getDetails({ id: 'cc:movie:2937' });
  assert.equal(breakingBad.item.episodes.length, 62);
  assert.equal(dexter.item.episodes.length, 106);
  assert.equal(breakingBad.item.episodes[0].nativeId, 'cc:episode:42498');
  assert.equal(dexter.item.episodes[0].nativeId, 'cc:episode:336681');
  assert.equal(elCamino.item.nativeId, 'cc:movie:2937');
  const dexterSeasons = [...new Set(dexter.item.episodes.map((episode) => episode.season))];
  assert.ok(dexterSeasons.length >= 8, `Dexter season distribution was implausible: ${dexterSeasons.join(',')}`);
  console.log(`DETAILS breakingBadEpisodes=${breakingBad.item.episodes.length} dexterEpisodes=${dexter.item.episodes.length} dexterSeasons=${dexterSeasons.length} movieRuntime=${elCamino.item.runtime || 0}`);

  await assert.rejects(
    () => plugin.getStreams({ id: 'cc:episode:42498', mode: 'options' }),
    /CIMACLOUD_AUTHORIZED_SERVER_ACCESS_REQUIRED/,
  );
  console.log('STREAMS status=BLOCKED reason=AUTHORIZED_SERVER_ACCESS_REQUIRED');

  const allowedDiagnosticKeys = new Set(['pluginId', 'stage', 'host', 'httpStatus', 'responseKind', 'itemCount', 'episodeCount', 'sourceCount', 'streamCount', 'failureCode', 'elapsedMs']);
  diagnostics.forEach((event) => Object.keys(event).forEach((key) => assert.ok(allowedDiagnosticKeys.has(key))));
  console.log(`DIAGNOSTICS events=${diagnostics.length} redacted=true`);
}

main().catch((error) => {
  console.error(`CIMACLOUD_LIVE_SMOKE_FAILED ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
