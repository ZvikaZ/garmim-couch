// Phone orientation -> device->world (ENU) quaternion, smoothed.
// Prefers the Generic Sensor AbsoluteOrientationSensor (Chrome on Android),
// falls back to the 'deviceorientationabsolute' event, then to iOS webkitCompassHeading.

import { qFromDeviceOrientation, qmul, qaxis, qslerp, qFromHeadingPitch, D2R } from './geo.js';

function screenAngle() {
  return (screen.orientation?.angle ?? window.orientation ?? 0) * D2R;
}

export class Orientation {
  constructor(onChange) {
    this.q = null;          // smoothed
    this.raw = null;
    this.source = 'none';
    this.onChange = onChange;
    this.smoothing = 0.25;
    this.lastUpdate = 0;
  }

  _push(q) {
    this.raw = q;
    this.q = this.q ? qslerp(this.q, q, this.smoothing) : q;
    this.lastUpdate = performance.now();
    this.onChange?.(this.q);
  }

  /** Must be called from a user gesture (iOS permission). */
  async start() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* denied */ }
    }
    if ('AbsoluteOrientationSensor' in window) {
      try {
        const s = new window.AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'screen' });
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), 1500);
          s.addEventListener('reading', () => {
            clearTimeout(t);
            const [x, y, z, w] = s.quaternion;
            this._push([w, x, y, z]);
            resolve();
          });
          s.addEventListener('error', (e) => { clearTimeout(t); reject(e.error); });
          s.start();
        });
        this.sensor = s;
        this.source = 'sensor';
        return this.source;
      } catch { /* fall through */ }
    }
    const handler = (e, absolute) => {
      if (e.alpha == null) return;
      let alpha = e.alpha;
      if (!absolute && typeof e.webkitCompassHeading === 'number') {
        // iOS: alpha is relative; compass heading gives true north (approx).
        alpha = 360 - e.webkitCompassHeading;
      } else if (!absolute && !e.absolute) {
        return;
      }
      let q = qFromDeviceOrientation(alpha, e.beta, e.gamma);
      q = qmul(q, qaxis(0, 0, 1, -screenAngle()));
      this._push(q);
    };
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', (e) => handler(e, true));
      this.source = 'event-absolute';
    } else {
      window.addEventListener('deviceorientation', (e) => handler(e, false));
      this.source = 'event';
    }
    return this.source;
  }

  /** Manual (desktop/demo) control. */
  setManual(heading, pitch) {
    this.source = 'manual';
    this.q = this.raw = qFromHeadingPitch(heading, pitch);
    this.lastUpdate = performance.now();
    this.onChange?.(this.q);
  }
}
