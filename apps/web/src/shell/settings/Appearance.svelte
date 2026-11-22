<script lang="ts">
  import type { Intensity } from '@dash/contract';
  import { api } from '../../lib/api.js';
  import { PageDto } from '@dash/contract';
  import { themes as generatedThemes } from '../../generated/themes.js';
  import { t } from '../../lib/i18n.js';
  import { pages } from '../../lib/pages.svelte.js';
  import { loadIntensityOverride, MODE_CYCLE, savePrefs, storeIntensityOverride, type ModePolicy } from '../../lib/prefs.js';
  import { session } from '../../lib/session.svelte.js';
  import { setUserIntensityOverride } from '../../theme/intensity.js';
  import { theme, type ThemeEngine } from '../../theme/engine.svelte.js';

  let {
    registry = generatedThemes,
    engine = theme,
    applyIntensity = setUserIntensityOverride,
  }: {
    registry?: Record<string, { meta?: { id: string; name: string } | undefined }>;
    engine?: Pick<ThemeEngine, 'set' | 'setPolicy' | 'current'>;
    applyIntensity?: typeof setUserIntensityOverride;
  } = $props();

  const entries = $derived(Object.entries(registry).map(([id, e]) => ({ id, name: e.meta?.name ?? id })));

  // ---- theme ----
  let themeId = $state(session.me?.prefs.theme ?? 'default');
  let themeError = $state('');
  async function pickTheme(id: string): Promise<void> {
    const previous = session.me?.prefs.theme ?? 'default';
    if (id === previous) return;
    themeError = '';
    themeId = id;
    void engine.set(id); // instant preview
    try {
      await savePrefs({ theme: id });
    } catch {
      themeId = previous;
      void engine.set(previous);
      themeError = t('appearance.themeFailed', 'Could not save the theme. The previous one is back.');
    }
  }

  // ---- mode policy ----
  let policy = $state<ModePolicy>(session.me?.prefs.modePolicy ?? 'system');
  let policyError = $state('');
  const POLICY_NAMES: Record<ModePolicy, () => string> = {
    day: () => t('mode.day', 'Day'),
    night: () => t('mode.night', 'Night'),
    system: () => t('mode.system', 'System'),
    sun: () => t('mode.sun', 'Sun'),
  };
  async function pickPolicy(p: ModePolicy): Promise<void> {
    const previous = session.me?.prefs.modePolicy ?? 'system';
    if (p === previous) return;
    policyError = '';
    policy = p;
    engine.setPolicy(p);
    try {
      await savePrefs({ modePolicy: p });
    } catch {
      policy = previous;
      engine.setPolicy(previous);
      policyError = t('appearance.modeFailed', 'Could not save the colour mode.');
    }
  }

  // ---- background of the current page (page owner only) ----
  const page = $derived(pages.current);
  const owner = $derived(!!page && page.ownerId === session.me?.id);
  const bgOptions = $derived([
    { value: '', label: t('appearance.bgDefault', 'Theme default') },
    { value: 'rotate', label: t('appearance.bgRotate', 'Rotate daily') },
    ...engine.current.backgrounds.map((b) => ({ value: b.id, label: t(`background.${b.id}`, b.name) })),
  ]);
  let bgError = $state('');
  async function pickBackground(value: string): Promise<void> {
    if (!page) return;
    bgError = '';
    try {
      const updated = await api.patch(`/pages/${encodeURIComponent(page.id)}`, { background: value === '' ? null : value }, PageDto);
      pages.replacePage(updated);
    } catch {
      bgError = t('appearance.bgFailed', 'Could not save the background.');
    }
  }

  // ---- animation intensity (per device) ----
  let intensity = $state<string>(loadIntensityOverride() ?? 'auto');
  function pickIntensity(value: string): void {
    intensity = value;
    const v = value === 'auto' ? null : (value as Intensity);
    storeIntensityOverride(v);
    applyIntensity(v);
  }
</script>

<div class="st">
  <fieldset>
    <legend>{t('appearance.theme', 'Theme')}</legend>
    {#if entries.length === 0}
      <p class="muted">{t('appearance.noThemes', 'No themes installed.')}</p>
    {/if}
    {#each entries as e (e.id)}
      <label><input type="radio" name="theme" value={e.id} checked={themeId === e.id} onchange={() => void pickTheme(e.id)} />{e.name}</label>
    {/each}
    {#if themeError}<p class="err" role="alert">{themeError}</p>{/if}
  </fieldset>

  <fieldset>
    <legend>{t('appearance.mode', 'Colour mode')}</legend>
    {#each MODE_CYCLE as p (p)}
      <label><input type="radio" name="mode" value={p} checked={policy === p} onchange={() => void pickPolicy(p)} />{POLICY_NAMES[p]()}</label>
    {/each}
    {#if policyError}<p class="err" role="alert">{policyError}</p>{/if}
  </fieldset>

  {#if owner && page}
    <div class="stack">
      <label>
        {t('appearance.background', 'Background of this page')}
        <select value={page.background ?? ''} onchange={(e) => void pickBackground(e.currentTarget.value)}>
          {#each bgOptions as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </label>
      {#if bgError}<p class="err" role="alert">{bgError}</p>{/if}
    </div>
  {/if}

  <div class="stack">
    <label>
      {t('appearance.intensity', 'Animation on this device')}
      <select value={intensity} onchange={(e) => pickIntensity(e.currentTarget.value)}>
        <option value="auto">{t('appearance.intensityAuto', 'Automatic')}</option>
        <option value="full">{t('appearance.intensityFull', 'Full')}</option>
        <option value="calm">{t('appearance.intensityCalm', 'Calm')}</option>
        <option value="static">{t('appearance.intensityStatic', 'Static')}</option>
      </select>
    </label>
    <p class="muted">{t('appearance.intensityHelp', 'Automatic lowers the animation on slow devices, battery saver and reduced motion.')}</p>
  </div>
</div>
