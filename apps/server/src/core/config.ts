import { join } from 'node:path';
import type { AppConfig } from '../seams.js';

const ENVS = ['development', 'production', 'test'] as const;

/** Reads the DASH_* environment. Throws one error listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];

  const dataDir = env.DASH_DATA_DIR || './.data';
  const configDir = env.DASH_CONFIG_DIR || join(dataDir, 'config');

  let port = 8787;
  if (env.DASH_PORT !== undefined && env.DASH_PORT !== '') {
    const n = Number(env.DASH_PORT);
    if (/^\d+$/.test(env.DASH_PORT) && n >= 0 && n <= 65535) port = n;
    else problems.push(`DASH_PORT must be an integer 0-65535 (0 = pick a free port) (got "${env.DASH_PORT}")`);
  }

  let nodeEnv: AppConfig['env'] = 'development';
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== '') {
    if ((ENVS as readonly string[]).includes(env.NODE_ENV)) nodeEnv = env.NODE_ENV as AppConfig['env'];
    else problems.push(`NODE_ENV must be one of ${ENVS.join(', ')} (got "${env.NODE_ENV}")`);
  }

  if (env.DASH_HOST !== undefined && env.DASH_HOST !== '' && env.DASH_HOST !== '127.0.0.1') {
    problems.push(`DASH_HOST must be 127.0.0.1 (the server binds loopback only; got "${env.DASH_HOST}")`);
  }

  let baseUrl = `http://127.0.0.1:${port}`;
  if (env.DASH_BASE_URL !== undefined && env.DASH_BASE_URL !== '') {
    try {
      const u = new URL(env.DASH_BASE_URL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      baseUrl = env.DASH_BASE_URL.replace(/\/+$/, '');
    } catch {
      problems.push(`DASH_BASE_URL must be an http(s) URL (got "${env.DASH_BASE_URL}")`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }

  return {
    dataDir,
    configDir,
    host: '127.0.0.1',
    port,
    baseUrl,
    secretKeyFile: env.DASH_SECRET_KEY_FILE || join(configDir, 'secret.key'),
    env: nodeEnv,
  };
}
