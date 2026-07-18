'use client';

import { useEffect } from 'react';
import { useApp } from '@/context/AppContext';

// Default token values kept in sync with apps/admin/src/lib/themeTokens.ts.
const DEFAULT_COLORS = {
  appBackground:             '#f5f5f5',
  headerBackground:          '#18181b',
  headerText:                '#ffffff',
  headerSeparatorColor:      '#6c63ff',
  headerSeparatorHeight:     2,
  sidebarBackground:         '#18181b',
  sidebarText:               '#e5e7eb',
  sidebarSelectedBackground: '#6c63ff',
  sidebarSelectedText:       '#ffffff',
};

function applyTokens(tokens: Record<string, any> | null) {
  const el = document.documentElement;
  const c = tokens?.colors ?? DEFAULT_COLORS;

  el.style.setProperty('--gd-app-bg',               c.appBackground ?? DEFAULT_COLORS.appBackground);
  el.style.setProperty('--gd-header-bg',             c.headerBackground ?? DEFAULT_COLORS.headerBackground);
  el.style.setProperty('--gd-header-text',           c.headerText ?? DEFAULT_COLORS.headerText);
  el.style.setProperty('--gd-header-sep-color',      c.headerSeparatorColor ?? DEFAULT_COLORS.headerSeparatorColor);
  el.style.setProperty('--gd-header-sep-height',     `${c.headerSeparatorHeight ?? DEFAULT_COLORS.headerSeparatorHeight}px`);
  el.style.setProperty('--gd-sidebar-bg',            c.sidebarBackground ?? DEFAULT_COLORS.sidebarBackground);
  el.style.setProperty('--gd-sidebar-text',          c.sidebarText ?? DEFAULT_COLORS.sidebarText);
  el.style.setProperty('--gd-sidebar-selected-bg',   c.sidebarSelectedBackground ?? DEFAULT_COLORS.sidebarSelectedBackground);
  el.style.setProperty('--gd-sidebar-selected-text', c.sidebarSelectedText ?? DEFAULT_COLORS.sidebarSelectedText);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useApp();

  useEffect(() => {
    applyTokens(theme?.tokens ?? null);
  }, [theme?.id]);

  return <>{children}</>;
}
