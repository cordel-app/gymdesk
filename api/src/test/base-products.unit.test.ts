import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_GYM_PRODUCTS } from '../domain/defaultGymProducts';
import { parseBaseProductInput, toDefaultGymProduct } from '../domain/baseProducts';

const valid = { name: 'X', type: 'fee', amount: 5, billing_frequency: 'once', status: 'active', enrollment_status: 'public' };

describe('base products rules (#1822)', () => {
  it('migration 298 seeds exactly the declared defaults', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../infra/migrations/298_base_products.js'), 'utf8');
    expect((sql.match(/^\s+\[(null|'[a-z_]+'), '/gm) ?? []).length).toBe(DEFAULT_GYM_PRODUCTS.length);
    for (const p of DEFAULT_GYM_PRODUCTS) {
      const code = p.chargeTypeCode === null ? 'null' : `'${p.chargeTypeCode}'`;
      const amount = p.amount === null ? 'null' : String(p.amount);
      const units = p.units === null ? 'null' : String(p.units);
      expect(sql).toContain(
        `[${code}, '${p.name}', '${p.type}', ${units}, ${amount}, '${p.billingFrequency}', '${p.status}', '${p.enrollmentStatus}', ${p.mandatory ? 1 : 0}, ${p.validityDays ?? 'null'}, ${p.oneTimePurchase ? 1 : 0}]`,
      );
    }
  });

  it('judges a create body and keeps unmentioned fields on update', () => {
    const created = parseBaseProductInput(valid);
    expect('value' in created && created.value.mandatory).toBe(false);
    if (!('value' in created)) throw new Error('unreachable');
    const updated = parseBaseProductInput({ amount: 9 }, created.value);
    expect('value' in updated && updated.value).toMatchObject({ name: 'X', amount: 9 });
  });

  it('refuses retired frequencies, string booleans and a units/type mismatch', () => {
    for (const bad of [{ billing_frequency: 'week' }, { mandatory: 'false' }, { type: 'sessions' }, { units: 3 }, { amount: -2 }]) {
      expect('error' in parseBaseProductInput({ ...valid, ...bad })).toBe(true);
    }
  });

  it('maps a stored row back to the seeder declaration', () => {
    for (const p of DEFAULT_GYM_PRODUCTS) {
      const row = {
        id: 1, charge_type_code: p.chargeTypeCode, name: p.name, type: p.type, units: p.units,
        amount: p.amount === null ? null : String(p.amount), billing_frequency: p.billingFrequency,
        status: p.status, enrollment_status: p.enrollmentStatus, mandatory: p.mandatory ? 1 : 0,
        validity_days: p.validityDays, one_time_purchase: p.oneTimePurchase ? 1 : 0,
      };
      expect(toDefaultGymProduct(row)).toEqual(p);
    }
  });
});
