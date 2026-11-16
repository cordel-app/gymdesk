import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  newProductFormValues,
  productFormErrorKey,
  toProductFormValues,
  toProductPayload,
  type ProductFormValues,
} from '../app/[locale]/financials/products/productProfile';
import { readProductsPageSource } from './productsSource';

// #2948 — `+ Add Product` opens the Edit Product form: the same layout, the
// same controls, the same validation and the same payload.

const PAGE = join(__dirname, '..', 'app', '[locale]', 'financials', 'products', 'page.tsx');
const pageSrc = readProductsPageSource(PAGE);

describe('one form for creating and editing a Product (#2948)', () => {
  it('starts a new product with a value for every field the editor binds', () => {
    const blank = newProductFormValues();
    const fromRow = toProductFormValues({
      name: '', type: 'fee', units: null, description: null, amount: null, billing_frequency: null,
      status: 'active', enrollment_status: 'public', notes: null, package_information: null,
      validity_days: null, tax_rate_id: null, mandatory: 0,
    });
    // Same keys as the editor's form, and the API's own defaults for a new row.
    expect(Object.keys(blank).sort()).toEqual(Object.keys(fromRow).sort());
    expect(blank).toMatchObject({
      type: 'fee', status: 'active', enrollment_status: 'public', sharing_type: 'individual',
      mandatory: false, one_time_purchase: false, one_per_member: false, professionalServiceIds: [],
    });
  });

  it('validates the create card and the editor with the one rule', () => {
    const form: ProductFormValues = { ...newProductFormValues(), name: 'Towel' };
    expect(productFormErrorKey(form, { isSystem: false })).toBeNull();
    expect(productFormErrorKey({ ...form, name: '  ' }, { isSystem: false })).toBe('error_name_required');
    // A System row's name is frozen and not submitted, so it is not required there.
    expect(productFormErrorKey({ ...form, name: '' }, { isSystem: true })).toBeNull();
    for (const units of ['0', '-1', '1.5', 'x']) {
      expect(productFormErrorKey({ ...form, units }, { isSystem: false }), units).toBe('error_units_positive');
    }
    expect(productFormErrorKey({ ...form, units: '10' }, { isSystem: false })).toBeNull();
  });

  it('submits every configured field on create, exactly as on edit', () => {
    const form: ProductFormValues = {
      ...newProductFormValues(),
      name: ' 10-Class Pack ', type: 'sessions', units: '10', description: 'Ten classes',
      amount: '90', billing_frequency: 'once', status: 'inactive', enrollment_status: 'staff_only',
      notes: 'n', package_information: 'p', validity_days: '60', tax_rate_id: '7',
      mandatory: true, one_time_purchase: true, one_per_member: true, professionalServiceIds: [3],
    };
    expect(toProductPayload(form, 'sessions')).toEqual({
      name: '10-Class Pack', type: 'sessions', units: 10, description: 'Ten classes',
      translations: { es: { name: '', description: null }, ca: { name: '', description: null } },
      amount: 90, billing_frequency: 'once', status: 'inactive', enrollment_status: 'staff_only',
      notes: 'n', package_information: 'p', validity_days: 60, tax_rate_id: 7,
      mandatory: true, one_time_purchase: true, one_per_member: true,
      // #2662: linked to a Professional Service, so always Family.
      sharing_type: 'shared',
      professional_service_ids: [3],
    });
    // Professional Services only travel for a Session-type product (#546).
    expect(toProductPayload({ ...form, type: 'fee' }, 'sessions').professional_service_ids).toBeUndefined();
  });

  it('renders the create card through the same layout and controls as the editor', () => {
    expect((pageSrc.match(/<ProductLayout/g) ?? []).length).toBe(2);
    expect(pageSrc).toMatch(/renderFormControl\(\s*field,\s*inlineNew,/);
    expect(pageSrc).toMatch(/renderFormControl\(\s*field,\s*editForm,/);
    expect(pageSrc).toContain('toProductPayload(inlineNew, SESSION_TYPE)');
    expect(pageSrc).toContain('toProductPayload(editForm, SESSION_TYPE)');
    // No second, reduced create grid.
    expect(pageSrc).not.toContain("gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr'");
  });
});
