export interface ThemeTokenTypography {
  fontFamily: string;
  color: string;
}

export interface ThemeTokens {
  v: number;
  typography: {
    h1: ThemeTokenTypography;
    h2: ThemeTokenTypography;
    h3: ThemeTokenTypography;
    body: ThemeTokenTypography;
    small: ThemeTokenTypography;
  };
  colors: {
    appBackground: string;
    headerBackground: string;
    headerText: string;
    headerSeparatorColor: string;
    headerSeparatorHeight: number;
    sidebarBackground: string;
    sidebarText: string;
    sidebarSelectedBackground: string;
    sidebarSelectedText: string;
  };
}

export const DEFAULT_TOKENS: ThemeTokens = {
  v: 1,
  typography: {
    h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#6b7280' },
  },
  colors: {
    appBackground:             '#f5f5f5',
    headerBackground:          '#1a1a2e',
    headerText:                '#ffffff',
    headerSeparatorColor:      '#6c63ff',
    headerSeparatorHeight:     2,
    sidebarBackground:         '#1a1a2e',
    sidebarText:               '#e5e7eb',
    sidebarSelectedBackground: '#6c63ff',
    sidebarSelectedText:       '#ffffff',
  },
};

export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'System UI',      value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',           value: '"Courier New", Courier, monospace' },
  { label: 'Arial',          value: 'Arial, Helvetica, sans-serif' },
  { label: 'Trebuchet',      value: '"Trebuchet MS", sans-serif' },
];

export function applyTokens(tokens: ThemeTokens) {
  const el = document.documentElement;
  const c = tokens.colors;
  const ty = tokens.typography;

  // New --gd-* variables
  el.style.setProperty('--gd-app-bg',             c.appBackground);
  el.style.setProperty('--gd-header-bg',           c.headerBackground);
  el.style.setProperty('--gd-header-text',         c.headerText);
  el.style.setProperty('--gd-header-sep-color',    c.headerSeparatorColor);
  el.style.setProperty('--gd-header-sep-height',   `${c.headerSeparatorHeight}px`);
  el.style.setProperty('--gd-sidebar-bg',          c.sidebarBackground);
  el.style.setProperty('--gd-sidebar-text',        c.sidebarText);
  el.style.setProperty('--gd-sidebar-selected-bg', c.sidebarSelectedBackground);
  el.style.setProperty('--gd-sidebar-selected-text', c.sidebarSelectedText);

  el.style.setProperty('--gd-font-h1',    ty.h1.fontFamily);
  el.style.setProperty('--gd-color-h1',   ty.h1.color);
  el.style.setProperty('--gd-font-h2',    ty.h2.fontFamily);
  el.style.setProperty('--gd-color-h2',   ty.h2.color);
  el.style.setProperty('--gd-font-h3',    ty.h3.fontFamily);
  el.style.setProperty('--gd-color-h3',   ty.h3.color);
  el.style.setProperty('--gd-font-body',  ty.body.fontFamily);
  el.style.setProperty('--gd-color-body', ty.body.color);
  el.style.setProperty('--gd-font-small', ty.small.fontFamily);
  el.style.setProperty('--gd-color-small',ty.small.color);

  // Legacy aliases — keep during rollout so existing chrome components continue to work.
  el.style.setProperty('--brand',  c.sidebarSelectedBackground);
  el.style.setProperty('--chrome', c.headerBackground);
  el.style.setProperty('--accent', c.headerSeparatorColor);
}
