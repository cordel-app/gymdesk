'use client';

import { useEffect } from 'react';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';

/**
 * Writes theme CSS variables to <html> whenever the active gym or center changes.
 * Center theme takes priority over gym theme; falls back to DEFAULT_TOKENS.
 * Not a context — the DOM style itself is the shared surface.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeGym } = useGym();
  const { centers, activeCenterId } = useCenter();

  useEffect(() => {
    // Use the explicitly selected center, or the sole center if there's only one.
    const activeCenter = centers.find((c) => c.id === (activeCenterId ?? (centers.length === 1 ? centers[0].id : null)));
    const tokens = (activeCenter?.theme_tokens ?? activeGym?.theme?.tokens ?? DEFAULT_TOKENS) as any;
    applyTokens(tokens);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGym?.theme?.id, activeGym?.id, activeGym?.theme?.tokens, activeCenterId, centers]);

  return <>{children}</>;
}
