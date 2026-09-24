// #635 stage 7 — unit tests for how an applied Promotion reads on the
// Assigned Plan card. Pure function, no DB and no HTTP (CLAUDE.md).

import { describe, expect, it } from 'vitest';
import { promotionApplicationStatus } from '../domain/promotionApplicationStatus';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('promotionApplicationStatus', () => {
  it('is active while applied and inside the agreed window', () => {
    expect(promotionApplicationStatus({ status: 'applied', ends_at: '2026-12-31' }, NOW)).toBe('active');
  });

  it('is expired once the agreed window has passed', () => {
    expect(promotionApplicationStatus({ status: 'applied', ends_at: '2026-05-31' }, NOW)).toBe('expired');
  });

  it('is active for an open-ended application', () => {
    expect(promotionApplicationStatus({ status: 'applied', ends_at: null }, NOW)).toBe('active');
  });

  it('is inactive once revoked, whatever its window says', () => {
    expect(promotionApplicationStatus({ status: 'revoked', ends_at: '2099-12-31' }, NOW)).toBe('inactive');
    expect(promotionApplicationStatus({ status: 'revoked', ends_at: '2026-01-01' }, NOW)).toBe('inactive');
  });

  it('treats any other stored status as no longer standing', () => {
    // 'consumed' is in the CHECK constraint (migration 022) and is not
    // applied any more, so it reads like a revocation rather than as active.
    expect(promotionApplicationStatus({ status: 'consumed', ends_at: '2099-12-31' }, NOW)).toBe('inactive');
  });

  it('accepts the Date a driver hands back as well as a string', () => {
    expect(promotionApplicationStatus({ status: 'applied', ends_at: new Date('2026-05-31T00:00:00Z') }, NOW))
      .toBe('expired');
    expect(promotionApplicationStatus({ status: 'applied', ends_at: new Date('2026-12-31T00:00:00Z') }, NOW))
      .toBe('active');
  });

  it('does not expire an application whose stored window is unreadable', () => {
    expect(promotionApplicationStatus({ status: 'applied', ends_at: 'not-a-date' }, NOW)).toBe('active');
  });
});
