import type { CommandPlugin } from './types.js';

/** `#chore`: a chores-list todo due at the start, for the first mentioned user or the creator. */
export const chore: CommandPlugin = {
  syntax: '#chore',
  match: (t) => t.kind === 'tag' && t.name === 'chore',
  derive({ event, mentioned, creatorId, key }) {
    const assigneeId = mentioned[0] ?? creatorId;
    const sourceKey = key('chore', '');
    return [
      {
        sourceKey,
        kind: 'event',
        name: 'todo.create.request',
        payload: { sourceKey, list: 'chores', title: event.displayTitle, due: event.startUtc, assigneeId, icon: null, url: null, ownerId: null },
        removeWith: { name: 'todo.remove.request', payload: { sourceKey } },
      },
    ];
  },
};
