// #785 — the nightly run's dunning rule. Pure functions, no DB and no HTTP, so
// this is a unit test (CLAUDE.md): `domain/billingDunning.ts` decides what
// counts as a rejection and when the second one pauses, and the run only obeys.

import { describe, expect, it } from 'vitest';
import {
  MAX_BILLING_RUN_ATTEMPTS,
  RunFailureKind,
  countsTowardPause,
  registerRejection,
  toAttemptCount,
} from '../domain/billingDunning';

describe('countsTowardPause', () => {
  it('escalates only on a provider rejection', () => {
    expect(countsTowardPause('rejected')).toBe(true);
  });

  // The two failures the run also records as `failed_billing` but which are not
  // declines: the ticket is explicit about the first, and the second never even
  // reached the provider.
  it.each<RunFailureKind>(['provider_error', 'no_payment_method'])(
    'does not escalate on %s',
    (kind) => {
      expect(countsTowardPause(kind)).toBe(false);
    },
  );
});

/** A rejection on a day this assignment has not been rejected on yet. */
const onANewDay = (previousAttempts: unknown) =>
  registerRejection({ previousAttempts, alreadyRejectedToday: false });

describe('registerRejection', () => {
  it('records the first rejection without pausing', () => {
    expect(onANewDay(0)).toEqual({ attempts: 1, pause: false });
  });

  it('pauses on the second consecutive rejection', () => {
    expect(onANewDay(1)).toEqual({ attempts: 2, pause: true });
  });

  it('treats a cleared counter as a first rejection again', () => {
    // What a settled or waived cycle leaves behind: the member paid, so the next
    // decline starts the count over rather than pausing them immediately.
    expect(onANewDay(0)).toEqual({ attempts: 1, pause: false });
  });

  // A row read before migration 194 (mid-deploy) or one the driver hands back as
  // a string must not turn into NaN arithmetic that never reaches the threshold.
  it.each([null, undefined, '', 'nonsense', -3, 0.4])(
    'reads %p as no previous rejections',
    (value) => {
      expect(onANewDay(value)).toEqual({ attempts: 1, pause: false });
    },
  );

  it('reads a string count as a number', () => {
    expect(onANewDay('1')).toEqual({ attempts: 2, pause: true });
  });

  it('never counts past the threshold, whatever the column held', () => {
    // A row that somehow carried 99 pauses rather than doing something
    // undefined, and the stored count stays inside the documented range.
    expect(onANewDay(99)).toEqual({
      attempts: MAX_BILLING_RUN_ATTEMPTS,
      pause: true,
    });
  });

  // The retry is the next **run day**, and the day is what the count advances
  // on. #781's second daily attempt is normally a no-op, but after a first run
  // that crashed it becomes the day's real run — and a row it had already
  // charged must not be escalated four hours later against the same card.
  it('does not advance the count on a second rejection the same day', () => {
    expect(registerRejection({ previousAttempts: 1, alreadyRejectedToday: true }))
      .toEqual({ attempts: 1, pause: false });
  });

  it('still records at least one rejection on a same-day repeat', () => {
    expect(registerRejection({ previousAttempts: 0, alreadyRejectedToday: true }))
      .toEqual({ attempts: 1, pause: false });
  });

  it('pauses on the next day after a same-day repeat', () => {
    const sameDay = registerRejection({ previousAttempts: 1, alreadyRejectedToday: true });
    expect(onANewDay(sameDay.attempts)).toEqual({ attempts: 2, pause: true });
  });
});

describe('toAttemptCount', () => {
  it('clamps to 0..MAX_BILLING_RUN_ATTEMPTS', () => {
    expect(toAttemptCount(-1)).toBe(0);
    expect(toAttemptCount(1)).toBe(1);
    expect(toAttemptCount(7)).toBe(MAX_BILLING_RUN_ATTEMPTS);
  });
});
