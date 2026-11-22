import type { CommandPlugin } from './types.js';

/** `!pin`: pins the event to the briefing of the creator and mentioned users on its date. */
export const pin: CommandPlugin = {
  syntax: '!pin',
  match: (t) => t.kind === 'bang' && t.name === 'pin',
  derive({ event, mentioned, creatorId, key }) {
    const sourceKey = key('pin', '');
    return [
      {
        sourceKey,
        kind: 'event',
        name: 'pin.request',
        payload: { sourceKey, title: event.displayTitle, date: event.start.slice(0, 10), userIds: [...new Set([creatorId, ...mentioned])] },
      },
    ];
  },
};
