import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = ['vitest', 'better-sqlite3', 'svelte', '@testing-library/svelte', 'jsdom'];
const FROM_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function collect(entry: string): Set<string> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(FROM_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else bare.add(spec);
    }
  };
  visit(entry);
  return bare;
}

describe('module-kit entry', () => {
  it('main entry loads no test helpers', () => {
    const bare = collect(resolve(import.meta.dirname, '../src/index.ts'));
    for (const name of FORBIDDEN) expect(bare, name).not.toContain(name);
    expect([...bare].filter((s) => s.startsWith('node:'))).toEqual([]);
    expect([...bare].filter((s) => s.startsWith('svelte/') || s.startsWith('vitest/'))).toEqual([]);
  });
});
