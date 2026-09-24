// #635 stage 7 — unit tests for how an applied Promotion reads on the
// Assigned Plan card. Pure function, no DB and no HTTP (CLAUDE.md).

import { describe, expect, it } from 'vitest';
import { canReapplyPromotion, promotionApplicationStatus } from '../domain/promotionApplicationStatus';

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

// #635 stage 9 — whether a spent application may be agreed again (the issue
// thread's Q2 answer: Promotions are "selectable and deselectable"). Pure
// function, no DB and no HTTP.

describe('canReapplyPromotion', () => {
  const REAPPLICABLE = {
    displayStatus: 'inactive' as const,
    hasStandingApplication: false,
    promotionLifecycleStatus: 'active',
    promotionStartsAt: '2026-01-01',
    promotionEndsAt: '2026-12-31',
  };

  it('offers a revoked application whose Promotion is still live today', () => {
    expect(canReapplyPromotion(REAPPLICABLE, NOW)).toBe(true);
  });

  it('does not offer an application that is still standing', () => {
    // A standing application is deselected by revoking it, not re-applied —
    // and `ump_one_standing_per_promotion` (migration 183) would refuse a
    // second one anyway.
    expect(canReapplyPromotion({ ...REAPPLICABLE, displayStatus: 'active' }, NOW)).toBe(false);
    expect(canReapplyPromotion({ ...REAPPLICABLE, displayStatus: 'expired' }, NOW)).toBe(false);
  });

  it('does not offer a Promotion another application already holds', () => {
    // The spent card plus the one that replaced it: only one of them can be
    // standing, so the spent one is history, not a control.
    expect(canReapplyPromotion({ ...REAPPLICABLE, hasStandingApplication: true }, NOW)).toBe(false);
  });

  it('does not offer a Promotion that is no longer active', () => {
    for (const lifecycle of ['inactive', 'draft', 'deleted', null]) {
      expect(canReapplyPromotion({ ...REAPPLICABLE, promotionLifecycleStatus: lifecycle }, NOW), lifecycle ?? 'null')
        .toBe(false);
    }
  });

  it('does not offer a Promotion outside its own window today', () => {
    expect(canReapplyPromotion({ ...REAPPLICABLE, promotionStartsAt: '2026-07-01' }, NOW)).toBe(false);
    expect(canReapplyPromotion({ ...REAPPLICABLE, promotionEndsAt: '2026-05-31' }, NOW)).toBe(false);
  });

  it('accepts an open-ended Promotion window and the Dates a driver hands back', () => {
    expect(canReapplyPromotion({
      ...REAPPLICABLE, promotionStartsAt: null, promotionEndsAt: null,
    }, NOW)).toBe(true);
    expect(canReapplyPromotion({
      ...REAPPLICABLE,
      promotionStartsAt: new Date('2026-01-01T00:00:00Z'),
      promotionEndsAt: new Date('2026-12-31T00:00:00Z'),
    }, NOW)).toBe(true);
  });

  it('ignores an unreadable window rather than blocking on it', () => {
    // The apply path is the authority on eligibility; a card that cannot read
    // the dates offers the action and lets the server answer.
    expect(canReapplyPromotion({
      ...REAPPLICABLE, promotionStartsAt: 'not-a-date', promotionEndsAt: 'not-a-date',
    }, NOW)).toBe(true);
  });
});
