import type { NavGroup, NavItem } from '@/config/navigationGroups';

/**
 * #1003 — the one place the desktop sidebar's collapsed state is decided.
 *
 * JSX-free, like `exerciseFilters.ts` or `centerAssignments.ts`, so the two
 * widths, the breakpoint, the stored preference and — the load-bearing part —
 * the rule for *which group contains the page you are on* are declared once and
 * read by both modes. That last one is what the ticket's §2 turns on: in
 * expanded mode the active **subsection** is highlighted, and in collapsed mode
 * the only thing left to highlight is its parent section's icon. If the two
 * modes asked that question separately they could disagree, and a gym owner
 * collapsing the sidebar would see the highlight jump to another section.
 *
 * A collapsed section is **not** an active navigation item of its own (§2): it
 * carries the active treatment because of what is open inside it, and clicking
 * it navigates nowhere — it expands the sidebar again and opens the group.
 */

/** The sidebar's width with labels — unchanged from before #1003. */
export const SIDEBAR_EXPANDED_WIDTH = 220;

/**
 * Icons only. Wide enough for the 16px icon in its own 10px-padded button plus
 * the 3px active rail the expanded mode already draws, so an icon sits in the
 * same place whichever mode it is in.
 */
export const SIDEBAR_COLLAPSED_WIDTH = 64;

/**
 * Mirrors `AppShell`'s own desktop breakpoint (its CSS splits at 768/769px).
 * Collapsing is a desktop affordance (§5): on mobile the panel is the drawer,
 * which is either open at its full width or off-screen, so the preference is
 * ignored there rather than shrinking the drawer to a strip of icons.
 */
export const SIDEBAR_DESKTOP_MEDIA_QUERY = '(min-width: 769px)';

/**
 * Persisted per browser, not per tab: a collapsed sidebar is a lasting layout
 * preference, unlike which groups happen to be open (`navGroupsExpanded`, which
 * stays in `sessionStorage`). §3 keeps the two independent — collapsing never
 * writes the group state, and expanding restores exactly what was open.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sidebarCollapsed';

export function sidebarWidth(collapsed: boolean): number {
  return collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;
}

/** `false` whenever the preference cannot be read — a private window, blocked site data, SSR. */
export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // A preference that cannot be stored is not a reason to fail the render.
  }
}

/** Does this item, or anything nested under it, address the current path? */
function itemContainsPath(item: NavItem, pathname: string): boolean {
  if (item.href === pathname) return true;
  return (item.children ?? []).some((child) => itemContainsPath(child, pathname));
}

/**
 * The one answer to "is the open page inside this group?", used by the
 * auto-expand effect, the expanded group header and the collapsed icon alike.
 * `group.items` are expected locale-resolved, as the sidebar resolves them.
 */
export function navGroupContainsActivePath(
  group: Pick<NavGroup, 'items'>,
  pathname: string,
): boolean {
  return group.items.some((item) => itemContainsPath(item, pathname));
}
