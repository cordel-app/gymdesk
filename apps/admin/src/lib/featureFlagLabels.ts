import { navigationGroups } from '@/config/navigationGroups';

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
