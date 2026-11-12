import type { z } from 'zod';
import type { ModuleClient, ModuleManifest, ModuleServer, ThemeManifest } from '@dash/contract';

export function defineManifest<S extends z.ZodType, C extends z.ZodType>(
  m: ModuleManifest<S, C>,
): ModuleManifest<S, C> {
  return m;
}

/** Identity helper that throws when `jobs` / `on` keys disagree with the manifest. */
export function defineServer<S>(m: ModuleServer<S>): ModuleServer<S> {
  const declaredJobs = new Set(m.manifest.jobs.map((j) => j.name));
  const jobKeys = Object.keys(m.jobs ?? {});
  for (const name of declaredJobs) {
    if (!jobKeys.includes(name)) throw new Error(`manifest job "${name}" has no handler in server.jobs`);
  }
  for (const key of jobKeys) {
    if (!declaredJobs.has(key)) throw new Error(`server.jobs handler "${key}" is not declared in manifest.jobs`);
  }
  const subscribes: readonly string[] = m.manifest.subscribes;
  for (const key of Object.keys(m.on ?? {})) {
    if (!subscribes.includes(key)) throw new Error(`server.on handler "${key}" is not in manifest.subscribes`);
  }
  return m;
}

export function defineClient(m: ModuleClient): ModuleClient {
  return m;
}

export function defineTheme(m: ThemeManifest): ThemeManifest {
  return m;
}
