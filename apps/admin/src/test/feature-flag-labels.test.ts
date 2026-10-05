import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { featureFlagLabelKey, featureKeyShortName } from '@/lib/featureFlagLabels';
import { navigationGroups } from '@/config/navigationGroups';
import { FEATURE_PERMISSION_OVERRIDES } from '@/config/permissions';

// #1070 §1/§3 — the Feature Flags page says what the application says, and marks
// a permission override as the explicit decision it is.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure label resolution is asserted directly and the page's wiring by scanning
// the source, the way assigned-personal-goals.test.ts (#948) does.
//
// What it pins down is the ticket's decisions rather than the file's shape:
//   - a flag's display name is the navigation's own label, so §1's rename is a
//     consequence of #948 having renamed the group and not a second spelling;
//   - the key is untouched and still printed, so the rename is display-only;
//   - an override is read from the full feature key and is the only value drawn
//     in red, in the app's existing red rather than a hue of this page's.

const PAGE = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'cordel', 'feature-flags', 'page.tsx'),
  'utf8',
);
const LOCALES = ['en', 'es', 'ca'] as const;
const messages = Object.fromEntries(
  LOCALES.map(l => [l, JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf8'))]),
) as Record<(typeof LOCALES)[number], any>;

describe('a flag is named after the section it gates (#1070 §1)', () => {
  it('resolves the navigation label of a gated group', () => {
    expect(featureFlagLabelKey('nutrition')).toBe('nav.groups.nutrition');
    expect(messages.en.nav.groups.nutrition).toBe('Nutrition & Goals');
    // Every locale already says it — §1 renames nothing of its own.
    for (const l of LOCALES) expect(messages[l].nav.groups.nutrition, l).toBeTruthy();
  });

  it('resolves the navigation label of a gated item', () => {
    expect(featureFlagLabelKey('nutrition.personal_goals')).toBe('nav.personal_goals');
    expect(featureFlagLabelKey('nutrition.nutrition_library')).toBe('nav.nutrition_library');
  });

  it('takes the first declaration when two items share one key', () => {
    // Personal Goals and Assigned Personal Goals both gate on the same key, and a
    // flag is one row: it reads as the section the sidebar lists first.
    const sharing = navigationGroups
      .flatMap(g => g.items)
      .filter(i => i.featureKey === 'nutrition.personal_goals');
    expect(sharing.length).toBe(2);
    expect(featureFlagLabelKey('nutrition.personal_goals')).toBe(sharing[0].labelKey);
  });

  it('answers null for a key the navigation does not gate', () => {
    // The Members App's flags gate the other app, so they keep the short key the
    // page always showed rather than borrowing a name.
    expect(featureFlagLabelKey('member_web')).toBeNull();
    expect(featureFlagLabelKey('member_web.my_bookings')).toBeNull();
    expect(featureKeyShortName('member_web.my_bookings')).toBe('my_bookings');
    expect(featureKeyShortName('nutrition')).toBe('nutrition');
  });

  it('resolves a label for every feature key the navigation declares', () => {
    const keys = navigationGroups.flatMap(g => [g.featureKey, ...g.items.map(i => i.featureKey)]);
    for (const key of keys) {
      if (!key) continue;
      const labelKey = featureFlagLabelKey(key);
      expect(labelKey, key).toBeTruthy();
      const value = labelKey!.split('.').reduce((acc: any, part) => acc?.[part], messages.en);
      expect(typeof value, `${key} → ${labelKey}`).toBe('string');
    }
  });

  it('decides the label before calling t(), and keeps printing the key itself', () => {
    // next-intl has no `defaultValue`: a missing key prints verbatim, so the
    // fallback cannot be an option passed to `t()` (CLAUDE.md).
    expect(PAGE).toContain('const labelKey = featureFlagLabelKey(node.key);');
    expect(PAGE).toContain('const label = labelKey ? t(labelKey) : featureKeyShortName(node.key);');
    expect(PAGE).not.toMatch(/t\([^)]*defaultValue/);
    // Display-only: the page still shows the stored key beside the label, and
    // names no section itself.
    expect(PAGE).toContain('{node.key}');
    expect(PAGE).not.toMatch(/Nutrition & Goals/);
  });
});

describe('an overridden permission is marked as one (#1070 §3)', () => {
  it('reads the override from the full feature key, not the root', () => {
    expect(PAGE).toContain('const override = roleAccess.overrides?.[node.key]?.[r.role];');
    expect(PAGE).toContain("const level = override ?? roleAccess.access[node.key.split('.')[0]]?.[r.role];");
  });

  it('colours only that value, in the app existing red', () => {
    expect(PAGE).toContain("import { alertTextColor } from '@/components/formChrome';");
    expect(PAGE).toContain('color: override');
    expect(PAGE).toContain('? alertTextColor');
    // No hue of its own, and never a row-level background.
    expect(PAGE).not.toMatch(/#c0392b/);
    expect(PAGE).not.toMatch(/background:\s*'?(red|#f8[0-9a-f]{4})/i);
  });

  it('says in words what the red says in colour', () => {
    expect(PAGE).toContain("t('feature_flags.override_legend')");
    expect(PAGE).toContain("t('feature_flags.override_hint', { role: r.label, level: override })");
    for (const l of LOCALES) {
      expect(messages[l].feature_flags.override_legend, l).toBeTruthy();
      expect(messages[l].feature_flags.override_hint, l).toContain('{role}');
      expect(messages[l].feature_flags.override_hint, l).toContain('{level}');
    }
  });

  it('is declared for the Personal Trainer on Personal Goals and nothing else', () => {
    expect(FEATURE_PERMISSION_OVERRIDES).toEqual({
      'nutrition.personal_goals': { trainer_performance: 'RW' },
    });
  });
});
