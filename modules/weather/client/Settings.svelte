<script lang="ts">
  // Instance settings: where the weather is for (search a place, or fall back to the home location) and what to show.
  import type { SettingsProps } from '@dash/contract';
  import { Button, Field } from '@dash/ui';
  import { POLLEN_TYPES, type Place, type PollenType, type Settings } from '../manifest.js';
  import { pollenLabel } from './format.js';

  type Found = Place & { detail: string };

  let { value, onChange, api, t }: SettingsProps<Settings> = $props();

  let query = $state('');
  let results = $state.raw<Found[] | null>(null);
  let busy = $state(false);
  let error = $state('');

  const current = $derived<Settings>({
    location: value?.location ?? null,
    show: {
      pollen: value?.show?.pollen ?? true,
      air: value?.show?.air ?? true,
      uv: value?.show?.uv ?? true,
    },
    pollenTypes: value?.pollenTypes ?? [...POLLEN_TYPES],
  });

  async function search(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      error = t('m.weather.queryShort', 'Type at least two letters.');
      return;
    }
    busy = true;
    error = '';
    try {
      results = await api.get<Found[]>('/geocode', { q });
    } catch {
      results = null;
      error = t('m.weather.searchFailed', 'The place search is not available right now.');
    } finally {
      busy = false;
    }
  }

  function choose(p: Found): void {
    onChange({ ...current, location: { name: p.name, lat: p.lat, lon: p.lon } });
    results = null;
    query = '';
  }

  const toggleShow = (key: keyof Settings['show'], on: boolean): void =>
    onChange({ ...current, show: { ...current.show, [key]: on } });

  function toggleType(type: PollenType, on: boolean): void {
    const next = POLLEN_TYPES.filter((p) => (p === type ? on : current.pollenTypes.includes(p)));
    onChange({ ...current, pollenTypes: next });
  }
</script>

<div class="wx-settings">
  <p class="where">
    {t('m.weather.location', 'Location')}:
    {#if current.location}<strong data-user>{current.location.name}</strong>{:else}<strong>{t('m.weather.home', 'Home location')}</strong>{/if}
  </p>

  <form
    class="search"
    onsubmit={(e) => {
      e.preventDefault();
      void search();
    }}
  >
    <Field label={t('m.weather.search', 'Search for a place')}>
      {#snippet children({ describedBy, invalid })}
        <input type="search" bind:value={query} maxlength="80" autocomplete="off" aria-describedby={describedBy} aria-invalid={invalid} />
      {/snippet}
    </Field>
    <Button type="submit" {busy}>{t('m.weather.searchButton', 'Search')}</Button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}

  {#if results}
    {#if results.length === 0}
      <p>{t('m.weather.noMatch', 'No place found.')}</p>
    {:else}
      <ul class="results">
        {#each results as p (`${p.lat},${p.lon}`)}
          <li>
            <Button onclick={() => choose(p)}>
              <span data-user>{p.name}</span>{#if p.detail}, <span data-user>{p.detail}</span>{/if}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#if current.location}
    <Button onclick={() => onChange({ ...current, location: null })}>{t('m.weather.useHome', 'Use the home location')}</Button>
  {/if}

  <fieldset>
    <legend>{t('m.weather.show', 'Show')}</legend>
    <label><input type="checkbox" checked={current.show.pollen} onchange={(e) => toggleShow('pollen', e.currentTarget.checked)} /> {t('m.weather.pollen', 'Pollen')}</label>
    <label><input type="checkbox" checked={current.show.air} onchange={(e) => toggleShow('air', e.currentTarget.checked)} /> {t('m.weather.airQuality', 'Air quality')}</label>
    <label><input type="checkbox" checked={current.show.uv} onchange={(e) => toggleShow('uv', e.currentTarget.checked)} /> {t('m.weather.uv', 'UV')}</label>
  </fieldset>

  {#if current.show.pollen}
    <fieldset>
      <legend>{t('m.weather.pollenTypes', 'Pollen types')}</legend>
      {#each POLLEN_TYPES as type (type)}
        <label>
          <input type="checkbox" checked={current.pollenTypes.includes(type)} onchange={(e) => toggleType(type, e.currentTarget.checked)} />
          {pollenLabel(t, type)}
        </label>
      {/each}
    </fieldset>
  {/if}
</div>

<style>
  .wx-settings {
    display: grid;
    gap: 0.75rem;
    color: var(--db-fg);
  }
  p,
  ul {
    margin: 0;
    padding: 0;
  }
  .search {
    display: flex;
    align-items: end;
    gap: 0.5rem;
  }
  .results {
    display: grid;
    gap: 0.25rem;
    list-style: none;
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    border: 1px solid var(--db-border-color, currentColor);
    border-radius: var(--db-radius, 4px);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
</style>
