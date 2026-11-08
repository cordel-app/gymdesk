import { describe, it, expect } from 'vitest';
import { parseExerciseEquipmentInput, EXERCISE_EQUIPMENT_MAX_LENGTH } from '../domain/exerciseEquipment';

describe('exercise equipment input (#2362)', () => {
  it('keeps the stored value when the field is absent', () => {
    expect(parseExerciseEquipmentInput({})).toEqual({ provided: false, value: null });
    expect(parseExerciseEquipmentInput(undefined).provided).toBe(false);
  });
  it('clears on null or blank', () => {
    expect(parseExerciseEquipmentInput({ equipment: null })).toEqual({ provided: true, value: null });
    expect(parseExerciseEquipmentInput({ equipment: '   ' })).toEqual({ provided: true, value: null });
  });
  it('trims and stores a string', () => {
    expect(parseExerciseEquipmentInput({ equipment: ' barbell ' })).toEqual({ provided: true, value: 'barbell' });
  });
  it('rejects non-strings and over-wide values', () => {
    expect(parseExerciseEquipmentInput({ equipment: 5 }).error).toBeTruthy();
    expect(parseExerciseEquipmentInput({ equipment: 'x'.repeat(EXERCISE_EQUIPMENT_MAX_LENGTH + 1) }).error).toBeTruthy();
  });
});
