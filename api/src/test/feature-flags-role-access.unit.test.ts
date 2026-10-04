import { describe, expect, it } from 'vitest';
import { FEATURE_ROOT_MODULE, roleAccessOf } from '../api/platform-feature-flags';
import { PERMISSION_MATRIX } from '../infra/permissions';

describe('feature flag role access (#1059)', () => {
  it('collapses permission levels to -, R and RW', () => {
    expect(roleAccessOf('RW')).toBe('RW');
    expect(roleAccessOf('RW_ASSIGNED')).toBe('RW');
    expect(roleAccessOf('R')).toBe('R');
    expect(roleAccessOf('R_ASSIGNED')).toBe('R');
    expect(roleAccessOf('R_OWN')).toBe('R');
    expect(roleAccessOf('NONE')).toBe('-');
  });

  it('maps every root onto a real module', () => {
    for (const mod of Object.values(FEATURE_ROOT_MODULE)) expect(PERMISSION_MATRIX[mod]).toBeDefined();
  });
});
