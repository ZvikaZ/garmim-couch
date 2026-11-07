// Phone orientation -> device->world (ENU) quaternion.
//
// Two kinds of readings are combined:
//  * absolute orientation (gyro + accelerometer + MAGNETOMETER): knows where north is, but
//    the compass is easily disturbed (cars, metal, electronics) and its error changes as
//    you turn;
//  * relative orientation (gyro + accelerometer only, "game rotation vector"): very smooth
//    and accurate for turning, but its "north" is arbitrary and drifts slowly.
// We track with the relative one and only take the north direction ("yaw offset") from the
// compass, through a slow filter. After the user (or the image matcher) calibrates, the
// compass influence is reduced even further, so the calibration survives turning around.

import { qFromDeviceOrientation, qmul, qaxis, qconj, qslerp, qFromHeadingPitch, D2R } from './geo.js';

function screenAngle() {
  return (screen.orientation?.angle ?? window.orientation ?? 0) * D2R;
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const TAU_FREE = 3;      // s: how fast north follows the compass normally
const TAU_LOCKED = 900;  // s: after a calibration, trust the gyro for ~15 minutes
const LOCK_FOR = 10 * 60 * 1000;

export class Orientation {
  constructor(onChange) {
    this.q = null;          // smoothed result
    this.qAbs = null;       // latest absolute (compass) reading
    this.qRel = null;       // latest relative (gyro) reading
    this.delta = null;      // yaw rotation taking the relative frame to true-ish north
    this.lastAbsAt = 0;
    this.lockedAt = -Infinity;
    this.source = 'none';
    this.onChange = onChange;
    this.smoothing = 0.25;
    this.lastUpdate = 0;
  }

  get usingGyro() { return !!this.qRel && this.delta != null; }

  /** Call after a calibration: from now on, follow the gyro and mostly ignore the compass. */
  lock() { this.lockedAt = performance.now(); }

  /** Forget the calibration lock and take north from the compass again, right away. */
  unlock() { this.lockedAt = -Infinity; this.delta = null; }

  _emit(target, alpha) {
    this.q = this.q ? qslerp(this.q, target, alpha) : target;
    this.lastUpdate = performance.now();
    this.onChange?.(this.q);
  }

  _onAbs(q) {
    const now = performance.now();
    const dt = this.lastAbsAt ? Math.min(1, (now - this.lastAbsAt) / 1000) : 0;
    this.lastAbsAt = now;
    this.qAbs = q;
    if (!this.qRel) { this._emit(q, this.smoothing); return; } // compass only
    // the yaw (about world up) between the two frames
    const m = qmul(q, qconj(this.qRel));
    const meas = 2 * Math.atan2(m[3], m[0]);
    if (this.delta == null) { this.delta = meas; return; }
    const tau = now - this.lockedAt < LOCK_FOR ? TAU_LOCKED : TAU_FREE;
    this.delta = wrapPi(this.delta + Math.min(1, dt / tau) * wrapPi(meas - this.delta));
  }

  _onRel(q) {
    this.qRel = q;
    if (this.delta == null) return; // wait for the first compass reading
    const target = qmul(qaxis(0, 0, 1, this.delta), q);
    // The gyro path is clean: little smoothing needed (more while driving: bumps).
    this._emit(target, this.smoothing < 0.2 ? this.smoothing : 0.55);
  }

  async _startSensor(Ctor, cb) {
    const s = new Ctor({ frequency: 60, referenceFrame: 'screen' });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 1500);
      s.addEventListener('reading', () => {
        clearTimeout(t);
        const [x, y, z, w] = s.quaternion;
        cb([w, x, y, z]);
        resolve();
      });
      s.addEventListener('error', (e) => { clearTimeout(t); reject(e.error); });
      s.start();
    });
    return s;
  }

  /** Must be called from a user gesture on iOS (permission). */
  async start() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* denied */ }
    }
    let abs = false, rel = false;
    if ('AbsoluteOrientationSensor' in window) {
      try { this.absSensor = await this._startSensor(window.AbsoluteOrientationSensor, (q) => this._onAbs(q)); abs = true; } catch { /* fall back */ }
    }
    if ('RelativeOrientationSensor' in window) {
      try { this.relSensor = await this._startSensor(window.RelativeOrientationSensor, (q) => this._onRel(q)); rel = true; } catch { /* fall back */ }
    }
    const fromEvent = (e) => {
      let q = qFromDeviceOrientation(e.alpha, e.beta, e.gamma);
      return qmul(q, qaxis(0, 0, 1, -screenAngle()));
    };
    if (!abs && 'ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', (e) => { if (e.alpha != null) this._onAbs(fromEvent(e)); });
      abs = true;
    }
    if (!rel || !abs) {
      // On Android Chrome 'deviceorientation' is relative (gyro). On iOS it's relative too,
      // and webkitCompassHeading gives the absolute part.
      window.addEventListener('deviceorientation', (e) => {
        if (e.alpha == null) return;
        if (typeof e.webkitCompassHeading === 'number') {
          this._onAbs(qmul(qFromDeviceOrientation(360 - e.webkitCompassHeading, e.beta, e.gamma), qaxis(0, 0, 1, -screenAngle())));
          if (!rel) this._onRel(fromEvent(e));
        } else if (e.absolute) {
          if (!abs) this._onAbs(fromEvent(e));
        } else if (!rel) {
          this._onRel(fromEvent(e));
        }
      });
    }
    this.source = `${rel ? 'gyro' : ''}${rel && abs ? '+' : ''}${abs ? 'compass' : ''}${this.absSensor || this.relSensor ? ' (sensor)' : ' (event)'}`;
    return this.source;
  }

  /** Manual (desktop/demo/test) control. */
  setManual(heading, pitch, roll = 0) {
    this.source = 'manual';
    this.qRel = null;
    this.q = this.qAbs = qFromHeadingPitch(heading, pitch, roll);
    this.lastUpdate = performance.now();
    this.onChange?.(this.q);
  }
}
