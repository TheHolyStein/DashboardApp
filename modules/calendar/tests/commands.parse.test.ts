import { describe, expect, it } from 'vitest';
import { displayTitle, parseCommands } from '../server/commands/parse.js';

describe('command parser', () => {
  it('finds @dani, #shopping milk, eggs and !remind 30m in one line', () => {
    expect(parseCommands('Party @dani #shopping milk, eggs !remind 30m')).toEqual([
      { kind: 'mention', handle: 'dani' },
      { kind: 'tag', name: 'shopping', args: 'milk, eggs' },
      { kind: 'bang', name: 'remind', args: '30m' },
    ]);
  });

  it('ignores @ inside an e-mail and # inside a URL', () => {
    expect(parseCommands('Mail dani@example.com, see https://example.com/page#shopping and www.x.org/!pin')).toEqual([]);
  });

  it('unknown handle ignored', () => {
    expect(parseCommands('Lunch @nobody @Dani.', ['dani', 'eli'])).toEqual([{ kind: 'mention', handle: 'dani' }]);
  });

  it('args stop at next token and at the end of the line', () => {
    expect(parseCommands('#shopping bread, jam @eli !pin\n!remind 1h\nnotes')).toEqual([
      { kind: 'tag', name: 'shopping', args: 'bread, jam' },
      { kind: 'mention', handle: 'eli' },
      { kind: 'bang', name: 'pin', args: '' },
      { kind: 'bang', name: 'remind', args: '1h' },
    ]);
  });

  it('a sigil glued to a word or followed by digits is plain text', () => {
    expect(parseCommands('Hello! issue#12 #3 x!pin')).toEqual([]);
  });

  it('displayTitle removes !commands with their arguments only', () => {
    expect(displayTitle('Dentist !remind 30m @eli #outdoor')).toBe('Dentist @eli #outdoor');
    expect(displayTitle('!pin Exam')).toBe('');
    expect(displayTitle('Exam !pin')).toBe('Exam');
  });
});
