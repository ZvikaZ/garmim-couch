import {
  curvatureDrop, distBearing, elevationAngle, dirVector, qmul, qaxis, qconj, qrot, cameraHeadingPitch,
  compassName, D2R, R2D,
} from './geo.js';
import { DEM, lineOfSight, computeSkyline } from './dem.js';
import { loadLandmarks, loadRoads, finalizeScores, KIND_HE } from './data.js';
import { Orientation } from './orientation.js';
import { REGIONS } from './regions.js';

const VERSION = '0.18';
const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

// ---------------- persisted settings ----------------
const SETTINGS_KEY = 'ma-roim:settings:v1';
const defaults = { fov: 66, density: 1, showHidden: false, showSkyline: true, showRoads: true, showPrayer: true, showCompass: true, driveMode: true, autoAlign: true, headingOffset: 0, pitchOffset: 0, rollOffset: 0 };
function loadSettings() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...defaults }; }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------------- state ----------------
const state = {
  mode: null,            // 'live' | 'demo'
  obs: null,             // { lat, lon, h, acc }
  lastGeomAt: null,      // obs used for the last geometry pass
  lastDataAt: null,      // obs used for the last data/DEM load
  pois: [],
  roads: [],
  rivers: [],
  drive: { active: false, speed: 0, lastFix: 0 },
  skyline: null,
  skyStep: 0.5,
  zoom: 1,
  demHeading: 0,
  status: { gps: '', data: '', dem: '' },
  placed: [],            // label boxes drawn last frame (for taps)
  dem: new DEM(),
};
window.__app = state; // handy for debugging / tests

const orient = new Orientation();
window.__orient = orient; // tests

// ---------------- geometry ----------------
function targetHeight(p) {
  const g = state.dem.elevation(p.lat, p.lon);
  if (p.kind === 'peak' || p.kind === 'volcano') return p.ele ?? (Number.isNaN(g) ? 0 : g);
  if (p.kind === 'water') return Number.isNaN(g) ? (p.ele ?? 0) : g;
  if (p.kind === 'valley' || p.kind === 'region') return Number.isNaN(g) ? 0 : g;
  if (p.kind === 'junction') return (Number.isNaN(g) ? 0 : g) + 2;
  return (Number.isNaN(g) ? 0 : g) + 15; // settlements: aim a little above the ground (roofs)
}

function recomputeGeometry() {
  const obs = state.obs;
  if (!obs) return;
  // The DEM is coarse; on a slope or a lookout edge the cell value underestimates where you
  // stand. Take the highest ground within ~100 m so a nearby rim does not "hide" the view.
  let g = state.dem.elevation(obs.lat, obs.lon);
  for (let a = 0; a < 8; a++) {
    const v = state.dem.elevation(obs.lat + Math.cos(a * Math.PI / 4) * 100 / 111195,
      obs.lon + Math.sin(a * Math.PI / 4) * 100 / (111195 * Math.cos(obs.lat * D2R)));
    if (!Number.isNaN(v) && !(v <= g)) g = v;
  }
  obs.h = (Number.isNaN(g) ? (obs.gpsAlt ?? 0) : g) + 1.7;
  const haveDem = state.dem.ready;
  for (const p of state.pois) {
    const { d, brg } = distBearing(obs.lat, obs.lon, p.lat, p.lon);
    p.d = d; p.brg = brg;
    p.h = targetHeight(p);
    p.angle = elevationAngle(p.h - obs.h, d);
    if (p.kind === 'region') {
      p.visible = true; // an area, not a point: "it's over there"
    } else if (haveDem && d > 300) {
      const los = lineOfSight(state.dem, obs, p, p.h, d, brg);
      // Lakes and valleys are big: their centre can be hidden while most of it is visible.
      const lenient = (p.kind === 'water' || p.kind === 'valley') ? 0.02 : 0;
      p.visible = los.clearance > -0.0025 - lenient;
    } else {
      p.visible = true;
    }
  }
  for (const r of [...state.roads, ...state.rivers]) {
    const { d, brg } = distBearing(obs.lat, obs.lon, r.lat, r.lon);
    r.d = d; r.brg = brg;
    const g2 = state.dem.elevation(r.lat, r.lon);
    r.h = (Number.isNaN(g2) ? 0 : g2) + 1;
    r.angle = elevationAngle(r.h - obs.h, d);
    r.visible = haveDem && d > 300 ? lineOfSight(state.dem, obs, r, r.h, d, brg).clearance > -0.002 : true;
  }
  state.skyline = haveDem ? computeSkyline(state.dem, obs, state.skyStep) : null;
  state.lastGeomAt = { lat: obs.lat, lon: obs.lon };
}

async function loadAll(force = false) {
  const { lat, lon } = state.obs;
  state.lastDataAt = { lat, lon };
  state.status.dem = 'טוען גבהים…';
  state.status.data = 'טוען מקומות…';
  const t0 = Date.now();
  const tick = setInterval(() => {
    if (state.status.data.startsWith('טוען מקומות')) state.status.data = `טוען מקומות… ${Math.round((Date.now() - t0) / 1000)} שנ׳`;
    else clearInterval(tick);
  }, 1000);
  const demP = state.dem.loadAround(lat, lon, (d, n) => { state.status.dem = `גבהים ${d}/${n}`; })
    .then(({ ok, total }) => { state.status.dem = ok ? (ok === total ? '' : `גבהים ${ok}/${total}`) : 'אין נתוני גובה'; })
    .catch(() => { state.status.dem = 'אין נתוני גובה'; });
  const dataP = loadLandmarks(lat, lon, { force })
    .then((r) => {
      const regions = REGIONS.filter((g) => distBearing(lat, lon, g.lat, g.lon).d / 1000 <= g.reachKm).map((g) => ({ ...g }));
      state.pois = finalizeScores([...r.pois.map((p) => ({ ...p })), ...regions]);
      state.status.data = r.stale ? 'נתונים ישנים (אין רשת)' : '';
    })
    .catch((e) => { state.status.data = 'שגיאה בטעינת מקומות'; state.lastError = String(e.message || e); console.error(e); });
  const roadsP = loadRoads(lat, lon).then((r) => { state.roads = r.roads; state.rivers = r.rivers; });
  // Show labels as soon as the landmarks arrive, then refine once heights are in.
  await Promise.all([dataP, roadsP]); recomputeGeometry();
  await demP; recomputeGeometry();
}

function onPosition(lat, lon, acc, gpsAlt, gpsHeading = null, speed = null) {
  updateDrive(gpsHeading, speed);
  recallCalibration(lat, lon);
  const first = !state.obs;
  state.obs = { ...(state.obs || {}), lat, lon, acc, gpsAlt };
  state.status.gps = acc != null ? `GPS ±${Math.round(acc)} מ׳` : '';
  if (first) { loadAll(); return; }
  const movedData = distBearing(lat, lon, state.lastDataAt.lat, state.lastDataAt.lon).d;
  if (movedData > 8000) { loadAll(); return; }
  const movedGeom = state.lastGeomAt ? distBearing(lat, lon, state.lastGeomAt.lat, state.lastGeomAt.lon).d : Infinity;
  if (movedGeom > 250) recomputeGeometry();
}

// ---------------- drive mode ----------------
// Inside a car the magnetometer is badly disturbed by the car's metal and electrics, and
// acceleration tilts the gravity sensor. While driving, the GPS course is a far better
// "north": when the camera looks roughly forward through the windscreen, we learn the offset
// between the compass and the course and apply it.
const DRIVE_SPEED = 4.5; // m/s (~16 km/h)
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function updateDrive(gpsHeading, speed) {
  const dr = state.drive;
  dr.speed = speed ?? 0;
  const moving = settings.driveMode && speed != null && speed > DRIVE_SPEED && gpsHeading != null && !Number.isNaN(gpsHeading);
  if (!moving) {
    if (dr.active && performance.now() - dr.lastFix > 8000) dr.active = false;
    orient.smoothing = dr.active ? 0.08 : 0.25;
    return;
  }
  dr.lastFix = performance.now();
  orient.smoothing = 0.08; // heavier smoothing against road bumps and acceleration
  if (!orient.q || gesture) return;
  const sensorHeading = cameraHeadingPitch(orient.q).heading;
  const course = gpsHeading * D2R;
  // Only learn when the camera faces (roughly) the direction of travel.
  if (Math.abs(wrapPi(course - sensorHeading)) > 70 * D2R) return;
  // corrected heading = sensor heading - offset  =>  offset = sensor - course
  const target = wrapPi(sensorHeading - course);
  const k = dr.active ? 0.3 : 1;
  settings.headingOffset = wrapPi(settings.headingOffset + k * wrapPi(target - settings.headingOffset));
  dr.active = true;
}

// ---------------- camera model ----------------
function viewSize() { return { W: window.innerWidth, H: window.innerHeight }; }

/** Focal length in CSS pixels at zoom 1. */
function baseFocal() {
  const { W, H } = viewSize();
  const half = (settings.fov * D2R) / 2;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (state.mode === 'live' && vw && vh) {
    const scale = Math.max(W / vw, H / vh); // object-fit: cover
    return (Math.max(vw, vh) / 2) / Math.tan(half) * scale;
  }
  return (Math.max(W, H) / 2) / Math.tan(half);
}

function currentQuat() {
  if (!orient.q) return null;
  return qmul(qmul(qaxis(0, 0, 1, settings.headingOffset), orient.q), qaxis(0, 0, 1, settings.rollOffset || 0));
}

// ---------------- rendering ----------------
const KIND_STYLE = {
  city: { color: '#ffffff', size: 17, weight: 800 },
  town: { color: '#ffffff', size: 15, weight: 700 },
  village: { color: '#bfe6ff', size: 13, weight: 600 },
  hamlet: { color: '#bfe6ff', size: 12, weight: 500 },
  peak: { color: '#ffd34d', size: 15, weight: 700 },
  volcano: { color: '#ffb36b', size: 15, weight: 700 },
  water: { color: '#5fd1ff', size: 15, weight: 700 },
  valley: { color: '#b8f28c', size: 15, weight: 700 },
  region: { color: '#b8f28c', size: 16, weight: 800 },
  viewpoint: { color: '#ffffff', size: 12, weight: 600 },
  castle: { color: '#e9c8ff', size: 14, weight: 700 },
  fort: { color: '#e9c8ff', size: 14, weight: 700 },
  archaeological_site: { color: '#e9c8ff', size: 13, weight: 600 },
  ruins: { color: '#e9c8ff', size: 12, weight: 500 },
  junction: { color: '#ffe9a8', size: 12, weight: 600 },
};

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const { W, H } = viewSize();
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

function fmtKm(m) { return m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toString(); }

function render() {
  requestAnimationFrame(render);
  const { W, H } = viewSize();
  ctx.clearRect(0, 0, W, H);
  state.placed = [];
  const q = currentQuat();
  if (!q || !state.obs) { updateHud(null); return; }
  const qi = qconj(q);
  const f = baseFocal() * state.zoom;
  const cx = W / 2, cy = H / 2 + settings.pitchOffset * state.zoom;
  const project = (v) => {
    const d = qrot(qi, v);
    const depth = -d[2];
    if (depth < 0.08) return null;
    return [cx + f * d[0] / depth, cy - f * d[1] / depth];
  };

  // Skyline
  if (settings.showSkyline && state.skyline) {
    ctx.save();
    if (state.mode === 'demo') drawDemoTerrain(project, W, H);
    else if (state.night) drawDemoTerrain(project, W, H, 'rgba(24, 34, 52, 0.72)');
    ctx.strokeStyle = state.night ? 'rgba(255, 221, 110, 0.95)' : 'rgba(255, 211, 77, 0.75)';
    ctx.lineWidth = state.night ? 2 : 1.5;
    ctx.beginPath();
    let prev = null;
    const n = state.skyline.length;
    for (let i = 0; i <= n; i++) {
      const az = (i % n) * state.skyStep * D2R;
      const pt = project(dirVector(az, state.skyline[i % n]));
      if (pt && prev && Math.abs(pt[0] - prev[0]) < W) ctx.lineTo(pt[0], pt[1]);
      else if (pt) ctx.moveTo(pt[0], pt[1]);
      prev = pt;
    }
    ctx.stroke();
    ctx.restore();
  }

  // Candidates
  const reach = 0.4 * state.zoom * settings.density; // km per score point
  const cands = [];
  for (const p of state.pois) {
    if (p.d == null || p.d < (p.kind === 'region' ? 4000 : 150)) continue;
    if (!p.visible && !settings.showHidden) continue;
    if (p.d / 1000 > p.score * reach) continue;
    const pt = project(dirVector(p.brg, p.angle));
    if (!pt || pt[0] < -40 || pt[0] > W + 40 || pt[1] < -200 || pt[1] > H + 40) continue;
    cands.push({ p, x: pt[0], y: pt[1], rank: p.score / (1 + p.d / 30000) + (p.visible ? 0 : -1000) });
  }
  cands.sort((a, b) => b.rank - a.rank);
  const maxLabels = Math.round(12 * settings.density * Math.sqrt(state.zoom));

  const ROW0 = 52, ROW_H = 40, LABEL_H = 34, MAX_ROWS = 8;
  const overlaps = (b) => state.placed.some((o) => b.x < o.x + o.w + 6 && b.x + b.w + 6 > o.x && b.y < o.y + o.h + 2 && b.y + b.h + 2 > o.y);

  ctx.textAlign = 'center';
  ctx.direction = 'rtl';
  for (const c of cands) {
    if (state.placed.length >= maxLabels) break;
    const st = KIND_STYLE[c.p.kind] || KIND_STYLE.village;
    const sub = `${fmtKm(c.p.d)} ק״מ${(c.p.kind === 'peak' || c.p.kind === 'volcano') && c.p.ele != null ? ` · ${Math.round(c.p.ele)} מ׳` : ''}`;
    ctx.font = `${st.weight} ${st.size}px system-ui, sans-serif`;
    const w1 = ctx.measureText(c.p.name).width;
    ctx.font = '500 11px system-ui, sans-serif';
    const w = Math.max(w1, ctx.measureText(sub).width) + 14;
    let box = null;
    for (let r = 0; r < MAX_ROWS; r++) {
      const b = { x: Math.max(4, Math.min(W - w - 4, c.x - w / 2)), y: ROW0 + r * ROW_H, w, h: LABEL_H };
      if (b.y + b.h > c.y - 10) break;
      if (!overlaps(b)) { box = b; break; }
    }
    if (!box) {
      // Point is near the top of the screen (looking up at something close): label below it.
      const b = { x: Math.max(4, Math.min(W - w - 4, c.x - w / 2)), y: c.y + 10, w, h: LABEL_H };
      if (b.y + b.h < H - 70 && !overlaps(b)) box = b;
    }
    if (!box) continue;
    box.p = c.p;
    state.placed.push(box);

    ctx.globalAlpha = c.p.visible ? 1 : 0.45;
    // leader line + anchor
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ly = box.y > c.y ? box.y : box.y + box.h;
    ctx.moveTo(c.x, ly);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
    ctx.fillStyle = st.color;
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fill();
    // box
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, box.x, box.y, box.w, box.h, 8); ctx.fill();
    ctx.fillStyle = st.color;
    ctx.font = `${st.weight} ${st.size}px system-ui, sans-serif`;
    ctx.fillText(c.p.name, box.x + box.w / 2, box.y + 4 + st.size * 0.85);
    ctx.fillStyle = '#d6dbe4';
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillText(sub, box.x + box.w / 2, box.y + box.h - 4);
    ctx.globalAlpha = 1;
  }
  if (settings.showRoads) drawRoads(project, W, H, overlaps);
  if (settings.showCompass) drawCompass(project, W, H);
  if (settings.showPrayer) drawPrayer(q, project, W, H);
  drawReticle(q, f, W, H, cx, cy);
  drawRivers(project, W, H, overlaps);
  updateHud(q);
}

/** Road-number shields, drawn on the road itself. A few per road, spread across the view. */
function drawRoads(project, W, H, overlaps) {
  const reachM = 12000 * state.zoom * settings.density;
  const byRef = new Map();
  for (const r of state.roads) {
    if (r.d == null || r.d < 350 || r.d > reachM || !r.visible) continue;
    const pt = project(dirVector(r.brg, r.angle));
    if (!pt || pt[0] < 20 || pt[0] > W - 20 || pt[1] < 60 || pt[1] > H - 80) continue;
    if (!byRef.has(r.ref)) byRef.set(r.ref, []);
    byRef.get(r.ref).push({ r, x: pt[0], y: pt[1] });
  }
  const perRef = state.zoom > 2 ? 3 : 2;
  const maxShields = Math.round(6 * Math.sqrt(state.zoom) * settings.density);
  // nearest roads first
  const groups = [...byRef.values()].map((g) => g.sort((a, b) => a.r.d - b.r.d)).sort((a, b) => a[0].r.d - b[0].r.d);
  let drawn = 0;
  ctx.font = '700 13px system-ui, sans-serif';
  for (const g of groups) {
    const chosen = [];
    for (const c of g) {
      if (chosen.length >= perRef || drawn >= maxShields) break;
      if (chosen.some((o) => Math.abs(o.x - c.x) < W / 4)) continue;
      const w = Math.max(28, ctx.measureText(c.r.ref).width + 12), h = 20;
      const box = { x: c.x - w / 2, y: c.y - h - 6, w, h };
      if (overlaps(box)) continue;
      box.p = c.r;
      state.placed.push(box);
      chosen.push(c);
      drawn++;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1a3a6b';
      ctx.lineWidth = 2;
      roundRect(ctx, box.x, box.y, box.w, box.h, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1a3a6b';
      ctx.fillText(c.r.ref, c.x, box.y + 15);
    }
  }
}

// ---------------- compass points ----------------
// A compass tape near the bottom of the screen: each tick sits at the screen x of that
// direction on the horizon. Ticks every 5°, longer every 15°, named every 45°.
const WINDS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
function drawCompass(project, W, H) {
  const y = H - 96;
  ctx.save();
  const band = ctx.createLinearGradient(0, y - 30, 0, y + 12);
  band.addColorStop(0, 'rgba(0,0,0,0)'); band.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = band; ctx.fillRect(0, y - 30, W, 42);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1;
  for (let deg = 0; deg < 360; deg += 5) {
    const pt = project(dirVector(deg * D2R, 0));
    if (!pt || pt[0] < -40 || pt[0] > W + 40) continue;
    const x = pt[0];
    const major = deg % 45 === 0, mid = deg % 15 === 0;
    const len = major ? 12 : mid ? 7 : 4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - len); ctx.stroke();
    if (major) {
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.fillStyle = deg === 0 ? '#ff8a7a' : '#ffffff'; // north in red, like a compass needle
      ctx.fillText(WINDS[deg / 45], x, y - 16);
    } else if (mid) {
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(`${deg}°`, x, y - 12);
    }
  }
  ctx.restore();
}

// ---------------- prayer direction (Jerusalem, the Temple Mount) ----------------
const TEMPLE_MOUNT = { lat: 31.77806, lon: 35.23536 };
function drawPrayer(q, project, W, H) {
  const { d, brg } = distBearing(state.obs.lat, state.obs.lon, TEMPLE_MOUNT.lat, TEMPLE_MOUNT.lon);
  if (d < 150) return;
  // In and around Jerusalem the direction is to the Temple Mount itself.
  const name = d < 25000 ? 'הר הבית' : 'ירושלים';
  const gold = '#ffcf4a';
  // Close enough to really see it? Then it is also a place on the landscape.
  let seenAt = null;
  if (d < 8000 && state.dem.ready) {
    const g = state.dem.elevation(TEMPLE_MOUNT.lat, TEMPLE_MOUNT.lon);
    const h = (Number.isNaN(g) ? 740 : g) + 20;
    if (lineOfSight(state.dem, state.obs, TEMPLE_MOUNT, h, d, brg).clearance > -0.003) seenAt = project(dirVector(brg, elevationAngle(h - state.obs.h, d)));
  }
  const pt = project(dirVector(brg, 0));
  ctx.font = '700 14px system-ui, sans-serif';
  if (pt && pt[0] > 10 && pt[0] < W - 10) {
    const x = pt[0];
    // A direction, not a thing you see: a dashed line through the whole view,
    // and an outlined (not filled) chip at the bottom.
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 207, 74, 0.8)'; ctx.lineWidth = 2; ctx.setLineDash([3, 9]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.restore();
    if (seenAt) {
      ctx.fillStyle = gold; ctx.beginPath(); ctx.arc(seenAt[0], seenAt[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    }
    const label = `🧭 כיוון תפילה · ${name} ${fmtKm(d)} ק״מ${seenAt ? ' · נראה מכאן' : ''}`;
    const w = ctx.measureText(label).width + 20;
    const bx = Math.max(4, Math.min(W - w - 4, x - w / 2)), by = H - 168;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; roundRect(ctx, bx, by, w, 28, 14); ctx.fill();
    ctx.strokeStyle = gold; ctx.lineWidth = 1.5; ctx.setLineDash([]); roundRect(ctx, bx, by, w, 28, 14); ctx.stroke();
    ctx.fillStyle = gold; ctx.fillText(label, bx + w / 2, by + 19);
    return;
  }
  // off screen: an arrow on the side to turn towards
  const { heading } = cameraHeadingPitch(q);
  const rel = wrapPi(brg - heading);
  const left = rel < 0;
  // canvas text is right-to-left: the start of the string is drawn on the right
  const deg = Math.round(Math.abs(rel) * R2D);
  const txt = left ? `🧭 ${name} ${deg}° ◀` : `▶ ${name} ${deg}° 🧭`;
  const w = ctx.measureText(txt).width + 20;
  const bx = left ? 8 : W - w - 8, by = H / 2 - 74;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; roundRect(ctx, bx, by, w, 28, 14); ctx.fill();
  ctx.strokeStyle = gold; ctx.lineWidth = 1.5; roundRect(ctx, bx, by, w, 28, 14); ctx.stroke();
  ctx.fillStyle = gold; ctx.fillText(txt, bx + w / 2, by + 19);
}

// ---------------- "what's in the middle?" ----------------
let centerInfo = { t: 0, text: '' };
function lookAt(q, f, W, H, cx, cy) {
  // ray through the screen centre
  const d = qrot(q, [(W / 2 - cx) / f, -(H / 2 - cy) / f, -1]);
  const n = Math.hypot(d[0], d[1], d[2]);
  const az = (Math.atan2(d[0], d[1]) + 2 * Math.PI) % (2 * Math.PI);
  const el = Math.asin(d[2] / n);
  const obs = state.obs;
  // 1) a labelled place right in the middle (within ~1.5°)?
  let bestP = null, bestA = 1.5 * D2R;
  for (const p of state.pois) {
    if (p.d == null || !p.visible || p.kind === 'region' || p.d / 1000 > p.score * 0.4 * state.zoom * settings.density * 2) continue;
    const da = Math.hypot(wrapPi(p.brg - az) * Math.cos(el), p.angle - el);
    if (da < bestA) { bestA = da; bestP = p; }
  }
  if (bestP) return `${bestP.name} · ${fmtKm(bestP.d)} ק״מ`;
  if (!state.dem.ready) return '';
  // 2) march the ray over the terrain
  const cosLat = Math.cos(obs.lat * D2R);
  const tanEl = Math.tan(el);
  let s = 200, hit = null;
  while (s < 75000) {
    const la = obs.lat + Math.cos(az) * s / 111195, lo = obs.lon + Math.sin(az) * s / (111195 * cosLat);
    const g = state.dem.elevation(la, lo);
    if (!Number.isNaN(g) && g >= obs.h + s * tanEl - curvatureDrop(s)) { hit = { la, lo, s }; break; }
    s += Math.max(30, s * 0.01);
  }
  if (!hit) return el > 0 ? 'שמיים' : '';
  // nearest named place to the spot we hit
  let near = null, nd = Infinity;
  for (const p of state.pois) {
    if (p.kind === 'region' || p.kind === 'road' || p.kind === 'junction') continue;
    const dd = distBearing(hit.la, hit.lo, p.lat, p.lon).d;
    if (dd < nd) { nd = dd; near = p; }
  }
  const where = near && nd < Math.max(1500, hit.s * 0.15) ? (nd < 400 ? near.name : `ליד ${near.name}`) : 'שטח פתוח';
  return `${where} · ${fmtKm(hit.s)} ק״מ`;
}

function drawReticle(q, f, W, H, cx, cy) {
  if (window.__noReticle) return;
  const now = performance.now();
  if (now - centerInfo.t > 300) { centerInfo = { t: now, text: lookAt(q, f, W, H, cx, cy) }; }
  const x = W / 2, y = H / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 14, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 14, y);
  ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 14);
  ctx.stroke();
  if (!centerInfo.text) return;
  ctx.font = '700 14px system-ui, sans-serif';
  const w = ctx.measureText(centerInfo.text).width + 18;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, x - w / 2, y + 22, w, 26, 13); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(centerInfo.text, x, y + 40);
}

/** River names: one label per river, on its nearest visible stretch. */
function drawRivers(project, W, H, overlaps) {
  const reachM = 8000 * state.zoom * settings.density;
  const best = new Map();
  for (const r of state.rivers) {
    if (r.d == null || r.d < 200 || r.d > reachM || !r.visible) continue;
    const cur = best.get(r.ref);
    if (cur && cur.d <= r.d) continue;
    best.set(r.ref, r);
  }
  const maxRivers = Math.round(3 * Math.sqrt(state.zoom) * settings.density);
  let n = 0;
  ctx.font = 'italic 600 13px system-ui, sans-serif';
  for (const r of [...best.values()].sort((a, b) => a.d - b.d)) {
    if (n >= maxRivers) break;
    const pt = project(dirVector(r.brg, r.angle));
    if (!pt || pt[0] < 20 || pt[0] > W - 20 || pt[1] < 60 || pt[1] > H - 80) continue;
    const w = ctx.measureText(r.name).width + 10;
    const box = { x: pt[0] - w / 2, y: pt[1] - 24, w, h: 20 };
    if (overlaps(box)) continue;
    box.p = r;
    state.placed.push(box);
    n++;
    ctx.fillStyle = 'rgba(0,30,60,0.55)';
    roundRect(ctx, box.x, box.y, box.w, box.h, 6); ctx.fill();
    ctx.fillStyle = '#7fd8ff';
    ctx.fillText(r.name, pt[0], box.y + 15);
    ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

/** Demo mode has no camera: paint the computed ridge line as a silhouette so it looks like a view. */
function drawDemoTerrain(project, W, H, fill = '#3b4a33') {
  const n = state.skyline.length;
  ctx.fillStyle = fill;
  ctx.beginPath();
  let started = false, prev = null;
  for (let i = 0; i <= n; i++) {
    const az = (i % n) * state.skyStep * D2R;
    const pt = project(dirVector(az, state.skyline[i % n]));
    if (pt && prev && Math.abs(pt[0] - prev[0]) < W) ctx.lineTo(pt[0], pt[1]);
    else if (pt) {
      if (started) { ctx.lineTo(prev[0], H + 10); ctx.closePath(); }
      ctx.moveTo(pt[0], H + 10); ctx.lineTo(pt[0], pt[1]); started = true;
    }
    if (!pt && started && prev) { ctx.lineTo(prev[0], H + 10); ctx.closePath(); started = false; }
    prev = pt;
  }
  if (started && prev) { ctx.lineTo(prev[0], H + 10); ctx.closePath(); }
  ctx.fill();
}

// ---------------- auto-align ----------------
// Find the sky/land boundary in the camera image and slide the computed ridge line onto it.
function grabFrame(cw) {
  const { W, H } = viewSize();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const k = cw / W, ch = Math.round(H * k);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  const sc = Math.max(W / vw, H / vh) * state.zoom;
  const dw = vw * sc, dh = vh * sc;
  g.drawImage(video, 0, 0, vw, vh, (W - dw) / 2 * k, (H - dh) / 2 * k, dw * k, dh * k);
  return { px: g.getImageData(0, 0, cw, ch).data, cw, ch, k };
}

/**
 * The skyline in the camera image, as one continuous line across the frame.
 * 1. "skyness" per pixel: sky (even hazy sky, clouds) is bluish-grey and bright; land is
 *    brown, green or dark. 2. Edge strength where sky above turns into land below, counted
 *    only where the region above looks like sky. 3. Dynamic programming finds the strongest
 *    path from left to right that moves at most 2 px per column, so a pole or a tree does
 *    not derail it. Columns where the path has no real edge are reported as NaN.
 */
function detectHorizon(cw) {
  const fr = grabFrame(cw);
  if (!fr) return null;
  const { px, ch, k } = fr;
  const v = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
    v[i] = 2 * (b - r) + 0.3 * ((r + gg + b) / 3 - 150);
  }
  // edge score
  const E = new Float32Array(cw * ch);
  const y0 = Math.max(3, Math.round(ch * 0.05));
  for (let x = 0; x < cw; x++) {
    let skySum = 0, skyN = 0;
    for (let y = 0; y < ch; y++) {
      if (y >= 1) { skySum += v[(y - 1) * cw + x] > 5 ? 1 : 0; skyN++; }
      if (y < y0 || y >= ch - 3) continue;
      const above = (v[(y - 3) * cw + x] + v[(y - 2) * cw + x] + v[(y - 1) * cw + x]) / 3;
      const below = (v[y * cw + x] + v[(y + 1) * cw + x] + v[(y + 2) * cw + x]) / 3;
      let e = above - below;
      if (e <= 0) continue;
      if (above > 15 && below < -5) e += 40;   // clear sky over land
      e *= skySum / skyN > 0.6 ? 1 : 0.25;      // mostly sky above this point?
      E[y * cw + x] = Math.min(e, 200);
    }
  }
  // dynamic programming, left to right
  const STEP = 2, PEN = 6;
  const dp = new Float32Array(cw * ch), from = new Int16Array(cw * ch);
  for (let y = 0; y < ch; y++) dp[y * cw] = E[y * cw];
  for (let x = 1; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      let best = -Infinity, by = y;
      for (let d = -STEP; d <= STEP; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= ch) continue;
        const val = dp[yy * cw + x - 1] - PEN * Math.abs(d);
        if (val > best) { best = val; by = yy; }
      }
      dp[y * cw + x] = best + E[y * cw + x];
      from[y * cw + x] = by;
    }
  }
  let y = 0;
  for (let yy = 1; yy < ch; yy++) if (dp[yy * cw + cw - 1] > dp[y * cw + cw - 1]) y = yy;
  const ys = new Float32Array(cw).fill(NaN);
  let strong = 0;
  for (let x = cw - 1; x >= 0; x--) {
    if (E[y * cw + x] > 25) { ys[x] = y / k; strong++; }
    if (x > 0) y = from[y * cw + x];
  }
  return strong >= cw * 0.3 ? ys : null;
}

window.__detectHorizon = (cw) => detectHorizon(cw); // tests

/**
 * Find the correction that puts the computed ridge line onto the ridge in the camera image:
 * horizontal shift (heading), vertical shift (pitch), rotation (roll) and scale (field of view).
 *
 * Instead of deciding which pixels are "sky" (distant hazy mountains are as blue as the sky),
 * we slide the predicted ridge line over the image and score each position by how well it
 * sits on a brightness edge (brighter above: sky over land) with smooth, sky-like texture
 * just above it. Trees or roofs that hide part of the ridge simply contribute nothing.
 */
function computeAlign({ rolls = [0], scales = [1], rangeX = 0.3, rangeY = 0.2, step = 1, around = null } = {}) {
  const { W, H } = viewSize();
  if (!state.skyline || !orient.q) return { error: 'אין עדיין קו רכס מחושב' };
  const cw = 200;
  const fr = grabFrame(cw);
  if (!fr) return { error: 'אין תמונת מצלמה' };
  const { px, ch, k } = fr;
  // luminance, vertical edge strength G and texture T (just above each point)
  const L = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) L[i] = 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2];
  const G = new Float32Array(cw * ch), T = new Float32Array(cw * ch);
  for (let x = 0; x < cw; x++) {
    const cum = new Float32Array(ch);
    for (let y = 1; y < ch; y++) cum[y] = cum[y - 1] + Math.abs(L[y * cw + x] - L[(y - 1) * cw + x]);
    for (let y = 3; y < ch - 3; y++) {
      const above = (L[(y - 2) * cw + x] + L[(y - 1) * cw + x]) / 2;
      const below = (L[(y + 1) * cw + x] + L[(y + 2) * cw + x]) / 2;
      G[y * cw + x] = Math.max(0, above - below) + 0.25 * Math.abs(above - below);
      const y1 = Math.max(1, y - 9), y2 = Math.max(1, y - 2);
      T[y * cw + x] = (cum[y2] - cum[y1]) / Math.max(1, y2 - y1);
    }
  }
  // allow ±1 px: take the best edge in a 3-px window
  const S = new Float32Array(cw * ch);
  for (let x = 0; x < cw; x++) {
    for (let y = 4; y < ch - 4; y++) {
      let g = G[y * cw + x];
      if (G[(y - 1) * cw + x] > g) g = G[(y - 1) * cw + x];
      if (G[(y + 1) * cw + x] > g) g = G[(y + 1) * cw + x];
      S[y * cw + x] = Math.min(g, 60) - 1.5 * Math.min(T[y * cw + x], 30);
    }
  }
  const q = currentQuat(), qi = qconj(q);
  const f = baseFocal() * state.zoom;
  const cx = W / 2, cy = H / 2 + settings.pitchOffset * state.zoom;
  // predicted ridge points, in grid units
  const pts = [];
  const n = state.skyline.length;
  for (let i = 0; i < n * 4; i++) {
    const az = (i / 4) * state.skyStep * D2R;
    const a2 = state.skyline[Math.floor(i / 4)] * (1 - (i % 4) / 4) + state.skyline[(Math.floor(i / 4) + 1) % n] * ((i % 4) / 4);
    const d = qrot(qi, dirVector(az, a2));
    if (-d[2] < 0.1) continue;
    const x = cx + f * d[0] / -d[2];
    if (x < -W || x > 2 * W) continue;
    pts.push([x * k, (cy - f * d[1] / -d[2]) * k]);
  }
  const ex = Math.round(cw * rangeX), ey = Math.round(ch * rangeY);
  const gx0 = cw / 2, gy0 = ch / 2;
  let best = null;
  const all = [];
  let bestAtZeroX = -Infinity;
  for (const r of rolls) {
    const cr = Math.cos(r), sr = Math.sin(r);
    for (const sc of scales) {
      const pred = new Float32Array(cw + 2 * ex).fill(NaN);
      for (const [x, y] of pts) {
        const X = gx0 + sc * ((x - gx0) * cr - (y - gy0) * sr);
        const Y = gy0 + sc * ((x - gx0) * sr + (y - gy0) * cr);
        const xi = Math.round(X) + ex;
        if (xi >= 0 && xi < pred.length && (Number.isNaN(pred[xi]) || Y < pred[xi])) pred[xi] = Y;
      }
      for (let x = 1; x < pred.length; x++) if (Number.isNaN(pred[x]) && !Number.isNaN(pred[x - 1])) pred[x] = pred[x - 1];
      // search window (grid units), optionally around a previous coarse result
      const ax = around ? Math.round(around.sx * k) : 0, ay = around ? Math.round(around.sy * k) : 0;
      const wx = around ? 3 : ex, wy = around ? 3 : ey;
      for (let sx = ax - wx; sx <= ax + wx; sx += step) {
        if (Math.abs(sx) > ex) continue;
        for (let sy = ay - wy; sy <= ay + wy; sy += step) {
          let sum = 0, cnt = 0;
          for (let i = 0; i < cw; i += 2) {
            const py = pred[i - sx + ex];
            if (py === undefined || Number.isNaN(py)) continue;
            const y = Math.round(py + sy);
            if (y < 4 || y >= ch - 4) continue;
            sum += S[y * cw + i]; cnt++;
          }
          if (cnt < cw * 0.2) continue; // need at least 40% of the columns (every 2nd)
          // prefer small changes (compass errors are usually < 15°)
          const score = sum / cnt - Math.abs(r) * R2D * 0.4 - Math.abs(sc - 1) * 20 - Math.abs(sx / k / f) * R2D * 0.08;
          all.push(score);
          if (sx === 0 && score > bestAtZeroX) bestAtZeroX = score;
          if (!best || score > best.score) best = { sx: sx / k, sy: sy / k, roll: r, scale: sc, score, cnt };
        }
      }
    }
  }
  if (!best) return { error: 'הקו המחושב מחוץ לתמונה' };
  all.sort((a, b) => a - b);
  const med = all[Math.floor(all.length / 2)];
  const p90 = all[Math.floor(all.length * 0.9)];
  // how much the best stands out from the crowd
  best.conf = (best.score - p90) / Math.max(1, p90 - med);
  best.horizontalReliable = best.score - bestAtZeroX > 0.15 * Math.max(1, best.score - med);
  best.f = f; best.H = H;
  best.offDeg = Math.hypot(best.sx, best.sy) / f * R2D + Math.abs(best.roll) * R2D * 0.3;
  window.__lastAlign = best;
  return best;
}

/** Calibration quality for the badge: is there a clear ridge, and how far is our line from it? */
function updateCalibLevel(r) {
  let level = 'unknown';
  if (!r.error && r.conf > 1.2) level = r.offDeg < 0.4 ? 'good' : r.offDeg < 1.2 ? 'fair' : 'bad';
  state.calib = { level, t: performance.now() };
}

/** Apply a fit. `k` < 1 applies part of it (gentle continuous correction). */
function applyAlign(r, k = 1, { allowScale = false } = {}) {
  if (r.horizontalReliable) settings.headingOffset += k * r.sx / r.f;
  settings.pitchOffset += k * r.sy / state.zoom;
  settings.rollOffset = (settings.rollOffset || 0) + k * ROLL_SIGN * r.roll;
  if (allowScale && r.scale !== 1) {
    // predicted features must spread by `scale`: f *= scale  =>  tan(fov/2) /= scale
    settings.fov = 2 * Math.atan(Math.tan(settings.fov * D2R / 2) / r.scale) * R2D;
    settings.fov = Math.round(Math.max(40, Math.min(100, settings.fov)) * 10) / 10;
  }
  orient.lock();
}
const ROLL_SIGN = 1;

function say(t, ms = 3500) {
  const h = $('calib-hint');
  h.textContent = t; h.hidden = false;
  clearTimeout(say.t); say.t = setTimeout(() => { h.hidden = true; }, ms);
}

/** The 🎯 button: a wide search, including roll and field of view. */
function autoAlign() {
  const rolls = [], scales = [];
  for (let r = -3; r <= 3; r += 1.5) rolls.push(r * D2R);
  for (let sc = 0.96; sc <= 1.0401; sc += 0.04) scales.push(Math.round(sc * 100) / 100);
  const coarse = computeAlign({ rolls, scales, rangeX: 0.35, rangeY: 0.3, step: 2 });
  const r = coarse.error ? coarse : computeAlign({ rolls: [coarse.roll], scales: [coarse.scale], rangeX: 0.35, rangeY: 0.3, around: coarse });
  if (!r.error) { r.conf = coarse.conf; r.horizontalReliable = coarse.horizontalReliable; }
  updateCalibLevel(r);
  if (r.error) { say(r.error); return; }
  if (r.conf < 1.2) { say('לא הצלחתי לזהות את קו הרכס בתמונה בביטחון. נסה לכוון לנוף פתוח, או גרור ידנית.'); return; }
  applyAlign(r, 1, { allowScale: true });
  saveSettings();
  rememberCalibration();
  state.calib = { level: 'good', t: performance.now() };
  const parts = [r.horizontalReliable ? `${(r.sx / r.f * R2D).toFixed(1)}° אופקי` : 'כיוון ללא שינוי (רכס שטוח)', `${(Math.atan(r.sy / r.f) * R2D).toFixed(1)}° אנכי`];
  if (r.roll) parts.push(`${(r.roll * R2D).toFixed(1)}° הטיה`);
  if (r.scale !== 1) parts.push(`שדה ראייה ${settings.fov.toFixed(0)}°`);
  say(`יושר: ${parts.join(', ')}`);
  checkCompassHealth();
}

// Continuous: every few seconds measure how well the ridge matches (for the badge) and,
// if enabled, nudge the calibration halfway, only when the match is clearly good and modest.
let lastInteraction = 0;
function continuousAlignTick() {
  if (state.mode !== 'live' || gesture || document.visibilityState !== 'visible' || state.night) return;
  if (performance.now() - lastInteraction < 3000) return;
  const r = computeAlign({ rolls: [-1 * D2R, 0, 1 * D2R], scales: [1], rangeX: 0.12, rangeY: 0.1 });
  updateCalibLevel(r);
  if (!settings.autoAlign || state.drive.active || r.error || r.conf < 2) return;
  if (r.offDeg > 5) return; // too big to trust silently
  applyAlign(r, 0.5);
}
setInterval(continuousAlignTick, 2500);

// ---------------- calibration memory per place ----------------
const CALIB_KEY = 'ma-roim:calib-by-place:v1';
const placeKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`; // ~1 km cells
function loadCalibMap() { try { return JSON.parse(localStorage.getItem(CALIB_KEY) || '{}'); } catch { return {}; } }
function rememberCalibration() {
  if (!state.obs) return;
  const m = loadCalibMap();
  m[placeKey(state.obs.lat, state.obs.lon)] = { h: settings.headingOffset, p: settings.pitchOffset, r: settings.rollOffset || 0, t: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > 300) keys.sort((x, y) => m[x].t - m[y].t).slice(0, keys.length - 300).forEach((k) => delete m[k]);
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
let lastPlace = null;
function recallCalibration(lat, lon) {
  const k = placeKey(lat, lon);
  if (k === lastPlace) return;
  lastPlace = k;
  const c = loadCalibMap()[k];
  if (c && !state.drive.active) {
    settings.headingOffset = c.h; settings.pitchOffset = c.p; settings.rollOffset = c.r ?? 0;
    orient.lock();
    say('נטען כיול ששמרת במקום הזה');
  }
}

// ---------------- compass health ----------------
// The web gives no compass-accuracy value on Android, but a large correction is a strong hint.
let compassWarned = false;
function checkCompassHealth() {
  if (compassWarned || state.drive.active) return;
  if (Math.abs(wrapPi(settings.headingOffset)) > 15 * D2R) {
    compassWarned = true;
    say('המצפן סוטה בהרבה מעלות. כדאי לכייל אותו: לנפנף את הטלפון כמה פעמים בצורת 8 באוויר, הרחק ממתכת ומרכב.', 9000);
  }
}

// ---------------- debug capture ----------------
// Saves the raw camera frame plus everything needed to replay the calibration offline:
// sensors, offsets, field of view, location, the detected and predicted ridge. The JSON
// is written both as a text strip at the bottom of the image and inside the JPEG.
function jpegWithComment(bytes, text) {
  const enc = new TextEncoder().encode(text);
  const len = Math.min(enc.length, 65533);
  const seg = new Uint8Array(4 + len);
  seg[0] = 0xFF; seg[1] = 0xFE; seg[2] = ((len + 2) >> 8) & 0xFF; seg[3] = (len + 2) & 0xFF;
  seg.set(enc.subarray(0, len), 4);
  const out = new Uint8Array(bytes.length + seg.length);
  out.set(bytes.subarray(0, 2), 0); out.set(seg, 2); out.set(bytes.subarray(2), 2 + seg.length);
  return out;
}

async function captureDebug() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) { say('אין תמונת מצלמה לשמור'); return; }
  const { W, H } = viewSize();
  let fit = null;
  try { fit = computeAlign({ rolls: [0], scales: [1], rangeX: 0.2, rangeY: 0.2 }); } catch { /* ignore */ }
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const meta = {
    v: VERSION, t: new Date().toISOString(),
    obs: state.obs && { lat: r3(state.obs.lat * 1000) / 1000, lon: r3(state.obs.lon * 1000) / 1000, h: r3(state.obs.h), acc: state.obs.acc },
    q: orient.q?.map(r3), qAbs: orient.qAbs?.map(r3), qRel: orient.qRel?.map(r3), delta: r3(orient.delta), src: orient.source,
    off: { h: r3(settings.headingOffset), p: r3(settings.pitchOffset), r: r3(settings.rollOffset || 0) },
    fov: settings.fov, zoom: r3(state.zoom), view: [W, H, window.devicePixelRatio], video: [vw, vh],
    scr: screen.orientation?.angle ?? 0, drive: state.drive.active, speed: state.drive.speed,
    calib: state.calib?.level, fit: fit && !fit.error ? { sx: r3(fit.sx), sy: r3(fit.sy), roll: r3(fit.roll), conf: r3(fit.conf), off: r3(fit.offDeg) } : fit?.error,
  };
  const json = JSON.stringify(meta);
  // image: full camera frame + text strip
  const lines = json.match(/.{1,110}/g) || [];
  const fs = Math.max(14, Math.round(vw / 90)), lh = Math.round(fs * 1.3);
  const c = document.createElement('canvas');
  c.width = vw; c.height = vh + lines.length * lh + 10;
  const g = c.getContext('2d');
  g.drawImage(video, 0, 0, vw, vh);
  g.fillStyle = '#fff'; g.fillRect(0, vh, vw, c.height - vh);
  g.fillStyle = '#000'; g.font = `${fs}px monospace`; g.direction = 'ltr'; g.textAlign = 'left';
  lines.forEach((l, i) => g.fillText(l, 6, vh + (i + 1) * lh));
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
  const bytes = jpegWithComment(new Uint8Array(await blob.arrayBuffer()), json);
  const name = `ma-roim-${meta.t.replace(/[:.]/g, '-')}.jpg`;
  let where = '';
  try {
    const P = window.Capacitor?.Plugins;
    if (P?.Filesystem) {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const data = btoa(bin);
      try {
        await P.Filesystem.writeFile({ path: `ma-roim/${name}`, data, directory: 'DOCUMENTS', recursive: true });
        where = 'בתיקייה Documents/ma-roim';
      } catch {
        // no access to shared Documents: fall back to the share sheet
        const { uri } = await P.Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
        await P.Share?.share({ title: 'מה רואים – בדיקה', files: [uri] });
        where = 'במקום שבחרת בשיתוף';
      }
    } else {
      const file = new File([bytes], name, { type: 'image/jpeg' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      where = 'בהורדות';
    }
    $('sent-where').textContent = where;
    $('sent-name').textContent = name;
    $('sent').hidden = false;
  } catch (e) {
    if (e?.name !== 'AbortError') say(`השמירה נכשלה: ${e.message || e}`);
  }
}
const INBOX_URL = 'https://claude.ai/artifact/R5xmjq1c9Mc5FvMFKwnbmZ';
$('btn-open-inbox').onclick = () => {
  $('sent').hidden = true;
  if (window.Capacitor) location.href = INBOX_URL; // the app hands it to the browser / Claude app
  else window.open(INBOX_URL, '_blank');
};
$('btn-close-sent').onclick = () => { $('sent').hidden = true; };
window.__captureDebug = captureDebug; // tests

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

let hudTick = 0;
function updateHud(q) {
  if (++hudTick % 6) return;
  if (q) {
    const { heading, pitch } = cameraHeadingPitch(q);
    $('heading').textContent = `${Math.round(heading * R2D)}° ${compassName(heading)}  ·  ${pitch >= 0 ? '+' : ''}${Math.round(pitch * R2D)}°`;
  } else {
    $('heading').textContent = state.obs ? 'ממתין לחיישני כיוון…' : 'ממתין למיקום…';
  }
  const s = state.status;
  const badge = $('calib-badge');
  const lvl = state.calib && performance.now() - state.calib.t < 15000 ? state.calib.level : 'unknown';
  badge.className = `calib-${lvl}`;
  badge.textContent = { good: '✓ מכויל', fair: '≈ כמעט', bad: '✗ לא מכויל', unknown: '' }[lvl];
  const parts = [state.night ? '🌙 מצב לילה' : '', state.drive.active ? '🚗 כיוון לפי נסיעה' : '', s.gps, s.data || (state.pois.length ? `${state.pois.length} מקומות` : ''), s.dem].filter(Boolean);
  $('status').textContent = parts.join(' · ');
  $('zoom-label').textContent = state.zoom > 1.05 ? `×${state.zoom.toFixed(1)}` : '';
}

// ---------------- gestures ----------------
const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (e) => {
  lastInteraction = performance.now();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { type: 'drag', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    setZoom(gesture.zoom * d / gesture.dist);
  } else if (gesture.type === 'drag') {
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    gesture.x = e.clientX; gesture.y = e.clientY;
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy));
    if (gesture.moved < 8) return;
    const f = baseFocal() * state.zoom;
    if (state.mode === 'demo') {
      state.demHeading = ((state.demHeading - dx / f) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      $('demo-heading').value = (state.demHeading * R2D).toFixed(1);
      orient.setManual(state.demHeading, 0);
    } else {
      settings.headingOffset += dx / f;
      settings.pitchOffset += dy / state.zoom;
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture?.type === 'drag' && pointers.size === 0) {
    if (gesture.moved < 8) onTap(e.clientX, e.clientY);
    else { orient.lock(); saveSettings(); rememberCalibration(); checkCompassHealth(); }
  }
  if (pointers.size === 0) gesture = null;
  else if (pointers.size === 1) gesture = null; // finishing a pinch: don't turn the leftover finger into a drag
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY / 400)); }, { passive: false });

function setZoom(z) {
  state.zoom = Math.max(1, Math.min(8, z));
  video.style.transform = `scale(${state.zoom})`;
}

function onTap(x, y) {
  const hit = state.placed.find((b) => x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4);
  if (hit) showInfo(hit.p);
}

function showInfo(p) {
  $('info-name').textContent = p.name;
  const lines = [KIND_HE[p.kind] || p.kind, `${fmtKm(p.d)} ק״מ`, `כיוון ${Math.round(p.brg * R2D)}°`];
  if (p.kind === 'road') lines.splice(0, 1);
  if (p.kind === 'road') { /* nothing more */ } else if (p.ele != null) lines.push(`גובה ${Math.round(p.ele)} מ׳`);
  else if (p.h != null && p.kind !== 'water') lines.push(`גובה ~${Math.round(p.h)} מ׳`);
  if (p.pop) lines.push(`${p.pop.toLocaleString('he-IL')} תושבים`);
  if (!p.visible) lines.push('כנראה מוסתר מאחורי רכס');
  if (p.nameLocal && p.nameLocal !== p.name) lines.push(p.nameLocal);
  $('info-body').textContent = lines.join(' · ');
  const wiki = $('info-wiki');
  if (p.wikipedia) {
    const [lang, ...rest] = p.wikipedia.split(':');
    wiki.href = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(rest.join(':'))}`;
    wiki.hidden = false;
  } else if (p.wikidata) {
    wiki.href = `https://www.wikidata.org/wiki/${p.wikidata}`;
    wiki.hidden = false;
  } else wiki.hidden = true;
  $('info-map').href = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  $('info').hidden = false;
  showDriveTime(p);
  showWiki(p);
}

let wikiReq = 0;
/** Short Wikipedia summary (Hebrew preferred) with a thumbnail. */
async function showWiki(p) {
  const box = $('info-extract'), img = $('info-img');
  box.textContent = ''; img.hidden = true;
  const my = ++wikiReq;
  try {
    let lang = null, title = null;
    if (p.wikipedia) { [lang, ...title] = p.wikipedia.split(':'); title = title.join(':'); }
    if (p.wikidata && lang !== 'he') {
      const j = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${p.wikidata}&props=sitelinks&sitefilter=hewiki|enwiki&format=json&origin=*`)).json();
      const sl = j.entities?.[p.wikidata]?.sitelinks || {};
      if (sl.hewiki) { lang = 'he'; title = sl.hewiki.title; } else if (!title && sl.enwiki) { lang = 'en'; title = sl.enwiki.title; }
    }
    if (!title || my !== wikiReq) return;
    const r = await (await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`)).json();
    if (my !== wikiReq) return;
    const text = r.extract || '';
    box.textContent = text.length > 420 ? `${text.slice(0, 400).replace(/\s\S*$/, '')}…` : text;
    box.dir = lang === 'he' ? 'rtl' : 'ltr';
    const wiki = $('info-wiki');
    wiki.href = r.content_urls?.mobile?.page || wiki.href; wiki.hidden = false;
    if (r.thumbnail?.source) { img.src = r.thumbnail.source; img.hidden = false; }
  } catch { /* offline or no article */ }
}

let driveReq = 0;
/** Driving time from here (public OSRM demo router). Shown when it arrives; silently skipped on error. */
async function showDriveTime(p) {
  const el = $('info-drive');
  el.textContent = '';
  if (!state.obs || p.kind === 'region' || p.d < 500) return;
  const my = ++driveReq;
  el.textContent = '🚗 מחשב זמן נסיעה…';
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${state.obs.lon},${state.obs.lat};${p.lon},${p.lat}?overview=false`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    if (my !== driveReq) return;
    const r = j.routes?.[0];
    if (!r) { el.textContent = ''; return; }
    const min = Math.round(r.duration / 60);
    const dur = min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} שע׳`;
    // Snapping to the nearest road can land far away (e.g. a peak with no road).
    el.textContent = `🚗 כ-${dur} נסיעה (${fmtKm(r.distance)} ק״מ בכביש)`;
  } catch {
    if (my === driveReq) el.textContent = '';
  }
}
$('btn-close-info').onclick = () => { $('info').hidden = true; };

// ---------------- settings UI ----------------
function bindSettings() {
  const fov = $('fov'), dens = $('density');
  fov.value = settings.fov; $('fov-out').textContent = settings.fov;
  dens.value = settings.density; $('density-out').textContent = settings.density;
  $('show-hidden').checked = settings.showHidden;
  $('show-skyline').checked = settings.showSkyline;
  $('show-roads').checked = settings.showRoads;
  $('show-prayer').checked = settings.showPrayer;
  $('show-compass').checked = settings.showCompass;
  $('show-compass').onchange = (e) => { settings.showCompass = e.target.checked; saveSettings(); };
  $('show-prayer').onchange = (e) => { settings.showPrayer = e.target.checked; saveSettings(); };
  $('drive-mode').checked = settings.driveMode;
  $('auto-align').checked = settings.autoAlign;
  $('auto-align').onchange = (e) => { settings.autoAlign = e.target.checked; saveSettings(); };
  $('drive-mode').onchange = (e) => { settings.driveMode = e.target.checked; saveSettings(); };
  $('btn-align').onclick = autoAlign;
  $('btn-capture').onclick = () => { $('settings').hidden = true; setTimeout(captureDebug, 300); };
  $('show-roads').onchange = (e) => { settings.showRoads = e.target.checked; saveSettings(); };
  fov.oninput = () => { settings.fov = +fov.value; $('fov-out').textContent = fov.value; saveSettings(); };
  dens.oninput = () => { settings.density = +dens.value; $('density-out').textContent = dens.value; saveSettings(); };
  $('show-hidden').onchange = (e) => { settings.showHidden = e.target.checked; saveSettings(); };
  $('show-skyline').onchange = (e) => { settings.showSkyline = e.target.checked; saveSettings(); };
  $('btn-settings').onclick = () => {
    $('debug').textContent = `גרסה ${VERSION} · ${state.lastError ? `שגיאה: ${state.lastError} · ` : ''}חיישן: ${orient.source}${orient.usingGyro ? ' ✓' : ''} · הטיה ${((settings.rollOffset || 0) * R2D).toFixed(1)}° · תיקון מצפן: ${(settings.headingOffset * R2D).toFixed(1)}° · מיקום: ${state.obs ? `${state.obs.lat.toFixed(4)}, ${state.obs.lon.toFixed(4)}, ${Math.round(state.obs.h ?? 0)} מ׳` : '—'}`;
    $('settings').hidden = false;
  };
  $('btn-close-settings').onclick = () => { $('settings').hidden = true; };
  $('btn-refresh').onclick = () => { $('settings').hidden = true; if (state.obs) loadAll(true); };
  $('btn-calib').onclick = () => {
    settings.headingOffset = 0; settings.pitchOffset = 0; settings.rollOffset = 0; saveSettings();
    const hint = $('calib-hint');
    hint.hidden = false;
    setTimeout(() => { hint.hidden = true; }, 4000);
  };
}

// ---------------- start ----------------
function showMain() {
  $('start').hidden = true;
  $('hud').hidden = false;
  $('toolbar').hidden = false;
  resize();
  requestAnimationFrame(render);
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed now */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode === 'live') keepAwake();
});

// ---------------- camera ----------------
// Android stops the camera when the app goes to the background, and the WebView does not
// always bring the stream back. So: release the camera when hidden, open it fresh when
// visible again, and if the picture still freezes (same pixels for 3 s), reopen it.
let camStream = null, camOpening = false;

async function openCamera() {
  if (camOpening) return;
  camOpening = true;
  try {
    closeCamera();
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = camStream;
    await video.play().catch(() => {});
    if (state.status.gps === 'אין גישה למצלמה') state.status.gps = '';
  } catch (e) {
    state.status.gps = 'אין גישה למצלמה';
    console.warn(e);
  } finally {
    camOpening = false;
  }
}

function closeCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  video.srcObject = null;
}

const probe = document.createElement('canvas');
probe.width = probe.height = 8;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
let lastSig = '', sameFor = 0;

function frameSignature() {
  if (!video.videoWidth) return '';
  probeCtx.drawImage(video, 0, 0, 8, 8);
  const px = probeCtx.getImageData(0, 0, 8, 8).data;
  // night: the picture is too dark to see the landscape -> draw the computed one
  let lum = 0;
  for (let i = 0; i < px.length; i += 4) lum += 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
  lum /= 64;
  if (lum < 35) state.night = true; else if (lum > 55) state.night = false;
  return Array.from(px).join(',');
}

function startCameraWatchdog() {
  document.addEventListener('visibilitychange', () => {
    if (state.mode !== 'live') return;
    if (document.visibilityState === 'hidden') closeCamera();
    else { sameFor = 0; openCamera(); }
  });
  canvas.addEventListener('pointerdown', () => { if (video.paused) video.play().catch(() => {}); });
  setInterval(() => {
    if (state.mode !== 'live' || document.visibilityState !== 'visible' || camOpening) return;
    const track = camStream?.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') { openCamera(); return; }
    if (video.paused) video.play().catch(() => {});
    // A live camera never gives two identical frames (sensor noise), so identical = frozen.
    const sig = frameSignature();
    sameFor = sig && sig === lastSig ? sameFor + 1 : 0;
    lastSig = sig;
    if (sameFor >= 3) { sameFor = 0; openCamera(); }
  }, 1000);
}

async function startLive() {
  state.mode = 'live';
  showMain();
  keepAwake();
  // Orientation must be requested inside the click handler on iOS: do it first.
  const orientP = orient.start();
  await openCamera();
  startCameraWatchdog();
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* ignore */ }
  await orientP;
  if (!navigator.geolocation) { state.status.gps = 'אין GPS'; return; }
  navigator.geolocation.watchPosition(
    (pos) => onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.altitude, pos.coords.heading, pos.coords.speed),
    (err) => { state.status.gps = err.code === 1 ? 'אין הרשאת מיקום' : 'ממתין ל-GPS…'; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

function startDemo(params) {
  state.mode = 'demo';
  showMain();
  video.style.background = 'linear-gradient(#2b5a8a, #a9c8e4)';
  // Default: lookout above the Hula valley, facing north-east towards the Hermon.
  const lat = parseFloat(params.get('lat') ?? '33.0918');
  const lon = parseFloat(params.get('lon') ?? '35.5612');
  state.demHeading = parseFloat(params.get('h') ?? '40') * D2R;
  if (params.get('fov')) settings.fov = +params.get('fov');
  const bar = $('demo-bar'), slider = $('demo-heading');
  bar.hidden = false;
  slider.value = (state.demHeading * R2D).toFixed(1);
  slider.oninput = () => { state.demHeading = +slider.value * D2R; orient.setManual(state.demHeading, 0); };
  orient.setManual(state.demHeading, 0);
  onPosition(lat, lon, null, null);
}

bindSettings();
// Intro: shown on the first run only; afterwards start straight away. Help is in settings.
const INTRO_KEY = 'ma-roim:intro-seen';
const introSeen = (() => { try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; } })();
$('btn-start').onclick = () => {
  if (state.mode) { $('start').hidden = true; return; } // opened as help
  startLive();
};
$('btn-help').onclick = () => {
  $('settings').hidden = true;
  $('btn-start').textContent = 'סגור';
  $('start').hidden = false;
};
const params = new URLSearchParams(location.search);
if (params.has('demo')) startDemo(params);
else if (introSeen) startLive();

// Inside the Android app (Capacitor) the files are already local: no service worker needed.
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
