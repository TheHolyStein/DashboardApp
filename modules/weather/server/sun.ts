// Solar position from the NOAA solar calculator equations (Meeus, "Astronomical Algorithms"). No network, no
// time source of its own: every function takes the instant it should work for.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Sun centre altitude at sunrise and sunset: 34' refraction plus 16' solar radius. */
export const HORIZON_DEG = -0.833;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

interface Solar {
  /** Declination, radians. */
  decl: number;
  /** Equation of time, minutes. */
  eq: number;
}

function solarAt(ms: number): Solar {
  const jd = ms / DAY_MS + 2_440_587.5;
  const T = (jd - 2_451_545) / 36_525;
  const L0 = mod(280.46646 + T * (36_000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35_999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const L0r = L0 * RAD;
  const eq =
    (4 / RAD) *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  return { decl, eq };
}

/** Altitude of the sun's centre above the horizon in degrees (no refraction correction), for a place and an instant. */
export function sunAltitudeDeg(lat: number, lon: number, at: Date): number {
  const ms = at.getTime();
  const { decl, eq } = solarAt(ms);
  const trueSolarMin = mod(mod(ms / 60_000, 1440) + eq + 4 * lon, 1440);
  const ha = (trueSolarMin / 4 - 180) * RAD;
  const cosZenith = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD;
}

/** Whether the sun's upper limb is above the horizon (refraction included). */
export function isDayAt(lat: number, lon: number, at: Date): boolean {
  return sunAltitudeDeg(lat, lon, at) > HORIZON_DEG;
}

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
  /** `day` or `night` when the sun does not cross the horizon on this solar day; then sunrise and sunset are solar noon. */
  polar: 'day' | 'night' | null;
}

/** Hour angle (degrees) at which the sun reaches the horizon; null when it never does on a day with this declination. */
function horizonHourAngle(lat: number, decl: number): number | 'day' | 'night' {
  const cosHa = (Math.cos((90 - HORIZON_DEG) * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosHa > 1) return 'night';
  if (cosHa < -1) return 'day';
  return Math.acos(cosHa) / RAD;
}

/**
 * Sunrise and sunset of the solar day that `at` falls in (the day is cut at local mean midnight, so far-east and
 * far-west places get the sunrise and sunset around their own noon, not around UTC noon).
 */
export function sunTimes(lat: number, lon: number, at: Date): SunTimes {
  // UTC midnight of the solar date (the date on a clock set to local mean time); minute offsets below count from it.
  const dayStart = Math.floor((at.getTime() + (lon / 15) * 3_600_000) / DAY_MS) * DAY_MS;
  const at720 = (eq: number): number => dayStart + (720 - 4 * lon - eq) * 60_000;

  let noon = at720(0);
  for (let i = 0; i < 3; i++) noon = at720(solarAt(noon).eq);
  const first = horizonHourAngle(lat, solarAt(noon).decl);
  if (typeof first === 'string') return { sunrise: new Date(noon), sunset: new Date(noon), polar: first };

  const event = (sign: -1 | 1): number => {
    let t = noon;
    for (let i = 0; i < 4; i++) {
      const s = solarAt(t);
      const ha = horizonHourAngle(lat, s.decl);
      if (typeof ha === 'string') return noon;
      t = dayStart + (720 - 4 * lon - s.eq + sign * 4 * ha) * 60_000;
    }
    return t;
  };
  return { sunrise: new Date(event(-1)), sunset: new Date(event(1)), polar: null };
}
