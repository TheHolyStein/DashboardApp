/* eslint-disable @typescript-eslint/no-explicit-any -- module components are generic over arbitrary data and settings */
import type { Component } from 'svelte';
import type { InstanceId, Mode, TileSize } from './ids.js';
import type { ModuleManifest } from './manifest.js';

// Bound to /api/m/<id>/ and, for a mounted tile/detail/settings, to its instance (sends `x-dash-instance` on every call;
// routes declared with `instance: 'required'` read it as `req.instance`). Adds CSRF header, throws DashError.
export interface ModuleApi {
  get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export type Translate = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

export interface TileProps<D = unknown, S = unknown> {
  data: D | undefined;
  updatedAt: string | null;
  stale: boolean;
  settings: S;
  /** This instance's id; the `api` already sends it as `x-dash-instance`. */
  instanceId: InstanceId;
  level: 'view' | 'edit';
  size: TileSize;
  mode: Mode;
  api: ModuleApi;
  t: Translate;
  /** The signed-in user's saved locale (BCP 47, e.g. `de-DE`). Pass it to every `Intl`/`toLocale*` call. */
  locale: string;
  /** The signed-in user's saved IANA time zone (e.g. `Asia/Kolkata`). Pass it as `timeZone` when formatting times and dates. */
  timeZone: string;
  /**
   * True when the signed-in user owns the instance. On a shared page it is false: show the owner's data
   * read-only from the snapshot; do not call caller-scoped routes or render mutation controls.
   */
  isOwner: boolean;
  openDetail: (params?: Record<string, string>) => void;
}

export interface DetailProps<D = unknown, S = unknown> extends Omit<TileProps<D, S>, 'size' | 'openDetail'> {
  params: Record<string, string>;
  close: () => void;
}

export interface SettingsProps<S = unknown> {
  instanceId: InstanceId;
  value: S;
  onChange: (v: S) => void;
  api: ModuleApi;
  t: Translate;
  locale: string;
  timeZone: string;
  /** True when the signed-in user owns the instance (always true for the settings dialog today). */
  isOwner: boolean;
}

export interface ModuleClient {
  manifest: ModuleManifest;
  Tile: Component<TileProps<any, any>>;
  Detail: Component<DetailProps<any, any>>;
  Settings?: Component<SettingsProps<any>>;
  icons?: Record<string, string>; // extra svg strings keyed by name
  /** Whether the shell makes the whole tile open the detail pane (default true). `false` for tiles without a detail view. */
  detail?: boolean;
}
