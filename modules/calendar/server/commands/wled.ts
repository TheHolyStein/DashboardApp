import type { CommandPlugin } from './types.js';

/** `!wled <preset>` or `!wled <target>:<preset>`: applies a WLED preset when the event starts. */
export const wled: CommandPlugin = {
  syntax: '!wled [target:]preset',
  match: (t) => t.kind === 'bang' && t.name === 'wled',
  derive({ token, event, key }) {
    if (token.kind !== 'bang') return [];
    const arg = token.args.split(/\s+/)[0] ?? '';
    const m = /^(?:([a-z0-9._-]{1,32}):)?([a-z0-9._-]{1,32})$/i.exec(arg);
    if (!m) return [];
    const target = m[1] ?? 'all';
    const preset = m[2]!;
    return [
      {
        sourceKey: key('wled', `${target}:${preset}`),
        kind: 'reminder',
        fireAt: event.startUtc,
        userIds: [],
        action: { name: 'wled.apply.request', payload: { target, preset } },
      },
    ];
  },
};
