// Landmarks from OpenStreetMap via the Overpass API, cached in the browser.

import { distBearing } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CACHE_KEY = 'ma-roim:poi-cache:v1';
const CACHE_REUSE_KM = 10;
const CACHE_MAX_AGE_DAYS = 30;

function buildQuery(lat, lon) {
  const a = (r) => `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:90];
(
  node["place"~"^(city|town)$"]["name"]${a(90000)};
  node["place"~"^(village|hamlet)$"]["name"]${a(35000)};
  node["natural"~"^(peak|volcano)$"]["name"]${a(60000)};
  nwr["natural"="water"]["name"]["wikidata"]${a(80000)};
  nwr["natural"="valley"]["name"]["wikidata"]${a(60000)};
);
out tags bb;`;
}

function pickName(t) {
  return t['name:he'] || t['name:en'] || t.name;
}

function parseEle(v) {
  if (!v) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Importance score: decides what shows first and how far away it is still worth labelling. */
export function baseScore(p) {
  switch (p.kind) {
    case 'city': return 150 + (p.pop ? Math.max(0, Math.log10(p.pop) - 4.5) * 40 : 0);
    case 'town': return 100 + (p.pop ? Math.max(0, Math.log10(p.pop) - 4) * 30 : 0);
    case 'village': return 40 + (p.wikidata ? 5 : 0);
    case 'hamlet': return 15;
    case 'peak':
    case 'volcano': return 10 + (p.ele ?? 0) / 25 + (p.wikidata ? 40 : 0) + (p.kind === 'volcano' ? 10 : 0);
    case 'water':
    case 'valley': return 40 + 45 * Math.log10((p.areaKm2 ?? 0) + 1);
    default: return 10;
  }
}

function normalize(el) {
  const t = el.tags || {};
  let lat = el.lat, lon = el.lon, areaKm2 = null;
  if (lat == null && el.bounds) {
    const b = el.bounds;
    lat = (b.minlat + b.maxlat) / 2;
    lon = (b.minlon + b.maxlon) / 2;
    const h = distBearing(b.minlat, lon, b.maxlat, lon).d / 1000;
    const w = distBearing(lat, b.minlon, lat, b.maxlon).d / 1000;
    areaKm2 = h * w * 0.6; // a lake fills roughly 60% of its bounding box
  }
  if (lat == null) return null;
  const kind = t.place || t.natural;
  const p = {
    id: `${el.type[0]}${el.id}`,
    kind,
    name: pickName(t),
    nameLocal: t.name,
    lat, lon,
    ele: parseEle(t.ele),
    pop: parseInt(t.population, 10) || null,
    wikidata: t.wikidata || null,
    wikipedia: t['wikipedia:he'] ? `he:${t['wikipedia:he']}` : (t.wikipedia || null),
    areaKm2,
  };
  p.score = baseScore(p);
  return p;
}

async function queryOverpass(q, signal) {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
    }
  }
  throw lastErr;
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* quota / private mode */ }
}

/** Landmarks around (lat, lon). Uses the cached set if we haven't moved far. */
export async function loadLandmarks(lat, lon, { force = false } = {}) {
  const cached = readCache();
  if (!force && cached) {
    const { d } = distBearing(lat, lon, cached.lat, cached.lon);
    const ageDays = (Date.now() - cached.ts) / 864e5;
    if (d / 1000 < CACHE_REUSE_KM && ageDays < CACHE_MAX_AGE_DAYS) {
      return { pois: cached.pois, fromCache: true };
    }
  }
  try {
    const json = await queryOverpass(buildQuery(lat, lon));
    const seen = new Set();
    const pois = [];
    for (const el of json.elements || []) {
      const p = normalize(el);
      if (!p || !p.name) continue;
      // de-duplicate the same place mapped twice (e.g. node + area)
      const k = `${p.kind}|${p.name}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pois.push(p);
    }
    writeCache({ lat, lon, ts: Date.now(), pois });
    return { pois, fromCache: false };
  } catch (e) {
    if (cached) return { pois: cached.pois, fromCache: true, stale: true, error: e };
    throw e;
  }
}

export const KIND_HE = {
  city: 'עיר', town: 'עיירה', village: 'יישוב', hamlet: 'יישוב קטן',
  peak: 'פסגה', volcano: 'הר געש', water: 'מקווה מים', valley: 'עמק',
};
