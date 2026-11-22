/**
 * Command tokens inside event titles and descriptions.
 *
 * - `@handle`: `@` + `[a-z0-9._-]+` (case-insensitive; trailing dots are punctuation, not part of the handle).
 * - `#name args` / `!name args`: sigil + `[a-z]+`; the arguments run to the next token or the end of the line.
 *
 * A sigil only starts a token at the start of the text or after whitespace or an opening bracket, so `a@b.example`
 * and `x#y` are plain text; sigils inside URLs and e-mail addresses are ignored.
 */

export type Token =
  | { kind: 'mention'; handle: string }
  | { kind: 'tag'; name: string; args: string }
  | { kind: 'bang'; name: string; args: string };

export interface Located {
  token: Token;
  /** Offsets in the text of the whole token including its arguments: `[start, end)`. */
  start: number;
  end: number;
}

const URL_OR_EMAIL = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;
const SIGIL = /(^|[\s([{])([@#!])([a-z0-9._-]+)/gim;

function protectedSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_OR_EMAIL)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Every token with its position, in text order. */
export function locateCommands(text: string): Located[] {
  const spans = protectedSpans(text);
  const inSpan = (i: number): boolean => spans.some(([a, b]) => i >= a && i < b);

  // Pass 1: where each token's head (sigil + name) is.
  const heads: Array<{ sigil: string; name: string; at: number; headEnd: number }> = [];
  for (const m of text.matchAll(SIGIL)) {
    const sigil = m[2]!;
    const at = m.index + m[1]!.length;
    if (inSpan(at)) continue;
    let name = m[3]!;
    if (sigil === '@') {
      name = name.replace(/[.]+$/, '');
      if (!name) continue;
    } else {
      // `#name` and `!name` are letters only (`#3`, `!x2` are ordinary text); a trailing `.` is punctuation.
      const letters = /^[a-z]+/i.exec(name)?.[0] ?? '';
      const rest = name.slice(letters.length);
      if (!letters || (rest !== '' && !/^\.+$/.test(rest))) continue;
      name = letters;
    }
    heads.push({ sigil, name: name.toLowerCase(), at, headEnd: at + 1 + name.length });
  }

  // Pass 2: arguments run to the next head or to the end of the line.
  const out: Located[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    if (h.sigil === '@') {
      out.push({ token: { kind: 'mention', handle: h.name }, start: h.at, end: h.headEnd });
      continue;
    }
    const nextHead = heads[i + 1]?.at ?? text.length;
    const eol = text.indexOf('\n', h.headEnd);
    const stop = Math.min(nextHead, eol === -1 ? text.length : eol);
    const args = text.slice(h.headEnd, stop).trim();
    const token: Token = h.sigil === '#' ? { kind: 'tag', name: h.name, args } : { kind: 'bang', name: h.name, args };
    out.push({ token, start: h.at, end: stop });
  }
  return out;
}

/**
 * The tokens of a text. With `handles`, mentions of handles not in it are dropped (an unknown `@name` is plain text).
 */
export function parseCommands(text: string, handles?: Iterable<string>): Token[] {
  const known = handles ? new Set([...handles].map((h) => h.toLowerCase())) : null;
  return locateCommands(text)
    .map((l) => l.token)
    .filter((t) => t.kind !== 'mention' || known === null || known.has(t.handle));
}

/** The title without its `!command` tokens (and their arguments), whitespace tidied. */
export function displayTitle(title: string): string {
  const bangs = locateCommands(title).filter((l) => l.token.kind === 'bang');
  let out = '';
  let pos = 0;
  for (const b of bangs) {
    out += title.slice(pos, b.start);
    pos = b.end;
  }
  out += title.slice(pos);
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** Tag names, mentioned handles and the private flag of an event's title and description. */
export function eventMarkers(title: string, description: string, handles?: Iterable<string>): {
  tags: string[];
  mentions: string[];
  isPrivate: boolean;
} {
  const tokens = [...parseCommands(title, handles), ...parseCommands(description, handles)];
  const tags = [...new Set(tokens.flatMap((t) => (t.kind === 'tag' ? [t.name] : [])))];
  const mentions = [...new Set(tokens.flatMap((t) => (t.kind === 'mention' ? [t.handle] : [])))];
  return { tags, mentions, isPrivate: tags.includes('private') };
}
