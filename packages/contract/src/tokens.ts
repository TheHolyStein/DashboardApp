// src/tokens.ts — every theme must define every token for both modes.
export const REQUIRED_TOKENS = [
  '--db-bg', '--db-fg', '--db-muted', '--db-accent', '--db-accent-2',
  '--db-surface', '--db-surface-2', '--db-border-color', '--db-border', '--db-radius', '--db-shadow',
  '--db-font-body', '--db-font-heading', '--db-font-mono', '--db-font-display',
  '--db-ok', '--db-warn', '--db-crit', '--db-focus',
  '--db-tile-pad', '--db-gap', '--db-tile-clip', '--db-heading-case', '--db-heading-track',
] as const;
export const CONTRAST_PAIRS: ReadonlyArray<[fg: string, bg: string, min: number]> = [
  ['--db-fg','--db-bg',4.5], ['--db-fg','--db-surface',4.5], ['--db-muted','--db-surface',3], ['--db-accent','--db-surface',3],
];
// Themes scope tokens as: :root[data-theme="<id>"][data-mode="day"] { … } and …[data-mode="night"] { … }
