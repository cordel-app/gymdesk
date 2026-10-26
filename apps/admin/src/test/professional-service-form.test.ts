import { describe, expect, it } from 'vitest';
import { capacityError, emptyForm, formErrorKey, formFor, matchesSearch, toPayload, type PsRow as BasePs } from '../components/professionalServices/psModel';

const row: BasePs = {
  id: 3, name: 'PT', description: 'One to one', max_capacity: 4,
  display_name: 'PT', display_description: 'One to one',
  created_at: null, created_by: null, modified_at: null, modified_by: null,
  translations: { es: { name: 'EP', description: null } },
};

describe('base professional service form (#1817)', () => {
  it('accepts only positive whole numbers (or empty)', () => {
    for (const ok of ['', ' ', '1', '12']) expect(capacityError(ok)).toBe(false);
    for (const bad of ['0', '-1', '1.5', 'abc']) expect(capacityError(bad)).toBe(true);
  });

  it('seeds the form from the row and builds the payload', () => {
    const f = formFor(row);
    expect(f.max_capacity).toBe('4');
    expect(f.texts.ca.name).toBe('');
    f.texts.ca.name = ' EP-ca ';
    expect(toPayload(f)).toEqual({
      name: 'PT', description: 'One to one', max_capacity: 4,
      translations: { es: { name: 'EP', description: null }, ca: { name: 'EP-ca', description: null } },
    });
  });

  it('sends a cleared capacity as null', () => {
    const f = emptyForm();
    expect(toPayload(f).max_capacity).toBeNull();
  });
});

describe('shared professional service form (#2110)', () => {
  it('requires every language for a Base service but only English for a gym service', () => {
    const f = emptyForm();
    f.texts.en.name = 'PT';
    expect(formErrorKey(f, true)).toBe('error_required_translations');
    expect(formErrorKey(f, false)).toBeNull();
    f.max_capacity = '0';
    expect(formErrorKey(f, false)).toBe('error_max_capacity');
    f.texts.en.name = ' ';
    expect(formErrorKey(f, false)).toBe('error_name_required');
  });

  it('searches the base text and every translation', () => {
    expect(matchesSearch(row, 'one to')).toBe(true);
    expect(matchesSearch(row, 'ep')).toBe(true);
    expect(matchesSearch(row, 'zzz')).toBe(false);
    expect(matchesSearch(row, '  ')).toBe(true);
  });
});
