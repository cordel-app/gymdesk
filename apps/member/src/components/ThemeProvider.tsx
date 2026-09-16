'use client';

import { useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { DEFAULT_TOKENS, applyTokens, ThemeTokens } from '@/lib/themeTokens';

/**
 * Writes theme CSS variables to <html> whenever the active gym's theme
 * changes. Same full `--gd-*` var set as apps/admin's ThemeProvider (#489
 * stage 4) — Member Web has no center-level theme override today, so this
 * only resolves gym theme vs. defaults, unlike Admin's center-then-gym chain.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useApp();

  useEffect(() => {
    applyTokens((theme?.tokens ?? DEFAULT_TOKENS) as ThemeTokens);
  }, [theme?.id]);

  return <>{children}</>;
}
