/**
 * #1822 — Cordel → Base Products: the pure rules.
 *
 * A base product is a template in `base_products` (a global table, no
 * `gym_id`) that `seedDefaultGymProducts()` copies into a newly created gym.
 * It carries exactly the configuration `defaultGymProducts.ts` declares, so
 * the validation here reuses that vocabulary (`OFFERED_PRODUCT_FREQUENCIES`)
 * and adds no second accepted set. `DEFAULT_GYM_PRODUCTS` stays as the mirror
 * of migration 298's seed; the table is what gym creation reads.
 */

import { OFFERED_PRODUCT_FREQUENCIES, type OfferedProductFrequency } from './productFrequency';
import type { DefaultGymProduct } from './defaultGymProducts';

export const BASE_PRODUCT_TYPES = ['fee', 'sessions'] as const;
export const BASE_PRODUCT_STATUSES = ['active', 'inactive'] as const;
export const BASE_PRODUCT_ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;

export const MAX_NAME_LENGTH = 150;
export const MAX_CHARGE_TYPE_CODE_LENGTH = 50;
const MAX_INT = 1_000_000;
const MAX_AMOUNT = 99_999_999.99;

export type BaseProductInput = {
  charge_type_code: string | null;
  name: string;
  type: (typeof BASE_PRODUCT_TYPES)[number];
  units: number | null;
  amount: number | null;
  billing_frequency: OfferedProductFrequency;
  status: (typeof BASE_PRODUCT_STATUSES)[number];
  enrollment_status: (typeof BASE_PRODUCT_ENROLLMENT_STATUSES)[number];
  mandatory: boolean;
  validity_days: number | null;
  one_time_purchase: boolean;
};

export type BaseProductRow = {
  id: number;
  charge_type_code: string | null;
  name: string;
  type: string;
  units: number | null;
  amount: number | string | null;
  billing_frequency: string;
  status: string;
  enrollment_status: string;
  mandatory: number | boolean;
  validity_days: number | null;
  one_time_purchase: number | boolean;
};

function positiveInt(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > MAX_INT) return undefined;
  return n;
}

function strictBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  return undefined;
}

/**
 * Judges a create body (every field) or, with `existing`, an update body (a
 * field the request does not mention keeps what the template holds, so a
 * partial `PUT` cannot reset the rest). Anything unsupported is a 400, never a
 * coercion — the string `"false"` is truthy, so a boolean must be a boolean.
 */
export function parseBaseProductInput(
  body: any,
  existing?: BaseProductInput,
): { value: BaseProductInput } | { error: string } {
  const src = body && typeof body === 'object' ? body : {};
  // On create an omitted field takes its default; `name` alone is required.
  const has = (k: string) => src[k] !== undefined || (existing === undefined && k === 'name');
  const out: BaseProductInput = existing
    ? { ...existing }
    : {
        charge_type_code: null, name: '', type: 'fee', units: null, amount: null,
        billing_frequency: 'once', status: 'active', enrollment_status: 'public',
        mandatory: false, validity_days: null, one_time_purchase: false,
      };

  if (has('name')) {
    if (typeof src.name !== 'string' || !src.name.trim()) return { error: 'name is required' };
    if (src.name.trim().length > MAX_NAME_LENGTH) return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
    out.name = src.name.trim();
  }
  if (has('charge_type_code')) {
    const v = src.charge_type_code;
    if (v === null || v === undefined || v === '') out.charge_type_code = null;
    else if (typeof v !== 'string' || v.trim().length > MAX_CHARGE_TYPE_CODE_LENGTH) return { error: 'charge_type_code must be a charge type code' };
    else out.charge_type_code = v.trim();
  }
  if (has('type')) {
    if (!(BASE_PRODUCT_TYPES as readonly string[]).includes(src.type)) return { error: `type must be one of: ${BASE_PRODUCT_TYPES.join(', ')}` };
    out.type = src.type;
  }
  if (has('units')) {
    const units = positiveInt(src.units);
    if (units === undefined) return { error: 'units must be a positive integer' };
    out.units = units;
  }
  if (has('amount')) {
    const v = src.amount;
    if (v === null || v === undefined || v === '') out.amount = null;
    else {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return { error: 'amount must be a non-negative number' };
      out.amount = Math.round(n * 100) / 100;
    }
  }
  if (has('billing_frequency')) {
    if (!(OFFERED_PRODUCT_FREQUENCIES as readonly string[]).includes(src.billing_frequency)) {
      return { error: `billing_frequency must be one of: ${OFFERED_PRODUCT_FREQUENCIES.join(', ')}` };
    }
    out.billing_frequency = src.billing_frequency;
  }
  if (has('status')) {
    if (!(BASE_PRODUCT_STATUSES as readonly string[]).includes(src.status)) return { error: `status must be one of: ${BASE_PRODUCT_STATUSES.join(', ')}` };
    out.status = src.status;
  }
  if (has('enrollment_status')) {
    if (!(BASE_PRODUCT_ENROLLMENT_STATUSES as readonly string[]).includes(src.enrollment_status)) {
      return { error: `enrollment_status must be one of: ${BASE_PRODUCT_ENROLLMENT_STATUSES.join(', ')}` };
    }
    out.enrollment_status = src.enrollment_status;
  }
  for (const key of ['mandatory', 'one_time_purchase'] as const) {
    if (has(key)) {
      const b = strictBoolean(src[key]);
      if (b === undefined) return { error: `${key} must be a boolean` };
      out[key] = b;
    }
  }
  if (has('validity_days')) {
    const days = positiveInt(src.validity_days);
    if (days === undefined) return { error: 'validity_days must be a positive integer' };
    out.validity_days = days;
  }

  if (out.type === 'sessions' && out.units === null) return { error: 'units is required for a sessions product' };
  if (out.type === 'fee' && out.units !== null) return { error: 'units is only valid for a sessions product' };
  return { value: out };
}

/** A stored template as the declaration `seedDefaultGymProducts()` consumes. */
export function toDefaultGymProduct(row: BaseProductRow): DefaultGymProduct {
  return {
    chargeTypeCode: row.charge_type_code,
    name: row.name,
    type: row.type === 'sessions' ? 'sessions' : 'fee',
    units: row.units === null ? null : Number(row.units),
    amount: row.amount === null ? null : Number(row.amount),
    billingFrequency: row.billing_frequency as OfferedProductFrequency,
    status: row.status === 'inactive' ? 'inactive' : 'active',
    enrollmentStatus: row.enrollment_status === 'staff_only' ? 'staff_only' : 'public',
    mandatory: Boolean(row.mandatory),
    oneTimePurchase: Boolean(row.one_time_purchase),
    validityDays: row.validity_days === null ? null : Number(row.validity_days),
  };
}
