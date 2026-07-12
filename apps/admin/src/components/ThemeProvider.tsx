'use client';

import { useEffect } from 'react';
import { useGym } from '@/context/GymContext';
import { THEMES, DEFAULT_THEME, isThemeKey } from '@/lib/themes';

/**
 * #51: writes theme CSS variables to <html> whenever the active gym's
 * theme_key changes. Chrome components (TopHeader, Sidebar, GymSelector,
 * ui.tsx defaults) read var(--chrome) / var(--brand) / var(--accent).
 *
 * Not a context — the DOM style itself is the shared surface. This runs
 * every render but the setProperty calls are cheap and idempotent.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeGym } = useGym();

  useEffect(() => {
    const key = isThemeKey(activeGym?.theme_key) ? activeGym.theme_key : DEFAULT_THEME;
    const theme = THEMES[key];
    const root = document.documentElement;
    root.style.setProperty('--brand', theme.brand);
    root.style.setProperty('--chrome', theme.chrome);
    root.style.setProperty('--accent', theme.accent);
  }, [activeGym?.theme_key]);

  return <>{children}</>;
}
