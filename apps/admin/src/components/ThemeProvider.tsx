'use client';

import { useEffect } from 'react';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';
import { saveThemeSnapshot } from '@/lib/themeSnapshot';

/**
 * Writes theme CSS variables to <html> whenever the active gym or center changes.
 * Center theme takes priority over gym theme; falls back to DEFAULT_TOKENS.
 * Not a context — the DOM style itself is the shared surface.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeGym, loading } = useGym();
  const { centers, activeCenterId } = useCenter();

  useEffect(() => {
    // #1299 — until the gyms have loaded the theme is unknown, and applying
    // DEFAULT_TOKENS here would repaint the blue fallback over the snapshot the
    // <head> script already restored. Only a settled answer (including "no gym")
    // is applied.
    if (loading && !activeGym) return;
    // Use the explicitly selected center, or the sole center if there's only one.
    const activeCenter = centers.find((c) => c.id === (activeCenterId ?? (centers.length === 1 ? centers[0].id : null)));
    const tokens = (activeCenter?.theme_tokens ?? activeGym?.theme?.tokens ?? DEFAULT_TOKENS) as any;
    applyTokens(tokens);
    if (activeGym) saveThemeSnapshot(activeGym.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGym?.theme?.id, activeGym?.id, activeGym?.theme?.tokens, activeCenterId, centers, loading]);

  return <>{children}</>;
}
