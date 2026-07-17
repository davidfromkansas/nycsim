#!/usr/bin/env node
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import history from '../lib/air-quality-history.js';

const DAYS = 30;
const ROOT = process.env.RECORD_ROOT || 'data';
const PUSH = process.argv.includes('--push');
const REPO = 'davidfromkansas/manhattan-island';
const BRANCH = 'data';

function secret(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  try {
    const raw = readFileSync(fileName, 'utf8').trim();
    try { const parsed = JSON.parse(raw); return typeof parsed === 'string' ? parsed : parsed.key || parsed.apiKey || parsed.token || null; }
    catch { return raw || null; }
  } catch { return null; }
}

const ghToken = secret('GH_DATA_TOKEN', 'gh-data-token.json');
const airNowKey = secret('AIRNOW_API_KEY', 'airnow-api-key.json');
if (!airNowKey) throw new Error('AIRNOW_API_KEY or airnow-api-key.json is required');
if (PUSH && !ghToken) throw new Error('GH_DATA_TOKEN or gh-data-token.json is required with --push');

const gh = async (method, requestPath, body) => {
  const response = await fetch('https://api.github.com' + requestPath, {
    method,
    headers: { Authorization: 'Bearer ' + ghToken, Accept: 'application/vnd.github+json', 'User-Agent': 'city-aq-backfill', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) throw new Error(method + ' ' + requestPath + ' -> ' + response.status + ' ' + (json.message || ''));
  return { status: response.status, json };
};

const latestCompleteDay = history.dayAt(Date.now() - 72 * 3600_000);
const latestCompleteStart = history.dayBounds(latestCompleteDay).start;
const days = [];
for (let index = DAYS - 1; index >= 0; index--) days.push(history.dayAt(latestCompleteStart - index * 86400_000 + 12 * 3600_000));
const firstBounds = history.dayBounds(days[0]), lastBounds = history.dayBounds(days[days.length - 1]);
const histories = await history.loadHistories(firstBounds.start, lastBounds.end, { nowMs: Date.now() });
const generated = [];

for (const day of days) {
  const official = await history.loadAirNowDay(day, { apiKey: airNowKey }).catch(error => {
    console.warn('AirNow unavailable for', day, String(error.message || error));
    return null;
  });
  const pack = history.buildDay(day, histories, official);
  const relative = 'air-quality/' + day + '.json';
  const file = path.join(ROOT, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(pack));
  generated.push(relative);
  console.log(day, pack.frames.length + ' hourly frames', official ? 'AirNow AQI ' + official.aqi : 'no AirNow daily AQI');

  if (PUSH) {
    const repositoryPath = 'data/' + relative;
    const existing = await gh('GET', `/repos/${REPO}/contents/${repositoryPath}?ref=${BRANCH}`);
    await gh('PUT', `/repos/${REPO}/contents/${repositoryPath}`, {
      message: 'backfill air quality ' + day, branch: BRANCH,
      content: Buffer.from(JSON.stringify(pack)).toString('base64'),
      ...(existing.status === 200 ? { sha: existing.json.sha } : {})
    });
  }
}

let manifest = { v: 2, updated: new Date().toISOString(), retentionDays: 7, airQualityRetentionDays: DAYS, daily: [], frames: [] };
const manifestFile = path.join(ROOT, 'manifest.json');
if (existsSync(manifestFile)) manifest = { ...manifest, ...JSON.parse(await readFile(manifestFile, 'utf8')) };
if (PUSH) {
  const remote = await gh('GET', `/repos/${REPO}/contents/data/manifest.json?ref=${BRANCH}`);
  if (remote.status === 200 && remote.json.content) manifest = { ...manifest, ...JSON.parse(Buffer.from(remote.json.content, 'base64').toString('utf8')) };
  manifest.v = 2; manifest.updated = new Date().toISOString(); manifest.airQualityRetentionDays = DAYS; manifest.airQuality = generated;
  await gh('PUT', `/repos/${REPO}/contents/data/manifest.json`, {
    message: 'manifest air quality backfill', branch: BRANCH,
    content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
    ...(remote.status === 200 ? { sha: remote.json.sha } : {})
  });
} else {
  manifest.v = 2; manifest.updated = new Date().toISOString(); manifest.airQualityRetentionDays = DAYS; manifest.airQuality = generated;
  await mkdir(ROOT, { recursive: true });
  await writeFile(manifestFile, JSON.stringify(manifest));
}
console.log(PUSH ? 'pushed' : 'wrote', generated.length, 'packed Air Quality days');
