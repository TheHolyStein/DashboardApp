import type { CommandPlugin, Derived } from './types.js';

/** `#shopping a, b`: one shopping-list todo per item. */
export const shopping: CommandPlugin = {
  syntax: '#shopping item, item',
  match: (t) => t.kind === 'tag' && t.name === 'shopping',
  derive({ token, key }) {
    if (token.kind !== 'tag') return [];
    const items = [...new Set(token.args.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50);
    return items.map((title): Derived => {
      const sourceKey = key('shopping', title.toLowerCase());
      return {
        sourceKey,
        kind: 'event',
        name: 'todo.create.request',
        payload: { sourceKey, list: 'shopping', title: title.slice(0, 200), due: null, assigneeId: null, icon: null, url: null, ownerId: null },
        removeWith: { name: 'todo.remove.request', payload: { sourceKey } },
      };
    });
  },
};
