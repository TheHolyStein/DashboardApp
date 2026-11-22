import type { CommandPlugin } from './types.js';

const FLAGS = ['private', 'outdoor', 'birthday'] as const;
type Flag = (typeof FLAGS)[number];

/** `#private`, `#outdoor`, `#birthday [year]`: stored on the event as tags; nothing is published. */
export const flags: CommandPlugin = {
  syntax: '#private · #outdoor · #birthday [year]',
  match: (t) => t.kind === 'tag' && (FLAGS as readonly string[]).includes(t.name),
  derive({ token, key }) {
    if (token.kind !== 'tag') return [];
    return [{ sourceKey: key(token.name, ''), kind: 'flag', flag: token.name as Flag }];
  },
};

/** Age at an occurrence of a `#birthday 1990` event, or null. */
export function birthdayAge(args: string, occurrenceYear: number): number | null {
  const m = /^(\d{4})\b/.exec(args.trim());
  if (!m) return null;
  const age = occurrenceYear - Number(m[1]);
  return age >= 0 && age < 150 ? age : null;
}
