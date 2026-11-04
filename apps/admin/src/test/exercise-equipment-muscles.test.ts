import { describe, expect, it } from 'vitest';
import {
  emptyExerciseForm, exerciseFormFromRow, sortMuscleKeys, MUSCLE_COLUMNS_STYLE,
} from '@/components/exercises/exerciseForm';

describe('exercise equipment and muscle layout (#2362)', () => {
  it('seeds the form from the row and defaults to none', () => {
    expect(emptyExerciseForm().equipment).toBe('');
    const row: any = { name: 'x', description: null, min_reps_default: null, max_reps_default: null, sets_default: null, rest_default_seconds: null, status: 'active', equipment: 'barbell' };
    expect(exerciseFormFromRow(row).equipment).toBe('barbell');
    expect(exerciseFormFromRow({ ...row, equipment: null }).equipment).toBe('');
  });
  it('sorts muscles alphabetically by label', () => {
    const labels: Record<string, string> = { quads: 'Quadriceps', back: 'Back', core: 'Abs' };
    expect(sortMuscleKeys(['quads', 'back', 'core'], (k) => labels[k])).toEqual(['core', 'back', 'quads']);
  });
  it('lays muscles out in three folding columns', () => {
    expect(MUSCLE_COLUMNS_STYLE.columns).toBe('3 170px');
  });
});
