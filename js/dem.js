// Digital elevation model from the free AWS Terrain Tiles (Terrarium encoding).
// https://registry.opendata.aws/terrain-tiles/  — elevation = R*256 + G + B/256 - 32768
// Two zoom levels: a sharp one near the observer, a coarse one for far ridges.

import { destination, curvatureDrop, D2R } from './geo.js';

const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// The DEM is coarse (65-130 m): terrain right next to the observer is unreliable (you are
// standing on a lookout, not inside the hill), so ignore it for line-of-sight and skyline.
const NEAR_IGNORE = 300;

const LEVELS = [
  { z: 11, radius: 18000 }, // ~65 m pixels in Israel
  { z: 10, radius: 75000 }, // ~130 m pixels
];

function lonToX(lon, z) { return (lon + 180) / 360 * 2 ** z; }
function latToY(lat, z) {
  const r = lat * D2R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
}

async function loadTile(z, x, y) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = URL(z, x, y);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) {
    out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

export class DEM {
  constructor() {
    this.tiles = new Map(); // "z/x/y" -> Float32Array | null (failed)
    this.pending = new Map();
  }

  /** Download every tile needed around (lat, lon). Resolves when done (failed tiles are skipped). */
  async loadAround(lat, lon, onProgress) {
    const jobs = [];
    for (const { z, radius } of LEVELS) {
      const [n] = destination(lat, lon, 0, radius);
      const [s] = destination(lat, lon, Math.PI, radius);
      const [, e] = destination(lat, lon, Math.PI / 2, radius);
      const [, w] = destination(lat, lon, -Math.PI / 2, radius);
      const x0 = Math.floor(lonToX(w, z)), x1 = Math.floor(lonToX(e, z));
      const y0 = Math.floor(latToY(n, z)), y1 = Math.floor(latToY(s, z));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([z, x, y]);
    }
    let done = 0;
    const queue = jobs.slice();
    const worker = async () => {
      while (queue.length) {
        const [z, x, y] = queue.shift();
        const key = `${z}/${x}/${y}`;
        if (!this.tiles.has(key)) {
          try { this.tiles.set(key, await loadTile(z, x, y)); }
          catch { this.tiles.set(key, null); }
        }
        done++;
        onProgress?.(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const ok = jobs.filter(([z, x, y]) => this.tiles.get(`${z}/${x}/${y}`)).length;
    return { total: jobs.length, ok };
  }

  _sample(z, lat, lon) {
    const fx = lonToX(lon, z) * 256 - 0.5, fy = latToY(lat, z) * 256 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const get = (px, py) => {
      const t = this.tiles.get(`${z}/${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
      if (!t) return NaN;
      return t[(py & 255) * 256 + (px & 255)];
    };
    const ax = fx - ix, ay = fy - iy;
    const h00 = get(ix, iy), h10 = get(ix + 1, iy), h01 = get(ix, iy + 1), h11 = get(ix + 1, iy + 1);
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  }

  /** Ground elevation (m) at a point, or NaN if no tile covers it. */
  elevation(lat, lon) {
    for (const { z } of LEVELS) {
      const h = this._sample(z, lat, lon);
      if (!Number.isNaN(h)) return h;
    }
    return NaN;
  }

  get ready() { return [...this.tiles.values()].some(Boolean); }
}

/**
 * Line-of-sight test. Returns { visible, clearance } where clearance (rad) is how far
 * the target sits above the highest terrain in between (negative = hidden).
 */
export function lineOfSight(dem, obs, target, targetHeight, d, brg) {
  const angleT = Math.atan2(targetHeight - obs.h - curvatureDrop(d), d);
  const step = Math.max(60, d / 250);
  const stopBefore = Math.min(400, d * 0.1);
  let maxA = -Infinity;
  const cosLat = Math.cos(obs.lat * D2R);
  // Small-step flat approximation along the bearing is plenty accurate for < 100 km.
  const dLatPerM = 1 / 111195 * Math.cos(brg);
  const dLonPerM = 1 / (111195 * cosLat) * Math.sin(brg);
  for (let s = NEAR_IGNORE; s < d - stopBefore; s += step) {
    const h = dem.elevation(obs.lat + dLatPerM * s, obs.lon + dLonPerM * s);
    if (Number.isNaN(h)) continue;
    const a = Math.atan2(h - obs.h - curvatureDrop(s), s);
    if (a > maxA) maxA = a;
  }
  return { visible: angleT >= maxA - 0.0025, clearance: angleT - maxA };
}

/**
 * Skyline: for each azimuth, the highest elevation angle of terrain (the ridge line you see).
 * Returns Float32Array of angles (rad), one per `stepDeg`.
 */
export function computeSkyline(dem, obs, stepDeg = 0.5, maxDist = 75000) {
  const n = Math.round(360 / stepDeg);
  const out = new Float32Array(n);
  const cosLat = Math.cos(obs.lat * D2R);
  for (let i = 0; i < n; i++) {
    const brg = i * stepDeg * D2R;
    const dLat = Math.cos(brg) / 111195, dLon = Math.sin(brg) / (111195 * cosLat);
    let maxA = -0.2, s = NEAR_IGNORE;
    while (s < maxDist) {
      const h = dem.elevation(obs.lat + dLat * s, obs.lon + dLon * s);
      if (!Number.isNaN(h)) {
        const a = Math.atan2(h - obs.h - curvatureDrop(s), s);
        if (a > maxA) maxA = a;
      }
      s += Math.max(40, s * 0.012);
    }
    out[i] = maxA;
  }
  return out;
}

