import { describe, expect, it } from 'vitest';
import { formatDraftRemaining, isDraftWarning, remainingNow } from '../app/[locale]/members/draftCountdown';

describe('draft countdown (#2477)', () => {
  it('formats the remaining time', () => {
    expect(formatDraftRemaining(105 * 60)).toBe('1h 45m');
    expect(formatDraftRemaining(32 * 60)).toBe('32m');
    expect(formatDraftRemaining(5 * 60)).toBe('5m');
    expect(formatDraftRemaining(0)).toBeNull();
  });
  it('counts down from the server value without the browser clock deciding', () => {
    expect(remainingNow(600, 0, 120_000)).toBe(480);
    expect(remainingNow(60, 0, 999_000)).toBe(0);
    expect(isDraftWarning(300)).toBe(true);
    expect(isDraftWarning(3600)).toBe(false);
  });
});
