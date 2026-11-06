import {
  distBearing, elevationAngle, dirVector, qmul, qaxis, qconj, qrot, cameraHeadingPitch,
  compassName, D2R, R2D,
} from './geo.js';
import { DEM, lineOfSight, computeSkyline } from './dem.js';
import { loadLandmarks, KIND_HE } from './data.js';
import { Orientation } from './orientation.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

// ---------------- persisted settings ----------------
const SETTINGS_KEY = 'ma-roim:settings:v1';
const defaults = { fov: 66, density: 1, showHidden: false, showSkyline: true, headingOffset: 0, pitchOffset: 0 };
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

// ---------------- geometry ----------------
function targetHeight(p) {
  const g = state.dem.elevation(p.lat, p.lon);
  if (p.kind === 'peak' || p.kind === 'volcano') return p.ele ?? (Number.isNaN(g) ? 0 : g);
  if (p.kind === 'water') return Number.isNaN(g) ? (p.ele ?? 0) : g;
  if (p.kind === 'valley') return Number.isNaN(g) ? 0 : g;
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
    if (haveDem && d > 300) {
      const los = lineOfSight(state.dem, obs, p, p.h, d, brg);
      // Lakes and valleys are big: their centre can be hidden while most of it is visible.
      const lenient = (p.kind === 'water' || p.kind === 'valley') ? 0.02 : 0;
      p.visible = los.clearance > -0.0025 - lenient;
    } else {
      p.visible = true;
    }
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
      state.pois = r.pois.map((p) => ({ ...p }));
      state.status.data = r.stale ? 'נתונים ישנים (אין רשת)' : '';
    })
    .catch((e) => { state.status.data = 'שגיאה בטעינת מקומות'; state.lastError = String(e.message || e); console.error(e); });
  // Show labels as soon as the landmarks arrive, then refine once heights are in.
  await dataP; recomputeGeometry();
  await demP; recomputeGeometry();
}

function onPosition(lat, lon, acc, gpsAlt) {
  const first = !state.obs;
  state.obs = { ...(state.obs || {}), lat, lon, acc, gpsAlt };
  state.status.gps = acc != null ? `GPS ±${Math.round(acc)} מ׳` : '';
  if (first) { loadAll(); return; }
  const movedData = distBearing(lat, lon, state.lastDataAt.lat, state.lastDataAt.lon).d;
  if (movedData > 8000) { loadAll(); return; }
  const movedGeom = state.lastGeomAt ? distBearing(lat, lon, state.lastGeomAt.lat, state.lastGeomAt.lon).d : Infinity;
  if (movedGeom > 250) recomputeGeometry();
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
  return qmul(qaxis(0, 0, 1, settings.headingOffset), orient.q);
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
    ctx.strokeStyle = 'rgba(255, 211, 77, 0.75)';
    ctx.lineWidth = 1.5;
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
    if (p.d == null || p.d < 150) continue;
    if (!p.visible && !settings.showHidden) continue;
    if (p.d / 1000 > p.score * reach) continue;
    const pt = project(dirVector(p.brg, p.angle));
    if (!pt || pt[0] < -40 || pt[0] > W + 40 || pt[1] < -200 || pt[1] > H + 40) continue;
    cands.push({ p, x: pt[0], y: pt[1], rank: p.score / (1 + p.d / 30000) + (p.visible ? 0 : -1000) });
  }
  cands.sort((a, b) => b.rank - a.rank);
  const maxLabels = Math.round(22 * settings.density * Math.sqrt(state.zoom));

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
      const b = { x: c.x - w / 2, y: ROW0 + r * ROW_H, w, h: LABEL_H };
      if (b.y + b.h > c.y - 10) break;
      if (!overlaps(b)) { box = b; break; }
    }
    if (!box) {
      // Point is near the top of the screen (looking up at something close): label below it.
      const b = { x: c.x - w / 2, y: c.y + 10, w, h: LABEL_H };
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
    ctx.fillText(c.p.name, c.x, box.y + 4 + st.size * 0.85);
    ctx.fillStyle = '#d6dbe4';
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillText(sub, c.x, box.y + box.h - 4);
    ctx.globalAlpha = 1;
  }
  updateHud(q);
}

/** Demo mode has no camera: paint the computed ridge line as a silhouette so it looks like a view. */
function drawDemoTerrain(project, W, H) {
  const n = state.skyline.length;
  ctx.fillStyle = '#3b4a33';
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
  const parts = [s.gps, s.data || (state.pois.length ? `${state.pois.length} מקומות` : ''), s.dem].filter(Boolean);
  $('status').textContent = parts.join(' · ');
  $('zoom-label').textContent = state.zoom > 1.05 ? `×${state.zoom.toFixed(1)}` : '';
}

// ---------------- gestures ----------------
const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (e) => {
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
    else saveSettings();
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
  if (p.ele != null) lines.push(`גובה ${Math.round(p.ele)} מ׳`);
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
}
$('btn-close-info').onclick = () => { $('info').hidden = true; };

// ---------------- settings UI ----------------
function bindSettings() {
  const fov = $('fov'), dens = $('density');
  fov.value = settings.fov; $('fov-out').textContent = settings.fov;
  dens.value = settings.density; $('density-out').textContent = settings.density;
  $('show-hidden').checked = settings.showHidden;
  $('show-skyline').checked = settings.showSkyline;
  fov.oninput = () => { settings.fov = +fov.value; $('fov-out').textContent = fov.value; saveSettings(); };
  dens.oninput = () => { settings.density = +dens.value; $('density-out').textContent = dens.value; saveSettings(); };
  $('show-hidden').onchange = (e) => { settings.showHidden = e.target.checked; saveSettings(); };
  $('show-skyline').onchange = (e) => { settings.showSkyline = e.target.checked; saveSettings(); };
  $('btn-settings').onclick = () => {
    $('debug').textContent = `${state.lastError ? `שגיאה: ${state.lastError} · ` : ''}חיישן: ${orient.source} · תיקון מצפן: ${(settings.headingOffset * R2D).toFixed(1)}° · מיקום: ${state.obs ? `${state.obs.lat.toFixed(4)}, ${state.obs.lon.toFixed(4)}, ${Math.round(state.obs.h ?? 0)} מ׳` : '—'}`;
    $('settings').hidden = false;
  };
  $('btn-close-settings').onclick = () => { $('settings').hidden = true; };
  $('btn-refresh').onclick = () => { $('settings').hidden = true; if (state.obs) loadAll(true); };
  $('btn-calib').onclick = () => {
    settings.headingOffset = 0; settings.pitchOffset = 0; saveSettings();
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

async function startLive() {
  state.mode = 'live';
  showMain();
  // Orientation must be requested inside the click handler on iOS: do it first.
  const orientP = orient.start();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    state.status.gps = 'אין גישה למצלמה';
    console.warn(e);
  }
  await orientP;
  if (!navigator.geolocation) { state.status.gps = 'אין GPS'; return; }
  navigator.geolocation.watchPosition(
    (pos) => onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.altitude),
    (err) => { state.status.gps = err.code === 1 ? 'אין הרשאת מיקום' : 'ממתין ל-GPS…'; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  const hint = $('calib-hint');
  hint.hidden = false;
  setTimeout(() => { hint.hidden = true; }, 6000);
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
$('btn-start').onclick = startLive;
$('btn-demo').onclick = () => startDemo(new URLSearchParams(location.search));
const params = new URLSearchParams(location.search);
if (params.has('demo')) startDemo(params);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
