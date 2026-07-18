'use client';

import { useEffect } from 'react';
import { useGym } from '@/context/GymContext';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';

/**
 * #68: writes theme CSS variables to <html> whenever the active gym's theme
 * changes. Falls back to DEFAULT_TOKENS when no theme is assigned.
 * Not a context — the DOM style itself is the shared surface.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeGym } = useGym();

  useEffect(() => {
    // Cast: tokens shape is validated server-side; falls back to DEFAULT_TOKENS when null.
    applyTokens((activeGym?.theme?.tokens as any) ?? DEFAULT_TOKENS);
  }, [activeGym?.theme?.id, activeGym?.id]);

  return <>{children}</>;
}
