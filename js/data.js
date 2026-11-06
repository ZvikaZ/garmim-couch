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

// Bounding boxes are much faster for Overpass than (around:...) radius searches.
function bbox(lat, lon, r) {
  const dLat = r / 111195, dLon = r / (111195 * Math.cos(lat * Math.PI / 180));
  return `(${(lat - dLat).toFixed(4)},${(lon - dLon).toFixed(4)},${(lat + dLat).toFixed(4)},${(lon + dLon).toFixed(4)})`;
}

function buildQuery(lat, lon) {
  const b = (r) => bbox(lat, lon, r);
  return `[out:json][timeout:40];
(
  node["place"~"^(city|town)$"]["name"]${b(90000)};
  node["place"~"^(village|hamlet)$"]["name"]${b(35000)};
  node["natural"~"^(peak|volcano)$"]["name"]${b(60000)};
  way["natural"="water"]["name"]["wikidata"]${b(80000)};
  relation["natural"="water"]["name"]["wikidata"]${b(80000)};
  way["natural"="valley"]["name"]["wikidata"]${b(60000)};
  relation["natural"="valley"]["name"]["wikidata"]${b(60000)};
);
out tags bb qt;`;
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
    case 'volcano': {
      // A sub-summit right next to a higher one is not interesting: scale by "isolation"
      // (distance to the nearest higher peak), so the Hermon shows once, not ten times.
      const iso = p.isoKm ?? 8;
      const f = Math.max(0.15, Math.min(1.6, Math.sqrt(iso / 8)));
      return (10 + (p.ele ?? 0) / 30 + (p.wikidata ? 25 : 0) + (p.kind === 'volcano' ? 10 : 0)) * f;
    }
    case 'water':
    case 'valley':
      // Tiny named ponds/fish pools are noise (some even carry a big lake's name by mistake).
      if (p.areaKm2 != null && p.areaKm2 < 0.1) return 5;
      return 40 + 45 * Math.log10((p.areaKm2 ?? 0) + 1);
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

/** Ask all mirrors at once; the first good answer wins, the rest are cancelled. */
async function queryOverpass(q, timeoutMs = 45000) {
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  try {
    return await Promise.any(ENDPOINTS.map(async (url, i) => {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrls[i].signal });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const json = await res.json();
      ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
      return json;
    }));
  } catch (e) {
    throw e instanceof AggregateError ? new Error(e.errors.map((x) => x.message).join('; ')) : e;
  } finally {
    clearTimeout(timer);
  }
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* quota / private mode */ }
}

// ---------- pre-built static file (data/landmarks.json, made by tools/build_landmarks.py) ----------
// Same reach per kind as the live Overpass query.
const REACH_KM = { city: 90, town: 90, village: 35, hamlet: 35, peak: 60, volcano: 60, water: 80, valley: 60 };
let staticDoc = null;

async function loadStatic() {
  if (staticDoc) return staticDoc;
  const res = await fetch('data/landmarks.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`static data: HTTP ${res.status}`);
  staticDoc = await res.json();
  return staticDoc;
}

function fromStatic(doc, lat, lon) {
  const [s, w, n, e] = doc.region;
  if (lat < s || lat > n || lon < w || lon > e) return null; // outside the pre-built region
  const out = [];
  for (const r of doc.pois) {
    const reach = REACH_KM[r.k] ?? 35;
    // cheap prefilter before the exact distance
    if (Math.abs(r.la - lat) > reach / 111 + 0.01) continue;
    if (distBearing(lat, lon, r.la, r.lo).d / 1000 > reach) continue;
    const p = {
      id: `${r.k}:${r.n}:${r.la}`, kind: r.k, name: r.n, nameLocal: r.nl ?? r.n,
      lat: r.la, lon: r.lo, ele: r.e ?? null, pop: r.p ?? null,
      wikidata: r.w ?? null, wikipedia: r.wp ?? null, areaKm2: r.a ?? null,
    };
    p.score = baseScore(p);
    out.push(p);
  }
  return out;
}

/** Landmarks around (lat, lon): pre-built file first, then cache, then live Overpass. */
export async function loadLandmarks(lat, lon, { force = false } = {}) {
  if (!force) {
    try {
      const pois = fromStatic(await loadStatic(), lat, lon);
      if (pois) return { pois, fromCache: false, source: 'static' };
    } catch (e) {
      console.warn('no static landmarks file, using Overpass', e);
    }
  }
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

/** Distance (km) from each peak to the nearest higher peak; then re-score everything. */
export function finalizeScores(pois) {
  const peaks = pois.filter((p) => (p.kind === 'peak' || p.kind === 'volcano') && p.ele != null)
    .sort((a, b) => b.ele - a.ele);
  for (let i = 0; i < peaks.length; i++) {
    let best = 30;
    for (let j = 0; j < i; j++) {
      if (peaks[j].ele <= peaks[i].ele) continue;
      if (Math.abs(peaks[j].lat - peaks[i].lat) > best / 111) continue;
      const d = distBearing(peaks[i].lat, peaks[i].lon, peaks[j].lat, peaks[j].lon).d / 1000;
      if (d < best) best = d;
    }
    peaks[i].isoKm = best;
  }
  for (const p of pois) {
    if ((p.kind === 'peak' || p.kind === 'volcano') && p.ele == null) p.isoKm = 1;
    p.score = baseScore(p);
  }
  return pois;
}
