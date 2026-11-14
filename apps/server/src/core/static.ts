import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { notFoundBody } from './errors.js';

/**
 * Default location of the built web app: apps/web/dist, found from the source tree (src/core/) or from
 * the bundle (dist/). The first existing candidate wins; the source layout is the fallback.
 */
export const DEFAULT_WEB_DIST: string = (() => {
  const candidates = ['../../../web/dist', '../../web/dist'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find((c) => existsSync(c)) ?? (candidates[0] as string);
})();

const NO_SPA = ['/api', '/dav', '/.well-known'];

function excludedFromSpa(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return NO_SPA.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Serves the built web app and the SPA fallback. Always installs the not-found handler:
 * unknown API/DAV/.well-known paths and everything when no build exists answer with an ErrorDto 404.
 */
export async function registerStatic(app: FastifyInstance, webDistDir: string): Promise<void> {
  const hasDist = existsSync(webDistDir) && statSync(webDistDir).isDirectory();

  if (hasDist) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      cacheControl: false,
      setHeaders(reply, filePath) {
        const rel = relative(webDistDir, filePath).replace(/\\/g, '/');
        const hashed = rel.startsWith('assets/');
        reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const spa = hasDist && (req.method === 'GET' || req.method === 'HEAD') && !excludedFromSpa(req.url);
    if (spa) {
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.status(404).send(notFoundBody());
  });
}
