import { describe, expect, it } from 'vitest';
import {
  effectiveTarget, normalizeTargetType, normalizeTargetValue, targetPairError,
} from '../domain/goalTarget';
import { summarizeReadings, type GoalReading } from '../domain/goalReadings';

const r = (id: number, value: number, day: number, isInitial = false): GoalReading => ({
  id, value, recordedAt: Date.UTC(2026, 0, day), isInitial,
});

describe('#1229 target type', () => {
  it('accepts the two types, keeps an absent one and refuses the rest', () => {
    expect(normalizeTargetType(undefined)).toEqual({ value: undefined });
    expect(normalizeTargetType('relative')).toEqual({ value: 'relative' });
    expect('error' in normalizeTargetType('percent')).toBe(true);
  });

  it('refuses a negative value unless negatives are allowed, and then only for relative', () => {
    expect('error' in normalizeTargetValue(-5)).toBe(true);
    expect(normalizeTargetValue(-5, { allowNegative: true })).toEqual({ value: -5 });
    expect(targetPairError({ targetValue: -5, targetUnit: 'kg', targetType: 'relative' })).toBeNull();
    expect(targetPairError({ targetValue: -5, targetUnit: 'kg', targetType: 'absolute' })).not.toBeNull();
    expect(targetPairError({ targetValue: -5, targetUnit: 'kg' })).not.toBeNull();
  });

  it('computes the effective target: absolute as is, relative from the baseline', () => {
    expect(effectiveTarget({ targetType: 'absolute', targetValue: 80, baseline: 78 })).toBe(80);
    expect(effectiveTarget({ targetType: 'relative', targetValue: 2, baseline: 78 })).toBe(80);
    expect(effectiveTarget({ targetType: 'relative', targetValue: -5, baseline: 78 })).toBe(73);
    expect(effectiveTarget({ targetType: 'relative', targetValue: 0, baseline: 78 })).toBe(78);
    expect(effectiveTarget({ targetType: 'relative', targetValue: 2, baseline: null })).toBeNull();
    expect(effectiveTarget({ targetType: 'relative', targetValue: null, baseline: 78 })).toBeNull();
  });

  it('measures progress against the effective target', () => {
    const s = summarizeReadings([r(1, 78, 1, true), r(2, 79, 2)], 2, 'relative');
    expect(s.effective_target).toBe(80);
    expect(s.progress_percent).toBe(50);
    const loss = summarizeReadings([r(1, 78, 1, true), r(2, 75.5, 2)], -5, 'relative');
    expect(loss.effective_target).toBe(73);
    expect(loss.progress_percent).toBe(50);
  });

  it('keeps the baseline fixed when a later initial reading is set', () => {
    const s = summarizeReadings([r(1, 78, 1, true), r(2, 76, 5, true)], -5, 'relative');
    expect(s.effective_target).toBe(73);
  });

  it('has no effective target for a relative goal without readings', () => {
    expect(summarizeReadings([], 2, 'relative').effective_target).toBeNull();
    expect(summarizeReadings([], 80, 'absolute').effective_target).toBe(80);
    expect(summarizeReadings([r(1, 78, 1)], 80).progress_percent).toBe(0);
  });
});
