import { navigationGroups, navigationParents } from '@/config/navigationGroups';

/**
 * #1070 §1 — what a feature flag is **called** on the Feature Flags page.
 *
 * The names are deliberately not this module's. The navigation already declares
 * a label for every section it gates, beside the `featureKey` it gates it by
 * (`config/navigationGroups.ts`), so a flag reads exactly what the sidebar reads
 * and a section renamed there lands here with it — which is why `nutrition`
 * answers *Nutrition & Goals* without this file naming it, #948 §1 having
 * renamed the group and left the key alone. The rename is display-only by
 * construction: nothing here writes a `feature_flags` row, and the page keeps
 * printing the key itself beside the label.
 *
 * A key the navigation does not gate keeps the short key the page showed before
 * — the `member_web.*` flags, which gate the Members App rather than this one,
 * and any root with no group — because inventing copy for it would be a second
 * place deciding a section's name.
 *
 * The **first** declaration of a key wins: two navigation items may share one
 * key (Personal Goals and Assigned Personal Goals both gate on
 * `nutrition.personal_goals`), and a flag is one row, so it takes the name of
 * the section the sidebar lists first rather than a joined pair.
 */
const LABEL_KEYS: Map<string, string> = (() => {
  const map = new Map<string, string>();
  // #1819: a parent that names a flag (Organization → `organization`) labels it
  // before the group it gates (General), so the flag keeps the name of the
  // entry the sidebar lists it under rather than its first category.
  for (const parent of navigationParents) {
    if (parent.featureKey && !map.has(parent.featureKey)) map.set(parent.featureKey, parent.labelKey);
  }
  for (const group of navigationGroups) {
    if (group.featureKey && !map.has(group.featureKey)) map.set(group.featureKey, group.labelKey);
    for (const item of group.items) {
      if (item.featureKey && !map.has(item.featureKey)) map.set(item.featureKey, item.labelKey);
    }
  }
  return map;
})();

/** The locale key a feature flag's display name resolves through, or `null`. */
export function featureFlagLabelKey(featureKey: string): string | null {
  return LABEL_KEYS.get(featureKey) ?? null;
}

/** The last segment of a dot-separated feature key — the page's own fallback. */
export function featureKeyShortName(featureKey: string): string {
  const parts = featureKey.split('.');
  return parts[parts.length - 1];
}

/**
 * #1819 — where a root flag sits in the sidebar's hierarchy, so the Feature
 * Flags page lists the roots in navigation order and names the parent entry
 * (Organization) that holds them. Flag identifiers and their values are
 * untouched: this is ordering and a heading, never a stored grouping.
 *
 * A root the navigation does not gate (the `member_web.*` flags, anything new)
 * has no position and sorts after the navigation's, alphabetically — the order
 * the page used before the hierarchy.
 */
export function featureFlagNavPosition(root: string): { order: number; parentLabelKey: string | null } {
  const parentLabel = new Map(navigationParents.map((p) => [p.id, p.labelKey]));
  const index = navigationGroups.findIndex((g) => g.featureKey === root);
  if (index < 0) return { order: Number.MAX_SAFE_INTEGER, parentLabelKey: null };
  const parentId = navigationGroups[index].parentId;
  return { order: index, parentLabelKey: parentId ? parentLabel.get(parentId) ?? null : null };
}

/**
 * #2155 — the position of a flag among its siblings: the order the sidebar
 * lists the item that gates it. The first item declaring a key wins (as in
 * `featureFlagLabelKey`), so two items sharing one flag yield one position.
 * A key no item gates has no position and sorts after the gated ones,
 * alphabetically. Ordering only — nothing is renamed, re-keyed or moved
 * between parents.
 */
const ITEM_ORDER: Map<string, number> = (() => {
  const map = new Map<string, number>();
  let index = 0;
  for (const group of navigationGroups) {
    for (const item of group.items) {
      if (item.featureKey && !map.has(item.featureKey)) map.set(item.featureKey, index);
      index += 1;
    }
  }
  return map;
})();

export function featureFlagItemOrder(featureKey: string): number {
  return ITEM_ORDER.get(featureKey) ?? Number.MAX_SAFE_INTEGER;
}

/** Comparator for sibling flags: sidebar order first, then the key. */
export function compareFeatureFlagSiblings(a: string, b: string): number {
  return featureFlagItemOrder(a) - featureFlagItemOrder(b) || a.localeCompare(b);
}
