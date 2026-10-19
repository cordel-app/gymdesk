import type { NavGroup, NavParent } from '@/config/navigationGroups';
import { navGroupContainsActivePath } from '@/lib/sidebarCollapse';

/**
 * #1819 — how the flat, already permission- and flag-filtered group list becomes
 * the sidebar's first level.
 *
 * JSX-free, like `sidebarCollapse.ts`. Nesting is **presentation only**:
 * `filterNavGroups()` has already decided which groups this role may see with
 * their own `module` and `featureKey`, and this module only arranges what is
 * left. A parent therefore appears exactly when one of its children does, and
 * it grants nothing — hiding a link is never an authorization mechanism.
 */

export type NavEntry =
  | { kind: 'group'; group: NavGroup }
  | { kind: 'parent'; parent: NavParent; children: NavGroup[] };

/**
 * Groups without a `parentId` stay first-level entries in their declared order;
 * each parent is placed where its first visible child was, holding its children
 * in their declared order. A `parentId` naming no known parent is left as a
 * first-level group rather than silently dropped.
 */
export function buildNavEntries(groups: NavGroup[], parents: NavParent[]): NavEntry[] {
  const known = new Map(parents.map((p) => [p.id, p]));
  const entries: NavEntry[] = [];
  const placed = new Map<string, Extract<NavEntry, { kind: 'parent' }>>();

  for (const group of groups) {
    const parent = group.parentId ? known.get(group.parentId) : undefined;
    if (!parent) {
      entries.push({ kind: 'group', group });
      continue;
    }
    let entry = placed.get(parent.id);
    if (!entry) {
      entry = { kind: 'parent', parent, children: [] };
      placed.set(parent.id, entry);
      entries.push(entry);
    }
    entry.children.push(group);
  }
  return entries;
}

/** The key a parent's expanded state is stored under, apart from the groups'. */
export function parentExpandedKey(parentId: string): string {
  return `parent:${parentId}`;
}

/** Is the open page inside any of the parent's groups? Items are locale-resolved. */
export function parentContainsActivePath(
  children: Pick<NavGroup, 'items'>[],
  pathname: string,
): boolean {
  return children.some((child) => navGroupContainsActivePath(child, pathname));
}

/**
 * The expanded-state keys that must be open for `pathname` to be visible: the
 * group holding the page and, when that group is nested, its parent. The
 * sidebar only ever *adds* these, so a category the user opened stays open
 * while they navigate within it.
 */
export function expandedKeysForPath(
  groups: Pick<NavGroup, 'id' | 'items' | 'parentId'>[],
  pathname: string,
): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    if (!navGroupContainsActivePath(group, pathname)) continue;
    keys.push(group.id);
    if (group.parentId) keys.push(parentExpandedKey(group.parentId));
  }
  return keys;
}
