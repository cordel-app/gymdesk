import { describe, expect, it } from 'vitest';
import { navigationGroups, navigationParents, filterNavGroups } from '@/config/navigationGroups';
import { buildNavEntries, expandedKeysForPath, parentContainsActivePath, parentExpandedKey } from '@/lib/navTree';
import { featureFlagLabelKey, featureFlagNavPosition } from '@/lib/featureFlagLabels';
import { canAccessModule, AppRole } from '@/config/permissions';

// #1819 — the sidebar groups the administrative modules under Organization.
// Nesting is presentation only: each category keeps its own module and feature
// key, so permissions and flags are decided exactly as before.

const ORG_CATEGORIES = ['general', 'training', 'nutrition', 'payments', 'financials', 'system'];
const ROLES: AppRole[] = ['admin', 'trainer_performance', 'trainer_perf_nutrition', 'front_desk', 'accountant', 'nutritionist'];

describe('the Organization hierarchy', () => {
  it('keeps Home, Members and Calendar outside Organization', () => {
    for (const id of ['home', 'membership', 'calendar']) {
      expect(navigationGroups.find((g) => g.id === id)!.parentId, id).toBeUndefined();
    }
  });

  it('lists the six categories under Organization, in order', () => {
    const children = navigationGroups.filter((g) => g.parentId === 'organization').map((g) => g.id);
    expect(children).toEqual(ORG_CATEGORIES);
  });

  it('keeps Settings last, set apart by a hairline', () => {
    const children = navigationGroups.filter((g) => g.parentId === 'organization');
    expect(children[children.length - 1].id).toBe('system');
    expect(children.filter((g) => g.nestedSeparatorAbove).map((g) => g.id)).toEqual(['system']);
  });

  it('places the Organization entry where its first category was', () => {
    const entries = buildNavEntries(filterNavGroups(navigationGroups, 'superadmin', {}), navigationParents);
    const shape = entries.map((e) => (e.kind === 'parent' ? `parent:${e.parent.id}` : e.group.id));
    expect(shape).toEqual(['home', 'membership', 'calendar', 'parent:organization', 'cordel']);
  });

  it('does not change a category\'s module or feature key', () => {
    const byId = (id: string) => navigationGroups.find((g) => g.id === id)!;
    expect(byId('general')).toMatchObject({ module: 'ORGANIZATION', featureKey: 'organization' });
    expect(byId('training')).toMatchObject({ module: 'TRAINING', featureKey: 'training' });
    expect(byId('nutrition')).toMatchObject({ module: 'NUTRITION', featureKey: 'nutrition' });
    expect(byId('payments')).toMatchObject({ module: 'PAYMENTS', featureKey: 'payments' });
    expect(byId('financials')).toMatchObject({ module: 'FINANCIALS', featureKey: 'financials' });
    expect(byId('system')).toMatchObject({ module: 'SYSTEM', featureKey: 'system' });
  });

  it('keeps every page route reachable exactly once', () => {
    const hrefs = navigationGroups.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('permissions and flags still decide visibility', () => {
  for (const role of ROLES) {
    it(`${role}: a category shows exactly when its module is readable`, () => {
      const visible = new Set(filterNavGroups(navigationGroups, role, {}).map((g) => g.id));
      for (const g of navigationGroups.filter((x) => x.parentId)) {
        expect(visible.has(g.id), `${role} → ${g.id}`).toBe(canAccessModule(role, g.module!));
      }
    });
  }

  it('a disabled flag hides its category and only that category', () => {
    const groups = filterNavGroups(navigationGroups, 'admin', { training: false });
    const ids = groups.map((g) => g.id);
    expect(ids).not.toContain('training');
    for (const id of ['general', 'nutrition', 'payments', 'financials', 'system']) expect(ids).toContain(id);
  });

  it('shows no Organization entry when no category is visible', () => {
    const flags = Object.fromEntries(ORG_CATEGORIES.map((id) => [navigationGroups.find((g) => g.id === id)!.featureKey!, false]));
    const entries = buildNavEntries(filterNavGroups(navigationGroups, 'admin', flags), navigationParents);
    expect(entries.some((e) => e.kind === 'parent')).toBe(false);
  });

  it('an unknown parent id leaves the group first-level instead of dropping it', () => {
    const entries = buildNavEntries([{ ...navigationGroups[1], parentId: 'nope' }], navigationParents);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('group');
  });
});

describe('active route expansion', () => {
  const resolved = navigationGroups.map((g) => ({
    id: g.id,
    parentId: g.parentId,
    items: g.items.map((i) => ({ ...i, href: i.href.replace('{{locale}}', 'en') })),
  }));

  it('opens Organization and the category holding the page', () => {
    expect(expandedKeysForPath(resolved, '/en/exercises')).toEqual(['training', parentExpandedKey('organization')]);
    expect(expandedKeysForPath(resolved, '/en/themes')).toEqual(['system', parentExpandedKey('organization')]);
  });

  it('opens nothing for a page outside Organization', () => {
    expect(expandedKeysForPath(resolved, '/en/members')).toEqual(['membership']);
    expect(expandedKeysForPath(resolved, '/en/home')).toEqual(['home']);
  });

  it('reports the active page for the collapsed Organization icon', () => {
    const org = resolved.filter((g) => g.parentId === 'organization');
    expect(parentContainsActivePath(org, '/en/staff')).toBe(true);
    expect(parentContainsActivePath(org, '/en/members')).toBe(false);
  });
});

describe('the Feature Flags page follows the hierarchy', () => {
  it('keeps every flag identifier and labels `organization` as Organization', () => {
    expect(featureFlagLabelKey('organization')).toBe('nav.groups.organization');
    expect(featureFlagLabelKey('organization.staff')).toBe('nav.staff');
    expect(featureFlagLabelKey('payments')).toBe('nav.groups.payments');
  });

  it('orders roots by the sidebar and names the parent of the nested ones', () => {
    expect(featureFlagNavPosition('membership').parentLabelKey).toBeNull();
    expect(featureFlagNavPosition('training').parentLabelKey).toBe('nav.groups.organization');
    expect(featureFlagNavPosition('membership').order).toBeLessThan(featureFlagNavPosition('training').order);
    expect(featureFlagNavPosition('training').order).toBeLessThan(featureFlagNavPosition('system').order);
    expect(featureFlagNavPosition('member_web').parentLabelKey).toBeNull();
  });
});
