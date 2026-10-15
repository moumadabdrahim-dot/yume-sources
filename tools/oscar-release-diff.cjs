#!/usr/bin/env node
'use strict';

// Creates a privacy-safe compatibility diff from two JADX source directories.
// It reports API/behavioral markers and filenames/hashes, never source snippets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message) {
  console.error(message);
  process.exit(2);
}

function walk(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.java')) files.push(full);
    }
  }
  visit(root);
  return files;
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const MARKERS = {
  ironSigner: /nativeSign|X-Iron-Sig|X-Iron-Ts|X-Iron-Nonce/i,
  ironDiagnosticHeader: /X-Iron-Diag/i,
  remoteHosts: /default_domain|backup_domains|active_domain|DomainFailover/i,
  watchLinks: /watch_links|WatchLink|deep_link/i,
  playbackHandoff: /tdmvideo|ACTION_VIEW|mediaoscar\.com|\/yx\//i,
  streamModels: /class\s+(?:MovieLink|WatchLink|Episode|AnimeEpisode)|quality_source|order_index/i,
  v3DeviceAndGuardFlow: /api\/(?:auth\/(?:device|anonymous)|v3\/devices\/(?:challenge|register|token)|v3\/guard\/)/i,
  v3StreamResolver: /api\/v3\/resolve\.php|V3ResolveRequest|resolveV3/i,
  tdmEntitlement: /tdm_entitlement|api\/v3\/guard\/tdm/i,
  providerApi: /@(?:GET|POST|PUT|DELETE)\s*\(/i
};

function analyze(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`missing source directory: ${root}`);
  const files = walk(root);
  const routes = new Set();
  const markers = Object.fromEntries(Object.keys(MARKERS).map(key => [key, []]));
  const relevantFiles = {};
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replace(/\\/g, '/');
    for (const match of source.matchAll(/@(?:GET|POST|PUT|DELETE)\s*\(\s*"([^"]+)"/g)) routes.add(match[1]);
    for (const [name, pattern] of Object.entries(MARKERS)) {
      if (pattern.test(source)) markers[name].push(relative);
    }
    if (/com\/drama\/mp4\/(?:data\/api|data\/model|security)\//.test(relative) ||
        Object.values(MARKERS).some(pattern => pattern.test(source))) {
      relevantFiles[relative] = digest(source);
    }
  }
  Object.keys(markers).forEach(key => markers[key].sort());
  return { javaFileCount: files.length, routes: Array.from(routes).sort(), markers, relevantFiles };
}

function setDiff(before, after) {
  return {
    added: after.filter(value => !before.includes(value)),
    removed: before.filter(value => !after.includes(value))
  };
}

function fileDiff(before, after) {
  const beforeNames = Object.keys(before).sort();
  const afterNames = Object.keys(after).sort();
  const added = afterNames.filter(name => !Object.hasOwn(before, name));
  const removed = beforeNames.filter(name => !Object.hasOwn(after, name));
  const modified = beforeNames.filter(name => Object.hasOwn(after, name) && before[name] !== after[name]);
  return { added, removed, modified };
}

function assetDiff(before, after) {
  const names = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
  return names.flatMap(name => {
    const previousSha256 = before && before[name] != null ? String(before[name]).toLowerCase() : null;
    const currentSha256 = after && after[name] != null ? String(after[name]).toLowerCase() : null;
    if (previousSha256 === currentSha256) return [];
    return [{ name, change: previousSha256 == null ? 'added' : currentSha256 == null ? 'removed' : 'digest-changed',
      previousSha256, currentSha256 }];
  });
}

function buildReport(metadata, baseline, candidate) {
  const markerChanges = {};
  for (const key of Object.keys(MARKERS)) markerChanges[key] = setDiff(baseline.markers[key], candidate.markers[key]);
  const apiRoutes = setDiff(baseline.routes, candidate.routes);
  const relevantSourceFiles = fileDiff(baseline.relevantFiles, candidate.relevantFiles);
  const releaseAssets = assetDiff(metadata.baseline.assets, metadata.candidate.assets);
  const packageMatchesBaseline = metadata.candidate.packageName === metadata.baseline.packageName;
  const signingCertificateMatchesBaseline = metadata.candidate.signingCertificateSha256 === metadata.baseline.signingCertificateSha256;
  const sameReleaseTag = String(metadata.candidate.tag || '') === String(metadata.baseline.tag || '');
  const baselineVersionCode = Number(metadata.baseline.versionCode);
  const candidateVersionCode = Number(metadata.candidate.versionCode);
  const candidateVersionCodeValid = sameReleaseTag || (Number.isFinite(candidateVersionCode) && Number.isFinite(baselineVersionCode) && candidateVersionCode > baselineVersionCode);
  const breakingChanges = [];
  if (!packageMatchesBaseline) breakingChanges.push({ severity: 'critical', area: 'package identity', reason: 'Candidate package differs from the reviewed OscarTV package.' });
  if (!signingCertificateMatchesBaseline) breakingChanges.push({ severity: 'critical', area: 'signing identity', reason: 'Candidate signing certificate differs from the reviewed release.' });
  if (apiRoutes.removed.length) breakingChanges.push({ severity: 'high', area: 'API routes', removed: apiRoutes.removed });
  for (const key of ['ironSigner', 'watchLinks', 'playbackHandoff', 'streamModels']) {
    if (baseline.markers[key].length > 0 && candidate.markers[key].length === 0) {
      breakingChanges.push({ severity: 'high', area: key, reason: `All ${key} source markers disappeared.` });
    }
  }
  if (!candidateVersionCodeValid) breakingChanges.push({ severity: 'high', area: 'version code', reason: 'A new release tag must advance beyond the reviewed versionCode.' });
  const compatibilityNotes = [];
  if (markerChanges.ironDiagnosticHeader.removed.length) {
    compatibilityNotes.push({ area: 'request headers', note: 'X-Iron-Diag was present in the baseline and absent from the candidate interceptor.' });
  }
  if (markerChanges.v3DeviceAndGuardFlow.added.length) {
    compatibilityNotes.push({ area: 'device authorization', note: 'The candidate adds device challenge/register/token or guard API paths; review provider-issued access requirements.' });
  }
  if (markerChanges.v3StreamResolver.added.length) {
    compatibilityNotes.push({ area: 'stream resolution', note: 'The candidate adds a v3 stream resolver path.' });
  }
  if (markerChanges.tdmEntitlement.added.length) {
    compatibilityNotes.push({ area: 'TDM access', note: 'The candidate adds TDM entitlement/guard routes that may require provider-issued authorization.' });
  }
  if (releaseAssets.length) compatibilityNotes.push({ area: 'release assets', note: 'One or more APK/TDM asset digests changed and need human review.' });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: { release: metadata.baseline, source: baseline },
    candidate: { release: metadata.candidate, source: candidate },
    differences: { apiRoutes, markers: markerChanges, relevantSourceFiles, releaseAssets },
    breakingChanges,
    compatibilityNotes,
    decision: {
      packageMatchesBaseline,
      signingCertificateMatchesBaseline,
      candidateVersionCodeValid,
      manualReviewRequired: true,
      automaticPluginDeployment: false
    }
  };
}

function main() {
  const [oldRoot, newRoot, metadataPath, outputPath] = process.argv.slice(2);
  if (!oldRoot || !newRoot || !metadataPath || !outputPath) {
    fail('Usage: node tools/oscar-release-diff.cjs <old-sources> <new-sources> <metadata.json> <report.json>');
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const baseline = analyze(oldRoot);
  const candidate = analyze(newRoot);
  const report = buildReport(metadata, baseline, candidate);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { analyze, buildReport, assetDiff };
