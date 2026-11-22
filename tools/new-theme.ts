// Scaffolds themes/<id> from tools/templates/theme. Run: pnpm new:theme <id>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, type GenResult } from './gen-registry.ts';
import { scaffold } from './new-module.ts';

export function newTheme(rootDir: string, id: string): GenResult {
  return scaffold(rootDir, 'theme', id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  const res = id ? newTheme(REPO_ROOT, id) : { exitCode: 1 as const, messages: ['usage: pnpm new:theme <id>'] };
  for (const m of res.messages) (res.exitCode === 0 ? console.log : console.error)(m);
  process.exitCode = res.exitCode;
}
