import type { CommandPlugin } from './types.js';

/** `@handle`: a deadline todo for that user, due at the start. */
export const mention: CommandPlugin = {
  syntax: '@handle',
  match: (t) => t.kind === 'mention',
  derive({ token, users, event, key }) {
    if (token.kind !== 'mention') return [];
    const user = users.find((u) => u.handle.toLowerCase() === token.handle);
    if (!user) return [];
    const sourceKey = key('mention', user.id);
    return [
      {
        sourceKey,
        kind: 'event',
        name: 'todo.create.request',
        payload: { sourceKey, list: 'deadline', title: event.displayTitle, due: event.startUtc, assigneeId: user.id, icon: null, url: null, ownerId: user.id },
        removeWith: { name: 'todo.remove.request', payload: { sourceKey } },
      },
    ];
  },
};
