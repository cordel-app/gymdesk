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
      name: 'PT', description: 'One to one', max_capacity: 4, min_participants: null,
      translations: { es: { name: 'EP', description: null }, ca: { name: 'EP-ca', description: null } },
    });
  });

  it('Unlimited sends no capacity and disables its validation (#2293)', () => {
    const f = formFor(row);
    f.unlimited = true;
    f.max_capacity = 'abc';
    expect(toPayload(f).max_capacity).toBeNull();
    expect(formErrorKey({ ...f, texts: { ...f.texts, en: { name: 'PT', description: '' } } }, false)).toBeNull();
  });

  it('validates Minimum Participants against a limited capacity (#2293)', () => {
    const f = formFor(row);
    f.min_participants = '5';
    expect(formErrorKey(f, false)).toBe('error_min_exceeds_capacity');
    f.min_participants = '0';
    expect(formErrorKey(f, false)).toBe('error_min_participants');
    f.min_participants = '4';
    expect(formErrorKey(f, false)).toBeNull();
    expect(toPayload(f).min_participants).toBe(4);
    f.unlimited = true;
    f.min_participants = '50';
    expect(formErrorKey(f, false)).toBeNull();
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
    f.unlimited = false;
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

describe('translations modal helpers (#2331)', () => {
  it('lists every supported language for a field and applies edits back', async () => {
    const { textValuesOf, applyTextValues } = await import('../components/professionalServices/psModel');
    const f = formFor(row);
    expect(textValuesOf(f.texts, 'name')).toEqual({ en: 'PT', es: 'EP', ca: '' });
    const next = applyTextValues(f, 'name', { en: 'PT2', es: 'EP', ca: 'CA' });
    expect(next.texts.ca.name).toBe('CA');
    expect(next.texts.en.description).toBe('One to one'); // other field untouched
    expect(f.texts.ca.name).toBe(''); // original not mutated (Cancel keeps saved values)
  });
});
