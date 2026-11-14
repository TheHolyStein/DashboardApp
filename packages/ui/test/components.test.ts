import { createRawSnippet } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Empty, Field, Icon, Pane, Stale, Tile } from '../src/index.js';

const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));
const input = createRawSnippet(() => ({ render: () => '<input type="text">' }));
const NOW = new Date('2026-11-14T12:00:00Z');

function ctx(map: Record<string, unknown>): { context: Map<string, unknown> } {
  return { context: new Map(Object.entries(map)) };
}

describe('Tile', () => {
  it('stale flag shows stale badge', () => {
    render(Tile, { props: { title: 'Clock', stale: true, children: text('body') } });
    expect(screen.getByText('Stale')).toBeTruthy();
  });

  it('shows header, body and freshness footer only with updatedAt', () => {
    const a = render(Tile, { props: { title: 'Clock', updatedAt: '2026-11-14T11:55:00Z', now: NOW, children: text('body') } });
    expect(screen.getByRole('heading', { name: 'Clock' })).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
    expect(screen.getByText('5 min ago')).toBeTruthy();
    a.unmount();
    const { container } = render(Tile, { props: { title: 'Clock', children: text('body') } });
    expect(container.querySelector('footer')).toBeNull();
  });

  it('settings button only when onSettings is provided', async () => {
    const onSettings = vi.fn();
    const a = render(Tile, { props: { title: 'Clock', onSettings, children: text('b') } });
    await userEvent.click(screen.getByRole('button', { name: 'Tile settings' }));
    expect(onSettings).toHaveBeenCalledOnce();
    a.unmount();
    render(Tile, { props: { title: 'Clock', children: text('b') } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('strings go through the dash:t context', () => {
    const t = (key: string, fallback: string) => `<${key}|${fallback}>`;
    render(Tile, { props: { title: 'Clock', stale: true, children: text('b') }, ...ctx({ 'dash:t': t }) });
    expect(screen.getByText('<stale.label|Stale>')).toBeTruthy();
  });
});

describe('Pane', () => {
  it('opens as a modal dialog labelled by its title', () => {
    render(Pane, { props: { title: 'Details', onClose: () => {}, children: text('x') } });
    const dlg = screen.getByRole('dialog', { name: 'Details' });
    expect(dlg.hasAttribute('open')).toBe(true);
  });

  it('closes on the close button, Escape and backdrop click', async () => {
    const onClose = vi.fn();
    const a = render(Pane, { props: { title: 'D', onClose, children: text('x') } });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    a.unmount();

    const onClose2 = vi.fn();
    const b = render(Pane, { props: { title: 'D', onClose: onClose2, children: text('x') } });
    screen.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose2).toHaveBeenCalledTimes(1);
    b.unmount();

    const onClose3 = vi.fn();
    render(Pane, { props: { title: 'D', onClose: onClose3, children: text('x') } });
    await userEvent.click(screen.getByText('x')); // inside: no close
    expect(onClose3).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('dialog')); // the dialog element itself is the backdrop area
    expect(onClose3).toHaveBeenCalledTimes(1);
  });

  it('Escape key closes once, and focus returns to the previously focused element', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const a = render(Pane, { props: { title: 'D', onClose, children: text('x') } });
    screen.getByRole('button', { name: 'Close' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('is full-screen under 700 px and not above', () => {
    const prev = window.innerWidth;
    try {
      window.innerWidth = 500;
      const a = render(Pane, { props: { title: 'D', onClose: () => {}, children: text('x') } });
      expect(screen.getByRole('dialog').classList.contains('full')).toBe(true);
      a.unmount();
      window.innerWidth = 1200;
      render(Pane, { props: { title: 'D', onClose: () => {}, children: text('x') } });
      expect(screen.getByRole('dialog').classList.contains('full')).toBe(false);
      window.innerWidth = 400;
      window.dispatchEvent(new Event('resize'));
    } finally {
      window.innerWidth = prev;
    }
  });
});

describe('Icon', () => {
  const svg = '<svg data-test="x"></svg>';
  it('renders the svg from the dash:icons context, aria-hidden without a label', () => {
    const { container } = render(Icon, { props: { name: 'clock' }, ...ctx({ 'dash:icons': (n: string) => (n === 'clock' ? svg : undefined) }) });
    expect(container.querySelector('[data-test="x"]')).toBeTruthy();
    expect(container.querySelector('.icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a placeholder without a provider or for an unknown name', () => {
    const a = render(Icon, { props: { name: 'clock' } });
    expect(a.container.querySelector('[data-placeholder]')).toBeTruthy();
    a.unmount();
    const b = render(Icon, { props: { name: 'nope' }, ...ctx({ 'dash:icons': () => undefined }) });
    expect(b.container.querySelector('[data-placeholder]')).toBeTruthy();
  });

  it('with a label it is exposed as an image', () => {
    render(Icon, { props: { name: 'clock', label: 'Clock' } });
    expect(screen.getByRole('img', { name: 'Clock' })).toBeTruthy();
  });
});

describe('Button', () => {
  it('passes data-edit and aria attributes, calls onclick, defaults to type=button', async () => {
    const onclick = vi.fn();
    render(Button, { props: { onclick, 'data-edit': '', 'aria-label': 'Save it', children: text('Save') } as never });
    const btn = screen.getByRole('button', { name: 'Save it' });
    expect(btn.hasAttribute('data-edit')).toBe(true);
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toContain('ghost');
    await userEvent.click(btn);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('variants and disabled', () => {
    render(Button, { props: { variant: 'danger', disabled: true, children: text('Del') } });
    const btn = screen.getByRole<HTMLButtonElement>('button');
    expect(btn.className).toContain('danger');
    expect(btn.disabled).toBe(true);
  });
});

describe('Field', () => {
  it('binds the label to the control and renders help and an alert for the error', () => {
    render(Field, { props: { label: 'Name', help: 'Your name', error: 'Required', children: input } });
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByText('Your name')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it('has no alert without an error', () => {
    render(Field, { props: { label: 'Name', children: input } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Empty and Stale', () => {
  it('render their text; Stale defaults through t', () => {
    render(Empty, { props: { text: 'Nothing here' } });
    expect(screen.getByText('Nothing here')).toBeTruthy();
    render(Stale, { props: { text: 'Old' } });
    expect(screen.getByText('Old')).toBeTruthy();
  });
});
