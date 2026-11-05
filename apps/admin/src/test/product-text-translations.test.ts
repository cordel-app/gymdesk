import { describe, it, expect } from 'vitest';
import { applyProductTextValues, productTextValues } from '../app/[locale]/financials/products/productProfile';

const v = {
  name: 'Towel', description: 'Gym towel',
  tr: { es: { name: 'Toalla', description: 'Toalla de gimnasio' }, ca: { name: 'Tovallola', description: '' } },
};

describe('#2334 product text translations', () => {
  it('lists a field across every language, English being the base text', () => {
    expect(productTextValues(v, 'name')).toEqual({ en: 'Towel', es: 'Toalla', ca: 'Tovallola' });
    expect(productTextValues(v, 'description')).toEqual({ en: 'Gym towel', es: 'Toalla de gimnasio', ca: '' });
  });

  it('applies one field and keeps the other field and its translations', () => {
    const out = applyProductTextValues(v, 'name', { en: 'Big towel', es: 'Toalla grande', ca: '' });
    expect(out.name).toBe('Big towel');
    expect(out.description).toBe('Gym towel');
    expect(out.tr.es).toEqual({ name: 'Toalla grande', description: 'Toalla de gimnasio' });
    expect(out.tr.ca).toEqual({ name: '', description: '' });
  });
});
