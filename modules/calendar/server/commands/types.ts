import type { EventName, UserId } from '@dash/contract';
import type { Occurrence } from '../recurrence.js';
import type { Token } from './parse.js';

export interface CommandUser {
  id: UserId;
  handle: string;
}

/** What a command needs to know about the occurrence it is in. */
export interface CommandContext {
  event: Occurrence & { displayTitle: string };
  token: Token;
  /** Every token of the event (a command may depend on others, e.g. #chore on the first mention). */
  tokens: Token[];
  users: CommandUser[];
  creatorId: UserId;
  /** Users mentioned in the event (known handles only), in order. */
  mentioned: UserId[];
  /** `calendar:<uid>:<occurrence or 'single'>:<kind>:<hash of arg>` */
  key: (kind: string, arg: string) => string;
}

export type Derived =
  | { sourceKey: string; kind: 'event'; name: EventName; payload: unknown; removeWith?: { name: EventName; payload: unknown } }
  | { sourceKey: string; kind: 'reminder'; fireAt: string; userIds: UserId[]; action?: { name: EventName; payload: unknown } }
  | { sourceKey: string; kind: 'flag'; flag: 'private' | 'outdoor' | 'birthday' };

export interface CommandPlugin {
  /** Shown in the editor's help. */
  syntax: string;
  match(t: Token): boolean;
  derive(ctx: CommandContext): Derived[];
}

/** `30m`, `2h`, `1d` → ms; null when the text is not one of `units`. */
export function durationMs(args: string, units: string): number | null {
  const m = /^(\d{1,4})\s*([mhd])\b/i.exec(args.trim());
  if (!m) return null;
  const unit = m[2]!.toLowerCase();
  if (!units.includes(unit)) return null;
  const n = Number(m[1]);
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

export const isoMinus = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();
