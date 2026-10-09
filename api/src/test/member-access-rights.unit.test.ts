import { describe, it, expect } from 'vitest';
import { deriveAccessRights, isStoredAccessRights } from '../domain/memberAccessRights';

describe('deriveAccessRights (#1238)', () => {
  it('is granted with no payment problem', () => {
    expect(deriveAccessRights('granted', null)).toBe('granted');
    expect(deriveAccessRights('granted', 'completed')).toBe('granted');
    expect(deriveAccessRights('granted', 'pending')).toBe('granted');
  });
  it('moves to to_be_reviewed on a failed or expired payment, and back by itself', () => {
    expect(deriveAccessRights('granted', 'failed')).toBe('to_be_reviewed');
    expect(deriveAccessRights('granted', 'expired')).toBe('to_be_reviewed');
    expect(deriveAccessRights('granted', 'completed')).toBe('granted');
  });
  it('never lets a payment change a revoked Member', () => {
    expect(deriveAccessRights('revoked', 'completed')).toBe('revoked');
    expect(deriveAccessRights('revoked', 'failed')).toBe('revoked');
  });
  it('stores only granted and revoked', () => {
    expect(isStoredAccessRights('granted')).toBe(true);
    expect(isStoredAccessRights('revoked')).toBe(true);
    expect(isStoredAccessRights('to_be_reviewed')).toBe(false);
  });
});
