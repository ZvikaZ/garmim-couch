// Geodesy + quaternion helpers.
// World frame is local ENU: x = East, y = North, z = Up.
// Device frame (W3C): x = right of screen, y = top of screen, z = out of the screen (towards the user).
// The back camera looks along device -z.

export const R_EARTH = 6371008.8;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
// Standard atmospheric refraction coefficient: light bends around the earth a little,
// so things far away look a bit higher than pure geometry says.
export const REFRACTION_K = 0.13;

/** Great-circle distance (m) and initial bearing (rad, clockwise from north). */
export function distBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  let brg = Math.atan2(y, x);
  if (brg < 0) brg += 2 * Math.PI;
  return { d, brg };
}

/** Point at distance d (m) along bearing brg (rad) from (lat, lon). */
export function destination(lat, lon, brg, d) {
  const p1 = lat * D2R, l1 = lon * D2R, dr = d / R_EARTH;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
  return [p2 * R2D, l2 * R2D];
}

/** How far below the observer's horizontal plane a point at distance d appears (m). */
export function curvatureDrop(d) {
  return (d * d) / (2 * R_EARTH) * (1 - REFRACTION_K);
}

/** Elevation angle (rad) of a target dh metres above the observer at distance d. */
export function elevationAngle(dh, d) {
  return Math.atan2(dh - curvatureDrop(d), d);
}

/** Unit ENU vector for azimuth (rad, cw from north) and elevation angle (rad). */
export function dirVector(az, el) {
  const c = Math.cos(el);
  return [Math.sin(az) * c, Math.cos(az) * c, Math.sin(el)];
}

// ---------- quaternions [w, x, y, z] ----------

export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function qconj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function qaxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), ax * s, ay * s, az * s];
}

/** Rotate vector v by quaternion q. */
export function qrot(q, v) {
  const p = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q));
  return [p[1], p[2], p[3]];
}

export function qslerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) {
    return qnorm([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])]);
  }
  const th = Math.acos(dot), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2], wa * a[3] + wb * b[3]];
}

/** Device->world quaternion from W3C DeviceOrientation angles (degrees): R = Rz(alpha) Rx(beta) Ry(gamma). */
export function qFromDeviceOrientation(alpha, beta, gamma) {
  return qmul(qmul(qaxis(0, 0, 1, alpha * D2R), qaxis(1, 0, 0, beta * D2R)), qaxis(0, 1, 0, gamma * D2R));
}

/** Device->world quaternion for a phone held upright (portrait), camera facing `heading` (rad, cw from north), tilted up by `pitch` (rad). */
export function qFromHeadingPitch(heading, pitch, roll = 0) {
  return qmul(qmul(qaxis(0, 0, 1, -heading), qaxis(1, 0, 0, Math.PI / 2 + pitch)), qaxis(0, 0, 1, roll));
}

/** Camera heading (rad, cw from north) and pitch (rad) for a device->world quaternion. */
export function cameraHeadingPitch(q) {
  const f = qrot(q, [0, 0, -1]);
  let h = Math.atan2(f[0], f[1]);
  if (h < 0) h += 2 * Math.PI;
  return { heading: h, pitch: Math.asin(Math.max(-1, Math.min(1, f[2]))) };
}

const COMPASS_HE = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
export function compassName(headingRad) {
  const deg = ((headingRad * R2D) % 360 + 360) % 360;
  return COMPASS_HE[Math.round(deg / 45) % 8];
}
