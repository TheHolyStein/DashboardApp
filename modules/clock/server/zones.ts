import { z } from 'zod';
import { DashError } from '@dash/contract';

export const MAX_ZONES = 12;

export const zonesKey = (userId: string): string => `zones:${userId}`;

/** Every zone name the runtime knows, plus `UTC` (not always in the list). */
const known = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/** Body of `PUT /zones`. More than 12 entries fails here (the router answers 422). */
export const zonesInput = z.object({ zones: z.array(z.string()).max(MAX_ZONES) });

/** Validates and deduplicates (first occurrence wins). Throws `DashError('invalid')` for an unknown zone. */
export function normaliseZones(zones: string[]): string[] {
  const bad = zones.find((z) => !known.has(z));
  if (bad !== undefined) throw new DashError('invalid', `unknown time zone: ${bad}`);
  return [...new Set(zones)];
}
