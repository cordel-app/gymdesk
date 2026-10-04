import type { CSSProperties } from 'react';

// #1020 — the sidebar's dividers, in one place.
//
// Two of them exist, and the whole point of the ticket is the relationship
// between them: the hairline that groups items *inside* a section (the
// `separatorAbove` flag on a NavItem) against the heavier rule above a
// first-level **section**, which has to read as "slightly thicker than the
// standard sidebar separator". Spelling both widths here is what makes that a
// relationship in code rather than two unrelated literals in the JSX, so a
// later change to one cannot silently make them equal.
//
// Both draw in the white alpha the rest of the sidebar's chrome already uses:
// a divider is not a place to introduce a colour of its own, and the sidebar
// has no separator token for a Theme to move (`--gd-sidebar-*` is the
// background, the text and the selected/hover pair — #1003's own set).

/** The one colour both rules draw in, over the sidebar's own background. */
export const NAV_SEPARATOR_COLOR = 'rgba(255,255,255,0.15)';

/** The hairline between item groups inside a section. */
export const NAV_ITEM_SEPARATOR_WIDTH = 1;

/** The rule above a first-level section — deliberately the thicker of the two. */
export const NAV_GROUP_SEPARATOR_WIDTH = 2;

/** `NavItem.separatorAbove`'s line: unchanged, now read from here. */
export const navItemSeparatorStyle: CSSProperties = {
  borderTop: `${NAV_ITEM_SEPARATOR_WIDTH}px solid ${NAV_SEPARATOR_COLOR}`,
  margin: '6px 16px',
};

/**
 * `NavGroup.separatorAbove`'s line.
 *
 * The inset is the only thing the collapsed sidebar changes: the strip is 64px
 * wide (#1003), where the expanded list's 16px inset would leave a stub of a
 * line. The 12px top margin sits on top of the group header's own 8px, so the
 * line has room above it and the section it introduces stays where it was.
 */
export function navGroupSeparatorStyle(collapsed: boolean): CSSProperties {
  return {
    borderTop: `${NAV_GROUP_SEPARATOR_WIDTH}px solid ${NAV_SEPARATOR_COLOR}`,
    margin: collapsed ? '12px 12px 0' : '12px 16px 0',
  };
}
