'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { DEFAULT_TOKENS } from '@/lib/themeTokens';
import {
  BACKGROUND_SCRIM_ALPHA,
  backgroundStyleValue,
  backgroundUrlForSlot,
  hexToRgba,
  slotForPathname,
} from '@/lib/membersBackground';

/**
 * #725: paints the active theme's background artwork behind the page.
 *
 * Background artwork, not an image block: the image is the `<body>`'s own
 * background, so nothing about the Members App's navigation, cards, icons,
 * labels or hierarchy changes — the pages render exactly as they did, over a
 * picture instead of over a flat colour. It sits in the layout next to
 * `ThemeProvider`, which is what already writes the theme's colours to the
 * document, and follows the same rule: one effect, no markup.
 *
 * When the slot is not configured the body's background is cleared back to the
 * value the stylesheet gives it — `var(--gd-app-bg)`, the theme background
 * colour — which is the only fallback #725 allows. Nothing is fetched for a
 * `null` slot: there is no URL to fetch.
 */
export function MembersBackground() {
  const { theme } = useApp();
  const pathname = usePathname();
  const images = theme?.members_images ?? null;
  const url = backgroundUrlForSlot(images, slotForPathname(pathname));
  const pageBackground = (theme?.tokens as any)?.colors?.pageBackground ?? DEFAULT_TOKENS.colors.pageBackground;

  useEffect(() => {
    const { body } = document;
    if (!body) return;
    const value = backgroundStyleValue(url, hexToRgba(pageBackground, BACKGROUND_SCRIM_ALPHA));
    if (value) body.style.background = value;
    else body.style.removeProperty('background');
    return () => { body.style.removeProperty('background'); };
  }, [url, pageBackground]);

  return null;
}
