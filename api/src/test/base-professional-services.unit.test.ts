import { describe, it, expect } from 'vitest';
import {
  parseBasePsTranslations,
  parseMaxCapacity,
  parseBaseName,
} from '../domain/baseProfessionalServices';

describe('base professional services rules (#1817)', () => {
  it('max_capacity: positive integers only; null/empty clears', () => {
    expect(parseMaxCapacity(8)).toEqual({ value: 8 });
    expect(parseMaxCapacity('12')).toEqual({ value: 12 });
    expect(parseMaxCapacity(null)).toEqual({ value: null });
    expect(parseMaxCapacity('')).toEqual({ value: null });
    for (const bad of [0, -3, 2.5, 'abc', '1.5', true, {}, 1e9]) {
      expect('error' in parseMaxCapacity(bad)).toBe(true);
    }
  });

  it('name is required and trimmed', () => {
    expect(parseBaseName('  PT  ')).toEqual({ value: 'PT' });
    expect('error' in parseBaseName('   ')).toBe(true);
    expect('error' in parseBaseName(undefined)).toBe(true);
  });

  it('translations need a name in es and ca, description optional, unknown locale refused', () => {
    const ok = parseBasePsTranslations({ es: { name: 'Entrenamiento', description: '' }, ca: { name: 'Entrenament' } });
    expect('value' in ok && ok.value.es.description).toBeNull();
    expect('error' in parseBasePsTranslations({ es: { name: 'x' } })).toBe(true);
    expect('error' in parseBasePsTranslations({ es: { name: 'x' }, ca: { name: ' ' } })).toBe(true);
    expect('error' in parseBasePsTranslations({ es: { name: 'x' }, ca: { name: 'y' }, fr: { name: 'z' } })).toBe(true);
  });
});
