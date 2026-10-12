import { describe, expect, it } from 'vitest';
import {
  emptyExerciseForm,
  exerciseFormFromRow,
  trimmedDescriptionTranslations,
} from '../components/exercises/exerciseForm';

describe('#1419 exercise description translations in the form', () => {
  it('seeds the base short description and per-locale values from the row', () => {
    const form = exerciseFormFromRow({
      name: 'Bench Press', description: 'Full', short_description: 'Short',
      description_translations: { es: { short_description: 'Corta', description: null } }, min_reps_default: null, max_reps_default: null, sets_default: null,
      rest_default_seconds: null, status: 'active',
    } as any);
    expect(form.short_description).toBe('Short');
    expect(form.description_translations.es).toEqual({ short_description: 'Corta', description: '' });
  });

  it('an empty form carries empty maps', () => {
    const f = emptyExerciseForm();
    expect(f.short_description).toBe('');
    expect(f.description_translations).toEqual({});
  });

  it('submits only locales with something typed, trimmed', () => {
    expect(trimmedDescriptionTranslations({
      es: { short_description: ' hola ', description: '' },
      ca: { short_description: '  ', description: '' },
    })).toEqual({ es: { short_description: 'hola', description: '' } });
  });
});
