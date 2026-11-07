import { describe, expect, it } from 'vitest';
import { draftExpiresInSeconds } from '../domain/productSet';

describe('draftExpiresInSeconds (#2477)', () => {
  it('is null for a non-Draft and clamps an expired one to 0', () => {
    expect(draftExpiresInSeconds(null)).toBeNull();
    expect(draftExpiresInSeconds(-30)).toBe(0);
    expect(draftExpiresInSeconds('5400')).toBe(5400);
  });
});
