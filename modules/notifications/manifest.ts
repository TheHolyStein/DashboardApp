import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

/** One notification as the tile and the detail show it. `titleKey`/`vars` let the dashboard translate the title. */
export type NotificationItem = {
  id: string;
  moduleId: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  body: string | null;
  titleKey: string | null;
  bodyKey: string | null;
  vars: Record<string, string | number> | null;
  url: string | null;
  createdAt: string;
  readAt: string | null;
};

/**
 * What the server pushes to each of a user's instances. `unread` leaves out muted modules; `latest` are the newest
 * unread notifications of modules that are not muted (at most 5). `epoch` names the server boot, `rev` rises with
 * every change of the user's notifications or mutes.
 */
export type Snapshot = {
  epoch: string;
  rev: number;
  unread: number;
  latest: Array<{ id: string; level: string; title: string; moduleId: string; createdAt: string }>;
};

/** The body of `GET /list`: one page of 50, newest first. `next` is the `before` cursor of the next page, or null. */
export type ListPage = { epoch: string; rev: number; items: NotificationItem[]; next: string | null };

/** The body of `POST /read`. */
export type ReadResult = { epoch: string; rev: number; unread: number };

/** The body of `GET /mutes` and `PUT /mutes`: active mutes by module id; the value is an ISO time or `forever`. */
export type MutesState = { epoch: string; rev: number; mutes: Record<string, string> };

export default defineManifest({
  id: 'notifications',
  name: 'Notifications',
  description: 'Everything the dashboard told you: unread count, latest alerts, history and per-module mutes.',
  version: '0.1.0',
  icon: 'note',
  scope: 'user',
  multiInstance: false,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 6 } },
  settings: z.object({}),
  config: z.object({}),
  levels: ['view'],
  jobs: [],
  publishes: [],
  subscribes: ['notification.created'],
  outbound: [],
});
