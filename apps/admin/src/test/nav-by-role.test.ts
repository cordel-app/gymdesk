// #611: a role sees a module's menu group exactly when the matrix gives it any admin-route
// access (anything but NONE / R_OWN) — read-only roles included. Flags all on.

import { describe, expect, it } from 'vitest';
import { navigationGroups, filterNavGroups } from '@/config/navigationGroups';
import { canAccessModule, AppRole } from '@/config/permissions';

const ROLES: AppRole[] = ['admin', 'trainer_performance', 'trainer_perf_nutrition', 'front_desk', 'accountant', 'nutritionist'];
const moduleGroups = navigationGroups.filter((g) => g.module && g.requiredRole !== 'superadmin');

describe('menu groups follow the permission matrix', () => {
  for (const role of ROLES) {
    it(role, () => {
      const visible = new Set(filterNavGroups(navigationGroups, role, {}).map((g) => g.labelKey));
      for (const g of moduleGroups) {
        expect(visible.has(g.labelKey), `${role} → ${g.labelKey}`).toBe(canAccessModule(role, g.module!));
      }
    });
  }

  it('read-only roles now see the modules they can read (#611)', () => {
    const groups = (role: AppRole) => filterNavGroups(navigationGroups, role, {}).map((g) => g.labelKey);
    expect(groups('trainer_performance')).toContain('nav.groups.organization');
    expect(groups('nutritionist')).toEqual(expect.arrayContaining(['nav.groups.organization', 'nav.groups.training']));
    expect(groups('front_desk')).toContain('nav.groups.financials');
    expect(groups('accountant')).not.toContain('nav.groups.membership');
  });
});
