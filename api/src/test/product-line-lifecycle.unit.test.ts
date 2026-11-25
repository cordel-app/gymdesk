import { describe, it, expect } from 'vitest';
import { canCancelLineImmediately, productLineLifecycle } from '../domain/productLineLifecycle';

const TODAY = '2026-11-25';

describe('#3358 stage 2 — a recurring Product line shares the Membership Plan cancellation lifecycle', () => {
  it('is Active while the committed line is open-ended and no Draft changes it', () => {
    expect(productLineLifecycle({ committedEndsOn: null, committedSourceEndsOn: null, today: TODAY })).toBe('active');
    expect(productLineLifecycle({
      committedEndsOn: null, committedSourceEndsOn: null, today: TODAY,
      draft: { carries: true, endsOn: null },
    })).toBe('active');
  });

  it('reads To Be Canceled while the open Draft ends a running line (the old pending_termination)', () => {
    // The Draft's own copy of the line ends on its last paid day; the committed line is untouched.
    expect(productLineLifecycle({
      committedEndsOn: null, committedSourceEndsOn: null, today: TODAY,
      draft: { carries: true, endsOn: '2026-12-31' },
    })).toBe('to_be_canceled');
    // A line the Draft no longer carries at all is removed by the commit.
    expect(productLineLifecycle({
      committedEndsOn: null, committedSourceEndsOn: null, today: TODAY,
      draft: { carries: false, endsOn: null },
    })).toBe('to_be_canceled');
  });

  it('reads To Be Canceled Immediately while the Draft brings a committed End Date forward', () => {
    expect(productLineLifecycle({
      committedEndsOn: '2026-12-31', committedSourceEndsOn: null, today: TODAY,
      draft: { carries: true, endsOn: TODAY },
    })).toBe('to_be_canceled_immediately');
  });

  it('keeps a committed cancellation at Cancels at End Date until the day it ends', () => {
    expect(productLineLifecycle({ committedEndsOn: '2026-12-31', committedSourceEndsOn: null, today: TODAY }))
      .toBe('active_cancel_at_period_end');
    // The Draft carrying the same end date changes nothing.
    expect(productLineLifecycle({
      committedEndsOn: '2026-12-31', committedSourceEndsOn: null, today: TODAY,
      draft: { carries: true, endsOn: '2026-12-31' },
    })).toBe('active_cancel_at_period_end');
  });

  it('reads Cancelled once an immediate cancellation is committed', () => {
    // The committed line is the Draft's copy: today, brought forward from its source's End Date.
    expect(productLineLifecycle({ committedEndsOn: TODAY, committedSourceEndsOn: '2026-12-31', today: TODAY }))
      .toBe('cancelled');
  });

  it('does not read a plain removal committed on its last paid day as cancelled', () => {
    // A removal's copy ends on the paid-through day, which is not before its source's (none).
    expect(productLineLifecycle({ committedEndsOn: '2026-12-31', committedSourceEndsOn: null, today: TODAY }))
      .toBe('active_cancel_at_period_end');
  });

  it('offers Cancel Immediately only for a committed cancellation still ahead', () => {
    expect(canCancelLineImmediately('active_cancel_at_period_end', '2026-12-31', TODAY)).toBe(true);
    // Nothing to bring forward: it ends today, or it is already cancelled, active or pending.
    expect(canCancelLineImmediately('active_cancel_at_period_end', TODAY, TODAY)).toBe(false);
    expect(canCancelLineImmediately('active_cancel_at_period_end', null, TODAY)).toBe(false);
    expect(canCancelLineImmediately('cancelled', '2026-12-31', TODAY)).toBe(false);
    expect(canCancelLineImmediately('active', null, TODAY)).toBe(false);
    expect(canCancelLineImmediately('to_be_canceled_immediately', '2026-12-31', TODAY)).toBe(false);
  });
});
