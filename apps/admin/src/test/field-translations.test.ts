import { describe, it, expect } from 'vitest';
import { translationValues } from '@/components/exercises/FieldTranslationsModal';

const src = {
  name: 'Bench Press', short_description: 'Chest', description: 'Long',
  translations: { es: 'Press de banca' },
  description_translations: { es: { short_description: 'Pecho', description: 'Largo' } },
};

describe('translationValues (#2300)', () => {
  it('puts the base locale first from the entity column and adds stored translations', () => {
    expect(translationValues('name', 'en', src)).toEqual({ en: 'Bench Press', es: 'Press de banca' });
    expect(translationValues('short_description', 'en', src)).toEqual({ en: 'Chest', es: 'Pecho' });
    expect(translationValues('description', 'en', src)).toEqual({ en: 'Long', es: 'Largo' });
  });
});
