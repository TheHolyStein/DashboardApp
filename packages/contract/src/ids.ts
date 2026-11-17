export const CONTRACT_VERSION = 2;
/** Svelte context keys the shell/theme engine provide; modules and `@dash/ui` read them through these constants. */
export const THEME_CONTEXT_KEY = 'dash:theme';
export const T_CONTEXT_KEY = 'dash:t';
export const ICONS_CONTEXT_KEY = 'dash:icons';
export const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export type ModuleId = string;
export type ThemeId = string;
export type InstanceId = string;      // uuid v7
export type UserId = string;          // uuid v7
export type PermissionLevel = 'none' | 'view' | 'edit';
export type Mode = 'day' | 'night';
export type Intensity = 'full' | 'calm' | 'static';
export const GRID_COLUMNS = 12;
export const GRID_ROW_PX = 80;
export interface TileSize { w: number; h: number }   // grid units
