// Unit tests for domain/goalReadings.ts — what a goal reading is, and what the
// readings of one Assigned Personal Goal add up to (#1037 stage 2).
//
// Pure: no DB, no HTTP. The progress rule is the ticket's own arithmetic (§26)
// with the direction **derived** from initial vs target rather than stored (the
// thread's `Q2`), so the cases below are the three directions plus the
// boundaries §27 asks for.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_READING_SUMMARY,
  RECORDED_AT_SKEW_MS,
  READING_VALUE_MAX,
  activeInitialReadingOf,
  initialReadingTimestamp,
  assignReadingPeriods,
  initialReadingHistoryOf,
  latestReadingOf,
  normalizeReadingValue,
  normalizeRecordedAt,
  progressPercent,
  sortReadings,
  summarizeReadings,
  toGoalReading,
  toMysqlDateTime,
} from '../domain/goalReadings';

const t = (iso: string) => new Date(iso).getTime();

function reading(id: number, value: number, iso: string, isInitial = false) {
  return { id, value, recordedAt: t(iso), isInitial };
}

describe('normalizeReadingValue', () => {
  it('requires a value — a reading with no number is not a measurement', () => {
    for (const input of [undefined, null, '']) {
      expect(normalizeReadingValue(input)).toEqual({ error: 'value is required' });
    }
  });

  it('refuses text (§31)', () => {
    expect(normalizeReadingValue('heavy')).toEqual({ error: 'value must be a number' });
    expect(normalizeReadingValue({})).toEqual({ error: 'value must be a number' });
    expect(normalizeReadingValue(Number.NaN)).toEqual({ error: 'value must be a number' });
  });

  it('accepts a number or a numeric string and rounds to the column scale', () => {
    expect(normalizeReadingValue(82.456)).toEqual({ value: 82.46 });
    expect(normalizeReadingValue('75')).toEqual({ value: 75 });
    expect(normalizeReadingValue(0)).toEqual({ value: 0 });
  });

  it('bounds the value like the target it is measured against', () => {
    expect(normalizeReadingValue(-1)).toEqual({ error: 'value must be zero or greater' });
    expect('error' in normalizeReadingValue(READING_VALUE_MAX + 1)).toBe(true);
    expect(normalizeReadingValue(READING_VALUE_MAX)).toEqual({ value: READING_VALUE_MAX });
  });
});

describe('normalizeRecordedAt', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('reads an absent value as "not named", which the route takes as now (§32)', () => {
    expect(normalizeRecordedAt(undefined, now)).toEqual({ value: undefined });
    expect(normalizeRecordedAt(null, now)).toEqual({ value: undefined });
    expect(normalizeRecordedAt('', now)).toEqual({ value: undefined });
  });

  it('accepts a date-only value at midnight UTC, as the Add reading dialog submits (§3)', () => {
    expect(normalizeRecordedAt('2026-09-22', now)).toEqual({ value: '2026-09-22 00:00:00' });
  });

  it('accepts a full timestamp, so two readings on one date stay distinct (§33)', () => {
    expect(normalizeRecordedAt('2026-09-22T09:00:00Z', now)).toEqual({ value: '2026-09-22 09:00:00' });
    expect(normalizeRecordedAt('2026-09-22T18:30:00Z', now)).toEqual({ value: '2026-09-22 18:30:00' });
  });

  it('refuses a value that is not a date at all', () => {
    expect('error' in normalizeRecordedAt('yesterday', now)).toBe(true);
    expect('error' in normalizeRecordedAt('2026-02-30', now)).toBe(true);
    expect('error' in normalizeRecordedAt(1759000000000 as unknown, now)).toBe(true);
  });

  it('refuses the future, which §32 does not allow and a typed year would freeze', () => {
    expect(normalizeRecordedAt('2126-09-22', now)).toEqual({ error: 'recorded_at cannot be in the future' });
    expect('error' in normalizeRecordedAt('2026-10-05T12:30:00Z', now)).toBe(true);
  });

  it('tolerates a client clock a little ahead', () => {
    const skewed = new Date(now.getTime() + RECORDED_AT_SKEW_MS - 1000).toISOString();
    expect('value' in normalizeRecordedAt(skewed, now)).toBe(true);
  });
});

describe('toGoalReading', () => {
  it('reads a stored row whether the driver hands back a Date or a string', () => {
    expect(toGoalReading({ id: 1, value: '80.00', recorded_at: new Date('2026-09-01T00:00:00Z'), is_initial: 1 }))
      .toEqual({ id: 1, value: 80, recordedAt: t('2026-09-01T00:00:00Z'), isInitial: true });
    expect(toGoalReading({ id: 2, value: 78, recorded_at: '2026-09-08 10:00:00', is_initial: 0 }))
      .toEqual({ id: 2, value: 78, recordedAt: t('2026-09-08T10:00:00Z'), isInitial: false });
  });

  it('answers null rather than NaN for an unusable row', () => {
    expect(toGoalReading({ id: 1, value: 'x', recorded_at: '2026-09-01 00:00:00', is_initial: 0 })).toBeNull();
    expect(toGoalReading({ id: 1, value: 80, recorded_at: 'nonsense', is_initial: 0 })).toBeNull();
  });

  it('round-trips a DATETIME through toMysqlDateTime', () => {
    expect(toMysqlDateTime(new Date('2026-09-22T18:30:00Z'))).toBe('2026-09-22 18:30:00');
  });
});

describe('initialReadingTimestamp (§4)', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('reuses the assignment\'s own start date rather than inventing one', () => {
    expect(initialReadingTimestamp({ explicit: undefined, startDate: '2026-09-01', now }))
      .toBe('2026-09-01 00:00:00');
  });

  it('prefers an explicitly named time', () => {
    expect(initialReadingTimestamp({ explicit: '2026-09-02 08:00:00', startDate: '2026-09-01', now }))
      .toBe('2026-09-02 08:00:00');
  });

  it('falls back to now (undefined) with no start date', () => {
    expect(initialReadingTimestamp({ explicit: undefined, startDate: null, now })).toBeUndefined();
  });

  it('does not take a future start date, which would get around the future rule', () => {
    expect(initialReadingTimestamp({ explicit: undefined, startDate: '2026-11-01', now })).toBeUndefined();
  });
});

describe('ordering', () => {
  const unsorted = [
    reading(3, 77, '2026-09-15T00:00:00Z'),
    reading(1, 80, '2026-09-01T00:00:00Z', true),
    reading(2, 78, '2026-09-08T00:00:00Z'),
  ];

  it('is chronological for the chart (§17) and total through the id (§33)', () => {
    expect(sortReadings(unsorted).map((r) => r.id)).toEqual([1, 2, 3]);
    const sameDay = [reading(9, 81.9, '2026-09-22T18:00:00Z'), reading(8, 82.4, '2026-09-22T09:00:00Z')];
    expect(sortReadings(sameDay).map((r) => r.id)).toEqual([8, 9]);
    const sameInstant = [reading(11, 70, '2026-09-22T09:00:00Z'), reading(10, 71, '2026-09-22T09:00:00Z')];
    expect(sortReadings(sameInstant).map((r) => r.id)).toEqual([10, 11]);
  });

  it('does not mutate its input', () => {
    const input = [...unsorted];
    sortReadings(input);
    expect(input.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('latestReadingOf is the most recent (§10)', () => {
    expect(latestReadingOf(unsorted)?.value).toBe(77);
    expect(latestReadingOf([])).toBeNull();
  });
});

describe('activeInitialReadingOf', () => {
  it('is the latest boundary, not the first (§25)', () => {
    const readings = [
      reading(1, 80, '2026-09-01T00:00:00Z', true),
      reading(2, 78, '2026-09-08T00:00:00Z'),
      reading(3, 76, '2026-09-22T00:00:00Z', true),
      reading(4, 75, '2026-09-29T00:00:00Z'),
    ];
    expect(activeInitialReadingOf(readings)?.value).toBe(76);
    // §28/§22: the superseded one is still there.
    expect(initialReadingHistoryOf(readings).map((r) => r.value)).toEqual([80, 76]);
  });

  it('falls back to the earliest reading when nothing is flagged (§2)', () => {
    const readings = [reading(1, 80, '2026-09-01T00:00:00Z'), reading(2, 78, '2026-09-08T00:00:00Z')];
    expect(activeInitialReadingOf(readings)?.value).toBe(80);
    expect(initialReadingHistoryOf(readings)).toEqual([]);
  });

  it('is null with no readings at all', () => {
    expect(activeInitialReadingOf([])).toBeNull();
  });
});

describe('assignReadingPeriods (§38)', () => {
  it('puts each reading in the period its initial reading opens', () => {
    const readings = [
      reading(1, 80, '2026-09-01T00:00:00Z', true),
      reading(2, 78, '2026-09-08T00:00:00Z'),
      reading(3, 77, '2026-09-15T00:00:00Z'),
      reading(4, 76, '2026-09-22T00:00:00Z', true),
      reading(5, 75, '2026-09-29T00:00:00Z'),
      reading(6, 74, '2026-10-10T00:00:00Z', true),
    ];
    const periods = assignReadingPeriods(readings);
    expect([1, 2, 3, 4, 5, 6].map((id) => periods.get(id))).toEqual([0, 0, 0, 1, 1, 2]);
  });

  it('shares period 0 with the readings that precede the first boundary', () => {
    const readings = [
      reading(1, 80, '2026-09-01T00:00:00Z'),
      reading(2, 78, '2026-09-08T00:00:00Z', true),
      reading(3, 77, '2026-09-15T00:00:00Z'),
    ];
    const periods = assignReadingPeriods(readings);
    expect([1, 2, 3].map((id) => periods.get(id))).toEqual([0, 0, 0]);
  });
});

describe('progressPercent (§26/§27)', () => {
  it("reads the ticket's own weight-loss example as 50%", () => {
    expect(progressPercent({ initial: 80, latest: 75, target: 70 })).toBe(50);
  });

  it('works the other way round for a gain goal, with no direction stored', () => {
    expect(progressPercent({ initial: 70, latest: 75, target: 80 })).toBe(50);
    expect(progressPercent({ initial: 70, latest: 73, target: 80 })).toBe(30);
  });

  it('clamps rather than reporting the values §27 rules out', () => {
    // Target exceeded: 153.8% reads as 100.
    expect(progressPercent({ initial: 80, latest: 60, target: 70 })).toBe(100);
    expect(progressPercent({ initial: 80, latest: 70, target: 70 })).toBe(100);
    // Moving away: -42% reads as 0.
    expect(progressPercent({ initial: 80, latest: 88, target: 70 })).toBe(0);
    expect(progressPercent({ initial: 70, latest: 67, target: 80 })).toBe(0);
  });

  it('treats an equal initial and target as maintenance', () => {
    expect(progressPercent({ initial: 80, latest: 80, target: 80 })).toBe(100);
    expect(progressPercent({ initial: 80, latest: 79, target: 80 })).toBe(0);
  });

  it('answers null when it cannot be computed — never 0%', () => {
    expect(progressPercent({ initial: null, latest: 75, target: 70 })).toBeNull();
    expect(progressPercent({ initial: 80, latest: null, target: 70 })).toBeNull();
    expect(progressPercent({ initial: 80, latest: 75, target: null })).toBeNull();
  });

  it('rounds to one decimal so both surfaces report one figure', () => {
    expect(progressPercent({ initial: 80, latest: 78, target: 74 })).toBe(33.3);
  });
});

describe('summarizeReadings', () => {
  it('is the five header fields of §5–§11, from the readings and the target', () => {
    const summary = summarizeReadings([
      reading(1, 80, '2026-09-01T00:00:00Z', true),
      reading(2, 78, '2026-09-08T00:00:00Z'),
      reading(3, 76, '2026-09-22T00:00:00Z', true),
      reading(4, 75, '2026-09-29T00:00:00Z'),
    ], 70);
    expect(summary).toEqual({
      initial_reading: 76,
      initial_reading_at: '2026-09-22T00:00:00.000Z',
      latest_reading: 75,
      latest_reading_at: '2026-09-29T00:00:00.000Z',
      // §25: measured from the **active** initial reading (76 → 75 → 70), not
      // from the 80 the goal started at, which would read 50%.
      effective_target: 70,
      progress_percent: 16.7,
      reading_count: 4,
    });
  });

  it('reports nothing measured rather than zero progress', () => {
    // An absolute target is its own effective target even before any reading (#1229).
    expect(summarizeReadings([], 70)).toEqual({ ...EMPTY_READING_SUMMARY, effective_target: 70 });
  });

  it('reports a latest reading with no progress when the goal has no target', () => {
    const summary = summarizeReadings([reading(1, 80, '2026-09-01T00:00:00Z', true)], null);
    expect(summary.latest_reading).toBe(80);
    expect(summary.initial_reading).toBe(80);
    expect(summary.progress_percent).toBeNull();
  });
});
