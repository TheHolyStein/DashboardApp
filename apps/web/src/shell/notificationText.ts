import type { Notification } from '../lib/notifications.svelte.js';
import { t } from '../lib/i18n.js';

/** Notification title: translated by `titleKey` (with `vars`) when the module sent one, else the English `title`. */
export function titleOf(n: Notification): string {
  return n.titleKey ? t(n.titleKey, n.title, n.vars ?? undefined) : n.title;
}

/** Notification body (may be absent). */
export function bodyOf(n: Notification): string | null {
  if (n.body === null) return null;
  return n.bodyKey ? t(n.bodyKey, n.body, n.vars ?? undefined) : n.body;
}
