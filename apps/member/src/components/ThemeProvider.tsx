'use client';

import { useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { DEFAULT_TOKENS, applyTokens, ThemeTokens } from '@/lib/themeTokens';
import { applyMembersAppTokens } from '@/lib/membersAppTokens';
import { CARD_TOUCH_CSS } from '@/lib/cardTouch';

/**
 * Writes theme CSS variables to <html> whenever the active gym's theme
 * changes. Same full `--gd-*` var set as apps/admin's ThemeProvider (#489
 * stage 4) — Member Web has no center-level theme override today, so this
 * only resolves gym theme vs. defaults, unlike Admin's center-then-gym chain.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useApp();

  useEffect(() => {
    const tokens = (theme?.tokens ?? DEFAULT_TOKENS) as ThemeTokens;
    applyTokens(tokens);
    // #833 — then the Members App's own settings, each resolved against its
    // Admin source unless this Theme overrides it. Written after the Theme's
    // own variables so a Members App setting sharing a variable with its
    // source (the page background, the calendar surfaces, the titles) wins.
    applyMembersAppTokens(tokens);
  }, [theme?.id, theme?.tokens]);

  return (
    <>
      <style>{CARD_TOUCH_CSS}</style>
      {children}
    </>
  );
}
