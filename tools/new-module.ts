// Scaffolds modules/<id> from tools/templates/module. Run: pnpm new:module <id>
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, ID_RE, REPO_ROOT, type GenResult } from './gen-registry.ts';

export function titleFromId(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const BINARY = /\.(webp|png|jpg|jpeg|gif|ico)$/i;

function fillPlaceholders(dir: string, id: string, name: string): void {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) fillPlaceholders(file, id, name);
    else if (!BINARY.test(entry)) {
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replaceAll('__ID__', id).replaceAll('__NAME__', name));
    }
  }
}

/** Shared by new-module and new-theme. Templates always come from this repo; `rootDir` is where the package lands. */
export function scaffold(rootDir: string, kind: 'module' | 'theme', id: string): GenResult {
  if (!ID_RE.test(id)) {
    return { exitCode: 1, messages: [`invalid ${kind} id "${id}": must match ${ID_RE}`] };
  }
  const target = path.join(rootDir, `${kind}s`, id);
  if (existsSync(target)) {
    return { exitCode: 1, messages: [`${kind}s/${id} already exists; refusing to overwrite`] };
  }
  cpSync(path.join(REPO_ROOT, 'tools/templates', kind), target, { recursive: true });
  fillPlaceholders(target, id, titleFromId(id));
  const gen = generate(rootDir);
  if (gen.exitCode !== 0) return gen;
  return {
    exitCode: 0,
    messages: [`created ${kind}s/${id}`, ...gen.messages, 'next: run `pnpm install` to link the new package, then edit it'],
  };
}

export function newModule(rootDir: string, id: string): GenResult {
  return scaffold(rootDir, 'module', id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  const res = id ? newModule(REPO_ROOT, id) : { exitCode: 1 as const, messages: ['usage: pnpm new:module <id>'] };
  for (const m of res.messages) (res.exitCode === 0 ? console.log : console.error)(m);
  process.exitCode = res.exitCode;
}
