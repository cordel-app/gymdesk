// #611: the admin app's permission table drives menus and page controls; the API's
// enforces access. They disagreed from #156 onwards (menus hidden that the API allowed,
// write buttons shown that it rejected). Any drift now fails here.

import { describe, expect, it } from 'vitest';
import { PERMISSION_MATRIX as ADMIN } from '../config/permissions';
import { PERMISSION_MATRIX as API } from '../../../../api/src/infra/permissions';

describe('admin permission matrix mirrors the API', () => {
  it('has the same modules and roles', () => {
    expect(Object.keys(ADMIN).sort()).toEqual(Object.keys(API).sort());
    for (const module of Object.keys(API) as (keyof typeof API)[]) {
      expect(Object.keys(ADMIN[module]).sort(), module).toEqual(Object.keys(API[module]).sort());
    }
  });

  it('matches cell for cell', () => {
    const drift: string[] = [];
    for (const [module, roles] of Object.entries(API)) {
      for (const [role, level] of Object.entries(roles)) {
        const adminLevel = (ADMIN as any)[module][role];
        if (adminLevel !== level) drift.push(`${module} × ${role}: admin ${adminLevel} ≠ API ${level}`);
      }
    }
    expect(drift).toEqual([]);
  });
});
