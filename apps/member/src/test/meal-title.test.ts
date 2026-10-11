import { describe, expect, it } from 'vitest';
import { mealTitle } from '../lib/nutritionFood';

// A meal saved with no name stores its type's slug as `display_name`
// (`recien_levantado`). That is an identifier, so My Nutrition and Home show
// the translated meal type instead of "recien_levantado · Recién levantado".

describe('mealTitle', () => {
  it('shows the translated type alone when the name is the type\'s slug', () => {
    expect(mealTitle('recien_levantado', 'recien_levantado', 'Recién levantado'))
      .toEqual({ title: 'Recién levantado', suffix: null });
    expect(mealTitle('breakfast', 'breakfast', 'Desayuno')).toEqual({ title: 'Desayuno', suffix: null });
  });

  it('treats an empty name as no name', () => {
    expect(mealTitle('  ', 'breakfast', 'Desayuno')).toEqual({ title: 'Desayuno', suffix: null });
  });

  it('keeps a name staff chose, with the type beside it', () => {
    expect(mealTitle('Mi desayuno', 'breakfast', 'Desayuno')).toEqual({ title: 'Mi desayuno', suffix: 'Desayuno' });
  });

  it('does not repeat the type when the name already is its label', () => {
    expect(mealTitle('Desayuno', 'breakfast', 'Desayuno')).toEqual({ title: 'Desayuno', suffix: null });
  });

  it('falls back to the stored name when there is no type', () => {
    expect(mealTitle('Snack', null, null)).toEqual({ title: 'Snack', suffix: null });
  });
});
