import { describe, it, expect } from 'vitest';
import {
  EXERCISE_CATEGORIES, CATEGORY_RESULT_TYPE_SLUGS, normalizeExerciseCategory,
  parseExerciseCategoryInput, resultTypeSlugsForCategory, classifyStoredCategory,
} from '../domain/exerciseCategories';

describe('exercise categories (#1360)', () => {
  it('maps every category to the ticket metrics', () => {
    expect(EXERCISE_CATEGORIES).toHaveLength(7);
    expect(CATEGORY_RESULT_TYPE_SLUGS.stretching).toEqual(['duration']);
    expect(CATEGORY_RESULT_TYPE_SLUGS.strongman).toEqual(['repetitions', 'weight', 'distance', 'duration']);
    expect(resultTypeSlugsForCategory(' CARDIO ')).toEqual(['distance', 'duration', 'pace', 'speed', 'calories']);
  });
  it('normalizes case and whitespace, and never guesses', () => {
    expect(normalizeExerciseCategory('  Olympic Weightlifting ')).toBe('olympic weightlifting');
    expect(normalizeExerciseCategory('   ')).toBeNull();
    expect(resultTypeSlugsForCategory('yoga')).toBeNull();
    expect(resultTypeSlugsForCategory(null)).toBeNull();
  });
  it('parses request input: absent keeps, null clears, unknown is a 400', () => {
    expect(parseExerciseCategoryInput({})).toEqual({ provided: false, value: null });
    expect(parseExerciseCategoryInput({ category: null })).toEqual({ provided: true, value: null });
    expect(parseExerciseCategoryInput({ category: 'Strength' })).toEqual({ provided: true, value: 'strength' });
    expect(parseExerciseCategoryInput({ category: 'yoga' }).error).toMatch(/category must be one of/);
    expect(parseExerciseCategoryInput({ category: 5 }).error).toBeDefined();
  });
  it('classifies stored values for the audit', () => {
    expect(classifyStoredCategory('strength').issue).toBe('valid');
    expect(classifyStoredCategory('Strength ').issue).toBe('valid_after_normalization');
    expect(classifyStoredCategory('olympic-weightlifting').issue).toBe('spelling_variant');
    expect(classifyStoredCategory('').issue).toBe('missing');
    expect(classifyStoredCategory(null).issue).toBe('missing');
    expect(classifyStoredCategory('yoga').issue).toBe('unsupported');
  });
});
