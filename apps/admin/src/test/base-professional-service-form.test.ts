import { describe, expect, it } from 'vitest';
import { capacityError, emptyForm, formFor, toPayload, type BasePs } from '../app/[locale]/cordel/base-professional-services/baseProfessionalServiceForm';

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
