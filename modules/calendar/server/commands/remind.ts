import { durationMs, isoMinus, type CommandPlugin } from './types.js';

/** `!remind 30m` / `2h` / `1d`: a notification that long before the start, for the creator and mentioned users. */
export const remind: CommandPlugin = {
  syntax: '!remind <n>m|h|d',
  match: (t) => t.kind === 'bang' && t.name === 'remind',
  derive({ token, event, mentioned, creatorId, key }) {
    if (token.kind !== 'bang') return [];
    const ms = durationMs(token.args, 'mhd');
    if (ms === null) return [];
    return [
      {
        sourceKey: key('remind', String(ms)),
        kind: 'reminder',
        fireAt: isoMinus(event.startUtc, ms),
        userIds: [...new Set([creatorId, ...mentioned])],
      },
    ];
  },
};
