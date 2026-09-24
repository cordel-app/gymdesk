// #725: which Members App background belongs to the page being shown.
//
// Pure, and deliberately thin: the Members App consumes *resolved URLs only*.
// It knows nothing about gym storage paths, theme ids, R2 object keys, uploads,
// removals or folder initialization, and it implements no fallback to another
// theme or asset source — a slot that is `null` means the theme background
// colour, and that is the end of the rule.

/** The six slots the API sends, one per Members section. */
export const MEMBER_BACKGROUND_SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'membership', 'background'] as const;

export type MemberBackgroundSlot = (typeof MEMBER_BACKGROUND_SLOTS)[number];

/** `theme.members_images` — one nullable URL per slot, always all six. */
export type MembersImages = Partial<Record<`${MemberBackgroundSlot}_url`, string | null>>;

/**
 * Path → slot. The first segment after the locale decides; everything the table
 * does not name (home, profile, notifications, packages, payment…) takes the
 * general `background` slot, which is what "General Members background" is for.
 */
const SECTION_SLOTS: Record<string, MemberBackgroundSlot> = {
  training: 'training',
  nutrition: 'nutrition',
  calendar: 'calendar',
  // "My Bookings" is the member app's `/schedule` route.
  schedule: 'bookings',
  membership: 'membership',
};

export function slotForPathname(pathname: string | null | undefined): MemberBackgroundSlot {
  if (!pathname) return 'background';
  // `/en/training/…` → `training`; a locale-root path has no section segment.
  const section = pathname.split('/').filter(Boolean)[1];
  return (section && SECTION_SLOTS[section]) || 'background';
}

/** The URL configured for a slot, or null when the theme does not configure it. */
export function backgroundUrlForSlot(images: MembersImages | null | undefined, slot: MemberBackgroundSlot): string | null {
  return images?.[`${slot}_url`] ?? null;
}

/**
 * `#rgb`/`#rrggbb` → `rgba(r, g, b, alpha)`, or null for anything else.
 *
 * Used for the scrim below — the overlay treatment that keeps text and controls
 * readable over a photograph. It is the theme's *own* app background colour at
 * partial opacity rather than a fixed black or white, so a dark theme darkens
 * and a light theme lightens, and the page keeps the contrast it was designed
 * with. No colour is invented and no component is restyled.
 */
export function hexToRgba(hex: string | null | undefined, alpha: number): string | null {
  if (!hex) return null;
  const value = hex.trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** How much of the scrim sits over the artwork. */
export const BACKGROUND_SCRIM_ALPHA = 0.72;

/**
 * The CSS `background` shorthand for a page: the scrim over the artwork, sized
 * `cover` and centred so the image keeps its aspect ratio and is never
 * stretched, and `fixed` so scrolling a long page does not drag it.
 *
 * Null when the slot is not configured — the caller then leaves the element's
 * existing background (the theme colour) exactly as it was, which is the whole
 * of #725's resolution rule.
 */
export function backgroundStyleValue(url: string | null, scrim: string | null): string | null {
  if (!url) return null;
  const image = `url(${JSON.stringify(url)}) center center / cover no-repeat fixed`;
  return scrim ? `linear-gradient(${scrim}, ${scrim}), ${image}` : image;
}
