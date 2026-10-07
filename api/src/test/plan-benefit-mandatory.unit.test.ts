import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PLAN_BENEFIT_MANDATORY, parsePlanBenefitMandatoryInput, toPlanBenefitMandatory,
} from '../domain/planBenefitMandatory';

// #1184 stage 2 — a Plan benefit's own Mandatory Yes/No.
describe('toPlanBenefitMandatory()', () => {
  it('reads mysql2 0/1 and booleans, defaulting to mandatory', () => {
    expect(toPlanBenefitMandatory(1)).toBe(true);
    expect(toPlanBenefitMandatory(0)).toBe(false);
    expect(toPlanBenefitMandatory(false)).toBe(false);
    expect(toPlanBenefitMandatory(undefined)).toBe(DEFAULT_PLAN_BENEFIT_MANDATORY);
    expect(DEFAULT_PLAN_BENEFIT_MANDATORY).toBe(true);
  });
});

describe('parsePlanBenefitMandatoryInput()', () => {
  it('keeps what is stored when the request names none', () => {
    expect(parsePlanBenefitMandatoryInput({ product_id: 1, quantity: 1 })).toEqual({ keep: true });
    expect(parsePlanBenefitMandatoryInput({ mandatory: null })).toEqual({ keep: true });
  });
  it('sets an explicit boolean, false included', () => {
    expect(parsePlanBenefitMandatoryInput({ mandatory: false })).toEqual({ keep: false, mandatory: false });
    expect(parsePlanBenefitMandatoryInput({ mandatory: true })).toEqual({ keep: false, mandatory: true });
  });
  it('refuses anything else instead of coercing it', () => {
    expect(parsePlanBenefitMandatoryInput({ mandatory: 'false' }).error).toBeDefined();
    expect(parsePlanBenefitMandatoryInput({ mandatory: 2 }).error).toBeDefined();
  });
});

describe('migration 237 and the writers', () => {
  const root = join(__dirname, '..');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const migration = require('../infra/migrations/237_plan_benefit_mandatory.js');
  it('covers the Plan side and the Assigned Plan snapshot side', () => {
    expect(migration.TABLES).toEqual([
      'membership_plan_session', 'membership_plan_oneoff', 'membership_plan_periodical',
      'user_membership_session', 'user_membership_oneoff', 'user_membership_periodical',
    ]);
  });
  it('is copied by the snapshot, the section edit and Duplicate', () => {
    const snapshot = readFileSync(join(root, 'api', 'assigned-plan-snapshot.ts'), 'utf-8');
    const plans = readFileSync(join(root, 'api', 'membership-plans.ts'), 'utf-8');
    expect(snapshot).toContain('b.mandatory');
    expect(snapshot).toContain('previous.mandatory');
    expect(plans).toContain('parsePlanBenefitMandatoryInput');
    expect(plans).toContain('mandatory${sessionFrequency');
  });
});
