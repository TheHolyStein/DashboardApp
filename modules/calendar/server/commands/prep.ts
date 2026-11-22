import { durationMs, isoMinus, type CommandPlugin } from './types.js';

/** `!prep 2d` / `3h`: a deadline todo "Prepare: …" that long before the start, for the creator. */
export const prep: CommandPlugin = {
  syntax: '!prep <n>h|d',
  match: (t) => t.kind === 'bang' && t.name === 'prep',
  derive({ token, event, creatorId, key }) {
    if (token.kind !== 'bang') return [];
    const ms = durationMs(token.args, 'hd');
    if (ms === null) return [];
    const sourceKey = key('prep', String(ms));
    return [
      {
        sourceKey,
        kind: 'event',
        name: 'todo.create.request',
        payload: {
          sourceKey,
          list: 'deadline',
          title: `Prepare: ${event.displayTitle}`.slice(0, 200),
          due: isoMinus(event.startUtc, ms),
          assigneeId: creatorId,
          icon: null,
          url: null,
          ownerId: creatorId,
        },
        removeWith: { name: 'todo.remove.request', payload: { sourceKey } },
      },
    ];
  },
};
