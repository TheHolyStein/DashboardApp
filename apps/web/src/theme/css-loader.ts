/** Bundled theme files. Lazy globs: with no theme folders present they are empty and the build still succeeds. */
const cssFiles = import.meta.glob('../../../../themes/*/**/*.css', { query: '?url', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;
const assetFiles = import.meta.glob('../../../../themes/*/**/*.{png,jpg,jpeg,webp,avif,gif,svg,woff,woff2}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const PREFIX = '../../../../themes/';
const LOAD_TIMEOUT_MS = 10_000;

export interface StylesheetHandle {
  remove(): void;
}
export type StylesheetLoader = (themeId: string, cssPath: string) => Promise<StylesheetHandle>;

function key(themeId: string, path: string): string {
  return `${PREFIX}${themeId}/${path.replace(/^\.?\//, '')}`;
}

/** URL of a bundled theme file (static image, font, ...); `path` is relative to the theme folder. */
export async function themeAssetUrl(themeId: string, path: string): Promise<string> {
  const k = key(themeId, path);
  const load = assetFiles[k] ?? cssFiles[k];
  if (!load) throw new Error(`theme asset not found: ${themeId}/${path}`);
  return load();
}

/** Production loader: resolves the built stylesheet URL and appends a <link>; resolves on `load`. */
export const loadThemeStylesheet: StylesheetLoader = async (themeId, cssPath) => {
  const load = cssFiles[key(themeId, cssPath)];
  if (!load) throw new Error(`theme stylesheet not found: ${themeId}/${cssPath}`);
  const href = await load();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.themeCss = themeId;
  link.href = href;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      link.remove();
      reject(new Error(`theme stylesheet timed out: ${themeId}/${cssPath}`));
    }, LOAD_TIMEOUT_MS);
    link.addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    });
    link.addEventListener('error', () => {
      clearTimeout(timer);
      link.remove();
      reject(new Error(`theme stylesheet failed: ${themeId}/${cssPath}`));
    });
    document.head.append(link);
  });
  return { remove: () => link.remove() };
};
