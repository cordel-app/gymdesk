'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { DEFAULT_TOKENS, type ThemeTokens } from '@/lib/themeTokens';
import { memberTheme } from '@/lib/memberChrome';
import { MEMBERS_APP_SETTINGS, membersAppVarValue } from '@/lib/membersAppTokens';
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
 * When the slot is not configured the body's background is set back to
 * `var(--gd-app-bg)`, the theme background colour — the only fallback #725
 * allows. It is written rather than removed (#1153): the layout's own inline
 * `background` is what paints the Members App colour, and removing the
 * property deleted it, leaving the body unpainted. Nothing is fetched for a
 * `null` slot: there is no URL to fetch.
 */
export function MembersBackground() {
  const { theme } = useApp();
  const pathname = usePathname();
  const images = theme?.members_images ?? null;
  const url = backgroundUrlForSlot(images, slotForPathname(pathname));
  // #983 §2/§6 — the scrim is the *Members App*'s background colour, which is
  // its own setting and only follows the Admin page background while the Theme
  // leaves it inherited. Reading `colors.pageBackground` directly (as this did
  // until #983) tinted the artwork with the Admin colour on every Theme that
  // overrides the Members one, so a gym that configured a dark members
  // background still got a light scrim over its photograph.
  const pageBackground = membersAppBackgroundColor((theme?.tokens ?? null) as ThemeTokens | null);

  useEffect(() => {
    const { body } = document;
    if (!body) return;
    const value = backgroundStyleValue(url, hexToRgba(pageBackground, BACKGROUND_SCRIM_ALPHA));
    if (value) body.style.background = value;
    else body.style.background = memberTheme.pageBackground;
    return () => { body.style.background = memberTheme.pageBackground; };
  }, [url, pageBackground]);

  return null;
}

const BACKGROUND_SETTING = MEMBERS_APP_SETTINGS.find((s) => s.key === 'backgroundColor')!;

function membersAppBackgroundColor(tokens: ThemeTokens | null): string {
  if (!tokens?.colors) return DEFAULT_TOKENS.colors.pageBackground;
  return membersAppVarValue(tokens, BACKGROUND_SETTING);
}
