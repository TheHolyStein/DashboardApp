import type { Translate } from '@dash/contract';
import type { AqiBand, Condition, PollenLevel } from '../manifest.js';

export type Units = 'metric' | 'imperial';

// Data is stored metric. These are the only places that convert, and only for display.
export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const kphToMph = (kph: number): number => kph / 1.609344;
export const mmToIn = (mm: number): number => mm / 25.4;

/** The number a chart or label shows for a temperature, in the chosen units. */
export const temp = (c: number, units: Units): number => (units === 'imperial' ? cToF(c) : c);
export const precip = (mm: number, units: Units): number => (units === 'imperial' ? mmToIn(mm) : mm);

const nf = (locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat => new Intl.NumberFormat(locale, o);

export const formatTemp = (c: number, units: Units, locale: string): string =>
  nf(locale, { style: 'unit', unit: units === 'imperial' ? 'fahrenheit' : 'celsius', unitDisplay: 'short', maximumFractionDigits: 0 }).format(
    temp(c, units),
  );

export const formatWind = (kph: number, units: Units, locale: string): string =>
  nf(locale, { style: 'unit', unit: units === 'imperial' ? 'mile-per-hour' : 'kilometer-per-hour', maximumFractionDigits: 0 }).format(
    units === 'imperial' ? kphToMph(kph) : kph,
  );

export const formatPrecip = (mm: number, units: Units, locale: string): string =>
  nf(locale, { style: 'unit', unit: units === 'imperial' ? 'inch' : 'millimeter', maximumFractionDigits: units === 'imperial' ? 2 : 1 }).format(
    precip(mm, units),
  );

export const formatPercent = (v: number, locale: string): string =>
  nf(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v / 100);

export const formatNumber = (v: number, locale: string, digits = 1): string => nf(locale, { maximumFractionDigits: digits }).format(v);

/** A time of day in the user's own time zone. */
export const formatClock = (iso: string | number, locale: string, timeZone: string): string =>
  new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date(iso));

/** A calendar date of the forecast place ("2026-11-22") as a short weekday; the date has no zone, so it is read as UTC. */
export const formatWeekday = (date: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

const CONDITION: Record<Condition, string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  storm: 'Thunderstorm',
};
const LEVEL: Record<PollenLevel, string> = { 0: 'None', 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Very high' };
const BAND: Record<AqiBand, string> = { good: 'Good', fair: 'Fair', moderate: 'Moderate', poor: 'Poor', 'very-poor': 'Very poor' };
const POLLEN: Record<string, string> = {
  alder: 'Alder',
  birch: 'Birch',
  grass: 'Grass',
  mugwort: 'Mugwort',
  olive: 'Olive',
  ragweed: 'Ragweed',
};

export const conditionLabel = (t: Translate, c: Condition): string => t(`m.weather.condition.${c}`, CONDITION[c]);
export const levelLabel = (t: Translate, l: PollenLevel): string => t(`m.weather.level.${l}`, LEVEL[l]);
export const bandLabel = (t: Translate, b: AqiBand): string => t(`m.weather.band.${b}`, BAND[b]);
export const pollenLabel = (t: Translate, type: string): string => t(`m.weather.pollen.${type}`, POLLEN[type] ?? type);
