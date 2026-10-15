import { describe, it, expect } from 'vitest';
import { completionActions } from '../lib/nutritionCompletion';

describe('completionActions', () => {
  it('offers Mark Done on an incomplete meal today or in the past, never Partially Done', () => {
    for (const d of ['2026-10-14', '2026-10-01']) {
      const a = completionActions('meal', undefined, d, '2026-10-14');
      expect(a.showMarkDone).toBe(true);
      expect(a.showPartiallyDone).toBe(false);
    }
  });
  it('offers both actions on an open restriction, and only Mark Done once partial', () => {
    expect(completionActions('restriction', undefined, '2026-10-14', '2026-10-14')).toMatchObject({ showMarkDone: true, showPartiallyDone: true });
    expect(completionActions('restriction', 'partial', '2026-10-14', '2026-10-14')).toMatchObject({ showMarkDone: true, showPartiallyDone: false, partial: true });
  });
  it('offers Mark Done only on a goal', () => {
    expect(completionActions('goal', undefined, '2026-10-14', '2026-10-14')).toMatchObject({ showMarkDone: true, showPartiallyDone: false });
  });
  it('offers nothing for a future date or a completed item', () => {
    expect(completionActions('meal', undefined, '2026-10-15', '2026-10-14')).toMatchObject({ showMarkDone: false, showPartiallyDone: false });
    expect(completionActions('restriction', 'done', '2026-10-14', '2026-10-14')).toMatchObject({ done: true, showMarkDone: false, showPartiallyDone: false });
  });
});
