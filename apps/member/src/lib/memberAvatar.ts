// #1219 — the Members App's profile avatar: initials plus a colour pair.
//
// Pure, no React and no `t()`. The colours are *roles* from `memberChrome.ts`
// (#983), never a literal, so a gym's Theme moves them; each pair's text role is
// the one the theme already pairs with that background (button/button text,
// or the surface colour on a title colour).
import { memberTheme } from './memberChrome';

export interface AvatarColors {
  background: string;
  color: string;
}

export const AVATAR_PALETTE: readonly AvatarColors[] = [
  { background: memberTheme.primaryButton, color: memberTheme.primaryButtonText },
  { background: memberTheme.title1, color: memberTheme.surface },
  { background: memberTheme.title3, color: memberTheme.surface },
  { background: memberTheme.statusInfo, color: memberTheme.surface },
  { background: memberTheme.statusSuccess, color: memberTheme.surface },
  { background: memberTheme.link, color: memberTheme.surface },
];

/**
 * First letter of the first and of the second name word ("Xavier Egea Vila" →
 * "XE"), so a compound surname never changes them. A single word gives one
 * letter; nothing usable gives an empty string.
 */
export function memberInitials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]?.toLocaleUpperCase() ?? '')
    .join('');
}

/** Deterministic palette entry for a member: same input, same pair. */
export function memberAvatarColors(seed: string | number | null | undefined): AvatarColors {
  const s = String(seed ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
