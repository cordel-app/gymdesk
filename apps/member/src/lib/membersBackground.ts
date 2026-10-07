// #725: which Members App background belongs to the page being shown.
//
// Pure, and deliberately thin: the Members App consumes *resolved URLs only*.
// It knows nothing about gym storage paths, theme ids, R2 object keys, uploads,
// removals or folder initialization, and it implements no fallback to another
// theme or asset source — a slot that is `null` means the theme background
// colour, and that is the end of the rule.

/**
 * The slots the API sends, one per Members section. Mirrors
 * `MEMBER_IMAGE_SLOTS` on the API side; `personal_goals` is #1038's seventh,
 * for the My Goals section, and `next_bookings` #1158's eighth, for the
 * dashboard's My Next Bookings card — a card and not a page, so it is painted
 * by `MembersSectionCard` alone and deliberately absent from `SECTION_SLOTS`
 * below, as `calendar` is.
 */
export const MEMBER_BACKGROUND_SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'next_bookings', 'membership', 'personal_goals', 'background'] as const;

export type MemberBackgroundSlot = (typeof MEMBER_BACKGROUND_SLOTS)[number];

/** `theme.members_images` — one nullable URL per slot, always all of them. */
export type MembersImages = Partial<Record<`${MemberBackgroundSlot}_url`, string | null>>;

/**
 * Path → slot. The first segment after the locale decides; everything the table
 * does not name (home, profile, notifications, packages, payment…) takes the
 * general `background` slot, which is what "General Members background" is for.
 *
 * `calendar` is deliberately **absent** (#984): the Calendar tile's artwork is
 * the dashboard tile's alone, and the Calendar page falls through to the
 * general `background` slot like any other unnamed route. A 512×512 tile image
 * stretched to `cover` behind a dense time grid is not a page background — it
 * reads as the tile leaking onto the page — and the Calendar's own theme
 * settings (header, buttons, time column, modal) stay what paint that screen.
 * So changing the tile image cannot move the page, and changing the general
 * Members App background moves it along with every other page. The slot itself
 * stays one of the six: `MembersSectionCard` still paints the tile with it.
 */
const SECTION_SLOTS: Record<string, MemberBackgroundSlot> = {
  training: 'training',
  nutrition: 'nutrition',
  // "My Bookings" is the member app's `/schedule` route.
  schedule: 'bookings',
  membership: 'membership',
  // "My Goals" is the member app's `/goals` route (#1036), and #1038's seventh
  // slot is what it paints with: the page exists now, so it is named here
  // rather than read by the page itself — one map, as `calendar`'s deliberate
  // absence (#984) is also decided here and nowhere else.
  goals: 'personal_goals',
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
  return composeBackground(url, scrim, 'fixed');
}

/**
 * The same shorthand for a card or section surface (#728): `scroll` rather than
 * `fixed`, so the artwork belongs to the card and travels with it instead of
 * being anchored to the viewport — a `fixed` image would show a different crop
 * in every card and slide under them as the page scrolls.
 *
 * It takes **no scrim** (#982): a Section Card's artwork is the tile's primary
 * visual, so it is painted at full opacity and the uploaded image's own
 * colours, contrast and background are what the member sees — a black
 * photograph reads black rather than washed out to grey. The `#728` card scrim
 * that laid the theme's card colour over it at 0.82 is gone, and no overlay,
 * fade or theme blend may be reintroduced here. The page background keeps its
 * own scrim, which is a different surface with a different job: it sits under
 * every page's text and controls at once (`backgroundStyleValue` above), while
 * a card carries one label the tile design already places.
 *
 * Null for an unconfigured slot, exactly as above: the card keeps the plain
 * background it has today, which is what makes the default icon the fallback
 * rather than a second asset.
 */
export function cardBackgroundStyleValue(url: string | null): string | null {
  return composeBackground(url, null, 'scroll');
}

function composeBackground(url: string | null, scrim: string | null, attachment: 'fixed' | 'scroll'): string | null {
  if (!url) return null;
  const image = `url(${JSON.stringify(url)}) center center / cover no-repeat ${attachment}`;
  return scrim ? `linear-gradient(${scrim}, ${scrim}), ${image}` : image;
}
