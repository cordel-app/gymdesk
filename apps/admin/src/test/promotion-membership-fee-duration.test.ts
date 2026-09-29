import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  mfDurationOptions,
  promotionTimelineMonths,
} from '../app/[locale]/promotions/membershipFeeDuration';

// Regression test for #899 — the Membership Fee Benefit's Duration is bounded
// by the Promotion's own timeline (Free Period + Paid Duration + Bonus
// Duration), and the way that bound is enforced in the editor is that the
// selector only offers the durations the Promotion can carry. Nothing is
// silently truncated on the way in, because an out-of-range value can no
// longer be entered.
//
// The backend keeps its own 400 (#625, `PUT /promotions/:id/membership-fee-benefit`),
// covered by api/src/test/promotions.test.ts — this file covers the list the
// staff member picks from.
//
// apps/admin has no component-test infra (see docs/architecture.md's TL;DR),
// so the pure list is unit-tested directly and the control it feeds is pinned
// down by scanning the page source, as the other promotions tests do.

const PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8'));

describe('promotionTimelineMonths', () => {
  it('is free + paid + bonus', () => {
    expect(promotionTimelineMonths(1, 2, 2)).toBe(5);
    expect(promotionTimelineMonths(3, 4, 3)).toBe(10);
  });

  it('treats an unconfigured period as zero', () => {
    expect(promotionTimelineMonths(1, null, 2)).toBe(3);
    expect(promotionTimelineMonths(null, null, null)).toBe(0);
    expect(promotionTimelineMonths(undefined, 3, undefined)).toBe(3);
  });

  it('never counts a negative period', () => {
    expect(promotionTimelineMonths(-4, 2, 1)).toBe(3);
  });

  it('excludes Pay Beforehand by taking only three periods (#625)', () => {
    // Pay Beforehand reclassifies paid months as prepaid; it never lengthens
    // the Promotion, so it is not an argument at all.
    expect(promotionTimelineMonths.length).toBe(3);
  });
});

describe('mfDurationOptions', () => {
  it('offers every duration the Promotion can carry', () => {
    // The ticket's own example: free 3 + paid 4 + bonus 3 → 1..10.
    expect(mfDurationOptions(promotionTimelineMonths(3, 4, 3))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('never offers a duration above the maximum', () => {
    expect(mfDurationOptions(5)).not.toContain(6);
    expect(mfDurationOptions(10)).not.toContain(11);
  });

  it('grows with the Promotion timeline', () => {
    expect(mfDurationOptions(promotionTimelineMonths(1, 2, 2))).toHaveLength(5);
    expect(mfDurationOptions(promotionTimelineMonths(1, 3, 2))).toHaveLength(6);
  });

  it('offers nothing for a Promotion with no periods', () => {
    // Only the null ("whole Promotion") option the selector renders itself is
    // left, so a positive Duration cannot be configured on a zero-period
    // Promotion.
    expect(mfDurationOptions(0)).toEqual([]);
    expect(mfDurationOptions(-1)).toEqual([]);
    expect(mfDurationOptions(NaN)).toEqual([]);
  });

  it('does not offer 0 — a stored duration is a positive integer', () => {
    // The API rejects `duration_months: 0` ("must be a positive integer") and
    // reads a null as "the whole Promotion", which is the selector's own
    // separate option.
    expect(mfDurationOptions(5)).not.toContain(0);
  });
});

describe('the Duration control', () => {
  it('is a selector over mfDurationOptions, not a free-text number input', () => {
    const control = pageSrc.slice(
      pageSrc.indexOf('{membershipFeeName}'),
      pageSrc.indexOf('CHARGE_ACTIONS.map'),
    );
    expect(control).toContain('mfDurationOptions(maxDuration)');
    expect(control).not.toMatch(/type="number"[\s\S]*?duration_months/);
  });

  it('does not silently truncate an entered value', () => {
    // #625's typing clamp (Math.min(raw, maxDuration)) is what #899 removed:
    // the list is the validation now.
    expect(pageSrc).not.toContain('Math.min(raw, maxDuration)');
  });

  it('still re-constrains a saved duration when the Promotion shrinks (#625)', () => {
    // Not truncation of user input: the value was valid when it was picked and
    // the Promotion was shortened underneath it, which would otherwise leave a
    // benefit the backend refuses to save.
    expect(pageSrc).toContain('async function clampSavedMembershipFeeDuration');
  });

  it('computes its maximum from the Promotion timeline', () => {
    expect(pageSrc).toContain('promotionTimelineMonths');
    expect(pageSrc).toContain('const maxDuration = mfMaxDurationMonths(promoId)');
  });
});
