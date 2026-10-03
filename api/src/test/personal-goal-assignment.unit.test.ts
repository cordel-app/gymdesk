// Unit tests for domain/personalGoalAssignment.ts (#948 §4)
//
// Pure functions: no DB, no HTTP, no helpers.

import { describe, expect, it } from 'vitest';
import {
  NOTES_MAX_LENGTH,
  PERSONAL_GOAL_ASSIGNMENT_STATUSES,
  TARGET_UNIT_MAX_LENGTH,
  TARGET_VALUE_MAX,
  buildAssignmentListWhere,
  goalAssignmentFieldError,
  isPersonalGoalAssignmentStatus,
  normalizeGoalDate,
  normalizeNotes,
  normalizeStatus,
  normalizeTargetUnit,
  normalizeTargetValue,
} from '../domain/personalGoalAssignment';

/** Narrows the union the normalizers answer with, so a failure reads as one. */
function value<T>(result: { value: T } | { error: string }): T {
  if ('error' in result) throw new Error(`expected a value, got: ${result.error}`);
  return result.value;
}
function error<T>(result: { value: T } | { error: string }): string {
  if (!('error' in result)) throw new Error(`expected an error, got: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe('the status vocabulary', () => {
  it('is the three progress values, and deletion is not one of them', () => {
    expect(PERSONAL_GOAL_ASSIGNMENT_STATUSES).toEqual(['in_progress', 'achieved', 'abandoned']);
    expect(isPersonalGoalAssignmentStatus('deleted')).toBe(false);
    expect(isPersonalGoalAssignmentStatus('active')).toBe(false);
  });

  it('recognises each value and nothing else', () => {
    for (const status of PERSONAL_GOAL_ASSIGNMENT_STATUSES) {
      expect(isPersonalGoalAssignmentStatus(status)).toBe(true);
    }
    expect(isPersonalGoalAssignmentStatus('paused')).toBe(false);
    expect(isPersonalGoalAssignmentStatus(1)).toBe(false);
    expect(isPersonalGoalAssignmentStatus(null)).toBe(false);
  });
});

describe('normalizeStatus', () => {
  it('answers undefined for a field the request did not mention', () => {
    expect(value(normalizeStatus(undefined, { required: false }))).toBeUndefined();
    expect(value(normalizeStatus(null, { required: false }))).toBeUndefined();
    expect(value(normalizeStatus('', { required: false }))).toBeUndefined();
  });

  it('refuses a missing value when it is required, and an unknown one always', () => {
    expect(error(normalizeStatus(undefined, { required: true }))).toMatch(/required/);
    expect(error(normalizeStatus('paused', { required: false }))).toMatch(/must be one of/);
  });

  it('passes a known value through', () => {
    expect(value(normalizeStatus('achieved', { required: false }))).toBe('achieved');
  });
});

describe('normalizeTargetValue', () => {
  it('distinguishes "not mentioned" from "cleared"', () => {
    expect(value(normalizeTargetValue(undefined))).toBeUndefined();
    expect(value(normalizeTargetValue(null))).toBeNull();
    expect(value(normalizeTargetValue(''))).toBeNull();
  });

  it('accepts a number and a numeric string', () => {
    expect(value(normalizeTargetValue(5))).toBe(5);
    expect(value(normalizeTargetValue('5.5'))).toBe(5.5);
    expect(value(normalizeTargetValue(0))).toBe(0);
  });

  it('rounds to the column own scale rather than refusing', () => {
    expect(value(normalizeTargetValue(5.005))).toBe(5.01);
    expect(value(normalizeTargetValue(1.234))).toBe(1.23);
  });

  it('refuses a negative, a non-number and a value past the column width', () => {
    expect(error(normalizeTargetValue(-0.01))).toMatch(/zero or greater/);
    expect(error(normalizeTargetValue('kg'))).toMatch(/must be a number/);
    expect(error(normalizeTargetValue({}))).toMatch(/must be a number/);
    expect(error(normalizeTargetValue(TARGET_VALUE_MAX + 1))).toMatch(/at most/);
  });
});

describe('normalizeTargetUnit and normalizeNotes', () => {
  it('treat an empty string as a clear and trim what is kept', () => {
    expect(value(normalizeTargetUnit('  kg '))).toBe('kg');
    expect(value(normalizeTargetUnit(''))).toBeNull();
    expect(value(normalizeTargetUnit('   '))).toBeNull();
    expect(value(normalizeNotes('  note '))).toBe('note');
    expect(value(normalizeNotes(''))).toBeNull();
  });

  it('answer undefined only for an absent field', () => {
    expect(value(normalizeTargetUnit(undefined))).toBeUndefined();
    expect(value(normalizeNotes(undefined))).toBeUndefined();
    expect(value(normalizeTargetUnit(null))).toBeNull();
    expect(value(normalizeNotes(null))).toBeNull();
  });

  it('refuse a non-string and an over-long value', () => {
    expect(error(normalizeTargetUnit(5))).toMatch(/must be a string/);
    expect(error(normalizeNotes(5))).toMatch(/must be a string/);
    expect(error(normalizeTargetUnit('x'.repeat(TARGET_UNIT_MAX_LENGTH + 1)))).toMatch(/at most/);
    expect(error(normalizeNotes('x'.repeat(NOTES_MAX_LENGTH + 1)))).toMatch(/at most/);
  });
});

describe('normalizeGoalDate', () => {
  it('accepts an ISO date and clears on null or empty', () => {
    expect(value(normalizeGoalDate('2026-01-31', 'start_date'))).toBe('2026-01-31');
    expect(value(normalizeGoalDate(null, 'start_date'))).toBeNull();
    expect(value(normalizeGoalDate('', 'target_date'))).toBeNull();
    expect(value(normalizeGoalDate(undefined, 'target_date'))).toBeUndefined();
  });

  it('refuses a malformed and an impossible date, naming the field', () => {
    expect(error(normalizeGoalDate('31/01/2026', 'start_date'))).toMatch(/^start_date/);
    expect(error(normalizeGoalDate('2026-1-1', 'start_date'))).toMatch(/YYYY-MM-DD/);
    // A real-looking date MySQL would reject — refused here so the failure is a
    // 400 and not a driver error the global handler turns into a 500 (#966).
    expect(error(normalizeGoalDate('2026-02-31', 'target_date'))).toMatch(/real date/);
    expect(error(normalizeGoalDate('2026-13-01', 'target_date'))).toMatch(/real date/);
  });
});

describe('goalAssignmentFieldError', () => {
  const base = { targetValue: null, targetUnit: null, startDate: null, targetDate: null };

  it('accepts an empty row and a fully filled one', () => {
    expect(goalAssignmentFieldError(base)).toBeNull();
    expect(goalAssignmentFieldError({
      targetValue: 5, targetUnit: 'kg', startDate: '2026-01-01', targetDate: '2026-06-01',
    })).toBeNull();
  });

  it('refuses a unit with nothing to qualify', () => {
    expect(goalAssignmentFieldError({ ...base, targetUnit: 'kg' })).toMatch(/requires a target_value/);
    // A value without a unit is fine: "lose 5" is incomplete, not contradictory.
    expect(goalAssignmentFieldError({ ...base, targetValue: 5 })).toBeNull();
  });

  it('refuses a target date before the start date, and allows the same day', () => {
    expect(goalAssignmentFieldError({ ...base, startDate: '2026-06-01', targetDate: '2026-01-01' }))
      .toMatch(/on or after/);
    expect(goalAssignmentFieldError({ ...base, startDate: '2026-06-01', targetDate: '2026-06-01' })).toBeNull();
    // One date alone says nothing about the other.
    expect(goalAssignmentFieldError({ ...base, targetDate: '2026-01-01' })).toBeNull();
  });
});

describe('buildAssignmentListWhere', () => {
  it('leaves the base predicate alone when there is no search term', () => {
    const built = buildAssignmentListWhere(undefined, ['mpg.gym_id = ?'], ['g1']);
    expect(built.where).toBe('mpg.gym_id = ?');
    expect(built.params).toEqual(['g1']);

    const blank = buildAssignmentListWhere('   ', ['mpg.gym_id = ?'], ['g1']);
    expect(blank.where).toBe('mpg.gym_id = ?');
    expect(blank.params).toEqual(['g1']);
  });

  it('matches the member, the goal name, the goal slug and the notes', () => {
    const built = buildAssignmentListWhere('weight', ['mpg.gym_id = ?'], ['g1']);
    expect(built.where).toContain('m.name LIKE ?');
    expect(built.where).toContain('pg.name LIKE ?');
    expect(built.where).toContain('pg.slug LIKE ?');
    expect(built.where).toContain('mpg.notes LIKE ?');
    expect(built.params).toEqual(['g1', '%weight%', '%weight%', '%weight%', '%weight%']);
  });

  it('does not mutate the arrays it is handed', () => {
    const base = ['mpg.gym_id = ?'];
    const params = ['g1'];
    buildAssignmentListWhere('x', base, params);
    expect(base).toEqual(['mpg.gym_id = ?']);
    expect(params).toEqual(['g1']);
  });
});
