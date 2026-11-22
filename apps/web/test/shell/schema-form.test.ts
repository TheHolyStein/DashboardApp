import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { coerce, describeSchema, emptyValue, fillForm } from '../../src/lib/schema-form.js';
import { t } from '../../src/lib/i18n.js';
import SchemaForm from '../../src/shell/SchemaForm.svelte';
import { clockSettings, feedSettings } from '../fixtures/editRegistry.js';

const kitchen = z.object({
  name: z.string().meta({ label: 'Display name', help: 'Shown on the tile' }),
  note: z.string().optional().meta({ widget: 'textarea' }),
  site: z.url(),
  pass: z.string().meta({ widget: 'secret' }),
  count: z.number().min(1).max(10).multipleOf(0.5),
  whole: z.number().int(),
  on: z.boolean().default(true),
  mode: z.enum(['a', 'b']),
  tags: z.array(z.string()),
  feeds: z.array(z.object({ url: z.string(), n: z.number().optional() })),
  box: z.object({ inner: z.string().default('x') }),
  refreshMinutes: z.number().nullable(),
});

describe('describeSchema', () => {
  it('describeSchema maps each supported kind', () => {
    const f = Object.fromEntries(describeSchema(kitchen).map((s) => [s.key, s]));
    expect(f.name).toMatchObject({ kind: 'string', label: 'Display name', help: 'Shown on the tile', required: true });
    expect(f.note).toMatchObject({ kind: 'string', widget: 'textarea', required: false });
    expect(f.site).toMatchObject({ kind: 'string', widget: 'url' });
    expect(f.pass).toMatchObject({ kind: 'string', widget: 'secret' });
    expect(f.count).toMatchObject({ kind: 'number', min: 1, max: 10, step: 0.5, required: true });
    expect(f.whole).toMatchObject({ kind: 'number', step: 1 });
    expect(f.on).toMatchObject({ kind: 'boolean', required: false, default: true });
    expect(f.mode).toMatchObject({ kind: 'enum', options: ['a', 'b'] });
    expect(f.tags).toMatchObject({ kind: 'list', of: { kind: 'string' } });
    expect(f.feeds).toMatchObject({
      kind: 'list',
      of: { kind: 'group', fields: [{ key: 'url', kind: 'string' }, { key: 'n', kind: 'number', required: false }] },
    });
    expect(f.box).toMatchObject({ kind: 'group', fields: [{ key: 'inner', default: 'x', required: false }] });
    expect(f.refreshMinutes).toMatchObject({ label: 'Refresh minutes', required: false, default: null });
  });

  it('reads defaults and required flags', () => {
    const f = Object.fromEntries(describeSchema(clockSettings).map((s) => [s.key, s]));
    expect(f.title).toMatchObject({ required: true, label: 'Title', help: 'Shown in the header' });
    expect(f.refresh).toMatchObject({ required: false, default: 5, min: 1, max: 60 });
    expect(f.zone).toMatchObject({ required: false, widget: 'timezone', label: 'Zone' });
  });

  it('unsupported schema throws a clear error naming the key', () => {
    const bad = z.object({ ok: z.string(), nested: z.object({ deep: z.object({ x: z.string() }) }) });
    expect(() => describeSchema(bad)).toThrow(/"nested\.deep".*own Settings component/);
    expect(() => describeSchema(z.object({ pair: z.tuple([z.string()]) }))).toThrow(/"pair".*Settings component/);
    expect(() => describeSchema(z.object({ l: z.array(z.array(z.string())) }))).toThrow(/"l\[\]"/);
    expect(() => describeSchema(z.object({ l: z.array(z.object({ p: z.string().meta({ widget: 'secret' }) })) }))).toThrow(/"l\[\]\.p"/);
  });
});

describe('emptyValue and coerce', () => {
  const fields = describeSchema(feedSettings);

  it('builds defaults for a fresh form', () => {
    expect(emptyValue(fields)).toEqual({ token: '', feeds: [], mode: 'list', compact: false });
  });

  it('turns "5" into 5 and an empty optional string into undefined', () => {
    const f = describeSchema(z.object({ n: z.number(), s: z.string().optional(), r: z.string(), g: z.object({ k: z.number().optional() }) }));
    expect(coerce(f, { n: '5', s: '', r: '', g: { k: '' } })).toEqual({ n: 5, r: '', g: {} });
    expect(coerce(f, { n: 'abc', r: 'x', g: { k: '2.5' } })).toEqual({ n: 'abc', r: 'x', g: { k: 2.5 } });
  });

  it('coerces lists of groups recursively and fills a form from stored settings', () => {
    const f = describeSchema(z.object({ feeds: z.array(z.object({ url: z.string(), n: z.number().optional() })) }));
    expect(coerce(f, { feeds: [{ url: 'a', n: '3' }, { url: 'b', n: '' }] })).toEqual({ feeds: [{ url: 'a', n: 3 }, { url: 'b' }] });
    expect(fillForm(f, { feeds: [{ url: 'a', n: 3 }] })).toEqual({ feeds: [{ url: 'a', n: 3 }] });
  });
});

type Feeds = { feeds: { title: string }[] };
const lastFeeds = (fn: ReturnType<typeof vi.fn>): Feeds['feeds'] => (fn.mock.lastCall?.[0] as Feeds).feeds;
const titles = (fn: ReturnType<typeof vi.fn>): string[] => lastFeeds(fn).map((x) => x.title);

describe('SchemaForm', () => {
  const fields = describeSchema(feedSettings);
  const base = { fields, errors: {}, t, moduleId: 'feeds' };

  it('adds an item to a list of flat objects', async () => {
    const onChange = vi.fn();
    render(SchemaForm, { props: { ...base, value: emptyValue(fields), onChange } });
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ feeds: [{ url: '', title: '' }] }));
  });

  it('removes and reorders list items', async () => {
    const onChange = vi.fn();
    const value = { ...emptyValue(fields), feeds: [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B' }] };
    render(SchemaForm, { props: { ...base, value, onChange } });
    const items = document.querySelectorAll<HTMLElement>('[data-item]');
    expect(items).toHaveLength(2);
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Move down' }));
    expect(titles(onChange)).toEqual(['B', 'A']);
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Move up' }));
    expect(titles(onChange)).toEqual(['B', 'A']);
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Remove' }));
    expect(lastFeeds(onChange)).toEqual([{ url: 'https://b.example', title: 'B' }]);
  });

  it('shows errors by dotted path and marks controls data-edit', () => {
    const value = { ...emptyValue(fields), feeds: [{ url: 'x', title: '' }] };
    render(SchemaForm, { props: { ...base, value, onChange: vi.fn(), errors: { 'feeds.0.url': 'Invalid URL', token: 'Required' } } });
    expect(screen.getByText('Invalid URL')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
    for (const el of document.querySelectorAll('input, select, textarea, button')) expect(el.hasAttribute('data-edit')).toBe(true);
  });

  it('renders a secret as a password input with a placeholder when set', () => {
    render(SchemaForm, { props: { ...base, value: emptyValue(fields), onChange: vi.fn(), secretsSet: new Set(['token']) } });
    const input = screen.getByLabelText<HTMLInputElement>('Token');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Saved — leave empty to keep');
  });
});
