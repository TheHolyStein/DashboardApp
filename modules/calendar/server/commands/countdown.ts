import type { CommandPlugin } from './types.js';

/** `!countdown`: asks the countdowns module for a countdown to the start. */
export const countdown: CommandPlugin = {
  syntax: '!countdown',
  match: (t) => t.kind === 'bang' && t.name === 'countdown',
  derive({ event, key }) {
    const sourceKey = key('countdown', '');
    return [{ sourceKey, kind: 'event', name: 'countdown.request', payload: { sourceKey, title: event.displayTitle, at: event.startUtc } }];
  },
};
