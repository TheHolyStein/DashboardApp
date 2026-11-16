import type { TileSize } from '@dash/contract';
import type { ThemeSeam } from '../../src/lib/host.js';

type Resolve = (moduleId: string, size: TileSize | undefined, themeId: string) => Promise<unknown>;

/** A theme seam with a reactive identity and a log of every tileFor call. */
export function reactiveSeam(resolve: Resolve) {
  let id = $state('a');
  const calls: { moduleId: string; size: TileSize | undefined; themeId: string }[] = [];
  const seam: ThemeSeam = {
    get id() {
      return id;
    },
    tileFor: (moduleId, size) => {
      calls.push({ moduleId, size, themeId: id });
      return resolve(moduleId, size, id) as never;
    },
  };
  return {
    seam,
    calls,
    setId(next: string) {
      id = next;
    },
  };
}
