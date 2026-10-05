// #1070 — the feature-level permission override.
//
// The module matrix (#156) answers per *section*, which is coarse on purpose. An
// override is the exception, declared per **feature key**, and this file is the
// gate on the two things that make it safe: that it is read as an exception
// (exact key, replacing the module's level in both directions) and that the two
// copies of the declaration agree.
//
// The second half is #611's lesson: the admin app's matrix drives menus and page
// controls while the API's enforces access, so a declaration that reached only
// one of them shows a write control the API rejects — or hides one it allows,
// which is exactly the defect #1070 reports on the Personal Trainer and Personal
// Goals. The admin mirror is imported from here rather than asserted as text so
// drift cannot hide behind formatting, and this gate lives in the API suite
// because CI runs `npm test` in `api/` only.

import { describe, expect, it } from 'vitest';
import {
  FEATURE_PERMISSION_OVERRIDES,
  PERMISSION_MATRIX,
  canAccessFeature,
  canWriteFeature,
  canWrite,
  featurePermissionOverride,
  getFeaturePermission,
} from '../infra/permissions';
import { FEATURE_ROOT_MODULE } from '../api/platform-feature-flags';
import {
  FEATURE_PERMISSION_OVERRIDES as ADMIN_OVERRIDES,
  canWriteFeature as adminCanWriteFeature,
} from '../../../apps/admin/src/config/permissions';

const PERSONAL_GOALS = 'nutrition.personal_goals';

describe('resolution', () => {
  it('takes the override when one is declared for the exact key', () => {
    expect(getFeaturePermission('trainer_performance', 'NUTRITION', PERSONAL_GOALS)).toBe('RW');
  });

  it('inherits the module level for a key with no override', () => {
    expect(getFeaturePermission('trainer_performance', 'NUTRITION', 'nutrition.nutrition_library'))
      .toBe(PERMISSION_MATRIX.NUTRITION.trainer_performance);
    expect(getFeaturePermission('trainer_performance', 'NUTRITION'))
      .toBe(PERMISSION_MATRIX.NUTRITION.trainer_performance);
  });

  it('never matches an ancestor of an overridden key', () => {
    // Granting one feature says nothing about the rest of its section — that
    // narrowness is the whole reason the override is declared per feature.
    expect(featurePermissionOverride('nutrition', 'trainer_performance')).toBeNull();
    expect(getFeaturePermission('trainer_performance', 'NUTRITION', 'nutrition')).toBe('R_ASSIGNED');
  });

  it('leaves every other role on the module level', () => {
    for (const role of Object.keys(PERMISSION_MATRIX.NUTRITION) as (keyof typeof PERMISSION_MATRIX.NUTRITION)[]) {
      if (role === 'trainer_performance') continue;
      expect(getFeaturePermission(role, 'NUTRITION', PERSONAL_GOALS), role)
        .toBe(PERMISSION_MATRIX.NUTRITION[role]);
    }
  });
});

describe('the Personal Trainer override (#1070 §2)', () => {
  it('is an override and not a copy of what NUTRITION already gave', () => {
    expect(PERMISSION_MATRIX.NUTRITION.trainer_performance).toBe('R_ASSIGNED');
    expect(canWrite('trainer_performance', 'NUTRITION')).toBe(false);
    expect(canWriteFeature('trainer_performance', 'NUTRITION', PERSONAL_GOALS)).toBe(true);
    expect(canAccessFeature('trainer_performance', 'NUTRITION', PERSONAL_GOALS)).toBe(true);
  });

  it('does not reach the rest of Nutrition', () => {
    expect(canWriteFeature('trainer_performance', 'NUTRITION', 'nutrition.nutrition_library')).toBe(false);
    expect(canWriteFeature('trainer_performance', 'NUTRITION', 'nutrition.nutrition_plans')).toBe(false);
  });

  it('changes no other role on Personal Goals', () => {
    expect(canWriteFeature('front_desk', 'NUTRITION', PERSONAL_GOALS)).toBe(false);
    expect(canWriteFeature('accountant', 'NUTRITION', PERSONAL_GOALS)).toBe(false);
    expect(canAccessFeature('accountant', 'NUTRITION', PERSONAL_GOALS)).toBe(false);
    expect(canWriteFeature('admin', 'NUTRITION', PERSONAL_GOALS)).toBe(true);
    expect(canWriteFeature('nutritionist', 'NUTRITION', PERSONAL_GOALS)).toBe(true);
  });
});

describe('every override is reportable (#1070 §3)', () => {
  it('declares a dotted key whose root is a module the page already shows', () => {
    // The Feature Flags page draws an override beside the level its section
    // inherits, so a key whose root has no module would have nothing to be an
    // exception to — and a root key would be a section-wide change, which is
    // what the module matrix is for.
    for (const key of Object.keys(FEATURE_PERMISSION_OVERRIDES)) {
      expect(key, key).toContain('.');
      expect(FEATURE_ROOT_MODULE[key.split('.')[0]], key).toBeDefined();
    }
  });

  it('declares at least one role per key, and differs from what that module gives', () => {
    for (const [key, byRole] of Object.entries(FEATURE_PERMISSION_OVERRIDES)) {
      const mod = FEATURE_ROOT_MODULE[key.split('.')[0]];
      const roles = Object.entries(byRole) as [keyof typeof PERMISSION_MATRIX.NUTRITION, string][];
      expect(roles.length, key).toBeGreaterThan(0);
      for (const [role, level] of roles) {
        // An override equal to the inherited level is noise the page would still
        // mark in red, so it belongs in the matrix instead.
        expect(level, `${key} × ${role}`).not.toBe(PERMISSION_MATRIX[mod][role]);
      }
    }
  });
});

describe('the admin app mirrors the declaration', () => {
  it('declares the same keys, roles and levels', () => {
    expect(ADMIN_OVERRIDES).toEqual(FEATURE_PERMISSION_OVERRIDES);
  });

  it('resolves the same answer for a page control as the API does for the route', () => {
    expect(adminCanWriteFeature('trainer_performance', 'NUTRITION', PERSONAL_GOALS))
      .toBe(canWriteFeature('trainer_performance', 'NUTRITION', PERSONAL_GOALS));
    expect(adminCanWriteFeature('front_desk', 'NUTRITION', PERSONAL_GOALS))
      .toBe(canWriteFeature('front_desk', 'NUTRITION', PERSONAL_GOALS));
  });
});
