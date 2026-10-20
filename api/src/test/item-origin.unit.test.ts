import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originOf, toItemOrigin } from '../domain/itemOrigin';

describe('item origin (#1883)', () => {
  it('is decided by the entry point, not a role', () => {
    expect(originOf(true)).toBe('admin');
    expect(originOf(false)).toBe('members_app');
  });

  it('reads anything unrecognised as Unknown instead of guessing', () => {
    expect(toItemOrigin(null)).toBeNull();
    expect(toItemOrigin(undefined)).toBeNull();
    expect(toItemOrigin('staff')).toBeNull();
    expect(toItemOrigin('admin')).toBe('admin');
    expect(toItemOrigin('members_app')).toBe('members_app');
  });

  it('is copied when a version is cloned', () => {
    const src = readFileSync(join(__dirname, '../api/product-set-bridge.ts'), 'utf8');
    expect(src).toMatch(/recurring_billing_unit, origin\)/);
    expect(src).toMatch(/line_ref, origin\)/);
  });
});
