import type { IconKey } from '@dash/contract';

// 24x24 line icons: stroke is currentColor, so they follow the text colour of wherever they are drawn.
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons: Record<IconKey, string> = {
  settings: svg(
    '<path d="M10.3 3h3.4l.5 2.4 1.7.7 2.1-1.3 2.4 2.4-1.3 2.1.7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.3 2.1-2.4 2.4-2.1-1.3-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2.1 1.3-2.4-2.4 1.3-2.1-.7-1.7L3 13.7v-3.4l2.4-.5.7-1.7-1.3-2.1 2.4-2.4 2.1 1.3 1.7-.7z"/><circle cx="12" cy="12" r="3"/>',
  ),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  remove: svg('<path d="M5 12h14"/>'),
  drag: svg(
    '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  ),
  resize: svg('<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>'),
  bell: svg('<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>'),
  day: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  ),
  night: svg('<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>'),
  warn: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'),
  stale: svg('<path d="M6 3h12M6 21h12M7 3v4l5 5-5 5v4M17 3v4l-5 5 5 5v4"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  todo: svg('<path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9"/>'),
  weather: svg('<path d="M7 18a4 4 0 010-8 5 5 0 019.6-1A4.5 4.5 0 0117 18z"/>'),
  network: svg(
    '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/>',
  ),
  nas: svg(
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  ),
  server: svg(
    '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5v.01M7 16.5v.01"/>',
  ),
  rss: svg('<path d="M4 11a9 9 0 019 9M4 4a16 16 0 0116 16"/><circle cx="5" cy="19" r="1"/>'),
  moon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 010 18z"/>'),
  stocks: svg('<path d="M3 17l5-6 4 4 8-9"/><path d="M15 6h5v5"/>'),
  art: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M3 17l5-4 4 3 3-2 6 4"/>'),
  github: svg(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
  ),
  wled: svg(
    '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z"/>',
  ),
  link: svg(
    '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  ),
  note: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/>'),
  habit: svg('<path d="M4 12a8 8 0 0113.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 01-13.7 5.6L4 16M4 20v-4h4"/>'),
  timer: svg('<circle cx="12" cy="14" r="7"/><path d="M12 10v4l2 2M10 3h4M12 3v4"/>'),
  launch: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>'),
};
