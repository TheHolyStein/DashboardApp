/* eslint-disable @typescript-eslint/no-explicit-any -- module components are generic over arbitrary data and settings */
import type { Component } from 'svelte';
import type { Mode, TileSize } from './ids.js';
import type { ModuleManifest } from './manifest.js';

// Bound to /api/m/<id>/, adds CSRF header, throws DashError
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
  level: 'view' | 'edit';
  size: TileSize;
  mode: Mode;
  api: ModuleApi;
  t: Translate;
  openDetail: (params?: Record<string, string>) => void;
}

export interface DetailProps<D = unknown, S = unknown> extends Omit<TileProps<D, S>, 'size' | 'openDetail'> {
  params: Record<string, string>;
  close: () => void;
}

export interface SettingsProps<S = unknown> {
  value: S;
  onChange: (v: S) => void;
  api: ModuleApi;
  t: Translate;
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
