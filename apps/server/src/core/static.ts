import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { notFoundBody } from './errors.js';

/** Default location of the built web app, relative to the server package (src/core or dist/core). */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

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
        const hashed = filePath.replace(/\\/g, '/').includes('/assets/');
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
