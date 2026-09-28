/**
 * #884: the names of the sidebar's first-level icon set.
 *
 * Kept in its own module, free of JSX, so `config/navigationGroups.ts` can name
 * an icon without importing a component: the nav config stays a pure data module
 * that `filterNavGroups`' tests can read, and the drawing lives in `NavIcons.tsx`.
 *
 * A new name goes in **two** places — this list and the `NAV_ICONS` registry
 * beside the components. `nav-icons.test.ts` fails if the two disagree.
 */
export const NAV_ICON_NAMES = [
  'users',
  'calendar',
  'building',
  'dumbbell',
  'apple',
  'creditCard',
  'banknote',
  'sliders',
  'shield',
] as const;

export type NavIconName = (typeof NAV_ICON_NAMES)[number];

/**
 * The size every first-level nav icon renders at. It matches the expand/collapse
 * chevron's 16px box beside it, and stays below the 14px label's visual weight.
 */
export const NAV_ICON_SIZE = 16;

/** One stroke width for the whole set — the icons are line drawings, never filled. */
export const NAV_ICON_STROKE = 1.75;
