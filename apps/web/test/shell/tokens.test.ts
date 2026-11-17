import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_TOKENS } from '@dash/contract';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', '..');
const repoRoot = resolve(webRoot, '..', '..');
const roots = [join(webRoot, 'src'), join(repoRoot, 'packages', 'ui', 'src')];
const EXTENSIONS = ['.svelte', '.css', '.ts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (EXTENSIONS.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Every `--db-*` name that appears inside a `var(...)` call (fallbacks included). */
function tokensUsed(source: string): string[] {
  const names: string[] = [];
  for (const call of source.matchAll(/var\(([^)]*)\)/g)) {
    for (const name of (call[1] ?? '').matchAll(/--db-[a-z0-9-]+/g)) {
      names.push(name[0]);
    }
  }
  return names;
}

describe('design tokens', () => {
  it('only declared design tokens are used', () => {
    const declared = new Set<string>(REQUIRED_TOKENS);
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const token of tokensUsed(source)) {
          if (!declared.has(token)) {
            offenders.push(`${relative(repoRoot, file)}: ${token}`);
          }
        }
      }
    }
    expect(
      offenders,
      `undeclared design tokens used (not in REQUIRED_TOKENS):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
