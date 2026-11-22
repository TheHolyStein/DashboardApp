import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['.json', '.xml', '.ics', '.txt'] as const;

/** Reads `<moduleDir>/fixtures/<name>.json` (parsed) or `.xml` / `.ics` / `.txt` (string). */
export function loadFixture<T = unknown>(moduleDir: string, name: string): T {
  for (const ext of EXTENSIONS) {
    const file = path.join(moduleDir, 'fixtures', name + ext);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    return (ext === '.json' ? JSON.parse(text) : text) as T;
  }
  throw new Error(
    `fixture "${name}" not found in ${path.join(moduleDir, 'fixtures')} (tried ${EXTENSIONS.join(', ')})`,
  );
}
