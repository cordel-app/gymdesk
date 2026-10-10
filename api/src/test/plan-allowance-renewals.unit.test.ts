import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dueRenewals, minusDays, FIRST_RUN_CATCH_UP_DAYS } from '../domain/planAllowanceRenewals';
import { renewalDatesThrough } from '../domain/sessionBenefitFrequency';

const line = (over: Partial<Parameters<typeof dueRenewals>[0]> = {}) => ({
  line_id: 7,
  starts_at: '2026-09-01',
  ends_at: null,
  frequency: 'week' as const,
  quantity: 2,
  last_renewal_date: null,
  ...over,
});

describe('renewalDatesThrough', () => {
  it('excludes the anchor and steps weekly', () => {
    expect(renewalDatesThrough('2026-09-01', '2026-09-01', '2026-09-22', 'week'))
      .toEqual(['2026-09-08', '2026-09-15', '2026-09-22']);
  });
  it('honours the lower bound', () => {
    expect(renewalDatesThrough('2026-09-01', '2026-09-08', '2026-09-22', 'week'))
      .toEqual(['2026-09-15', '2026-09-22']);
  });
  it('is empty for once and for no frequency', () => {
    expect(renewalDatesThrough('2026-09-01', '2026-09-01', '2027-01-01', 'once')).toEqual([]);
    expect(renewalDatesThrough('2026-09-01', '2026-09-01', '2027-01-01', null)).toEqual([]);
  });
  it('steps four weeks as 28 days, never a month', () => {
    expect(renewalDatesThrough('2026-09-01', '2026-09-01', '2026-11-01', 'four_weeks'))
      .toEqual(['2026-09-29', '2026-10-27']);
  });
});

describe('dueRenewals', () => {
  it('continues from the last renewal written, however long the gap', () => {
    const due = dueRenewals(line({ last_renewal_date: '2026-09-08' }), '2026-10-01');
    expect(due.map((d) => d.renewal_date)).toEqual(['2026-09-15', '2026-09-22', '2026-09-29']);
    expect(due.every((d) => d.quantity === 2 && d.line_id === 7)).toBe(true);
  });
  it('only catches up a week for a line with no renewal yet', () => {
    const due = dueRenewals(line(), '2026-10-01');
    expect(due.map((d) => d.renewal_date)).toEqual(['2026-09-29']);
    expect(minusDays('2026-10-01', FIRST_RUN_CATCH_UP_DAYS)).toBe('2026-09-24');
  });
  it('stops at the assignment end date', () => {
    const due = dueRenewals(line({ last_renewal_date: '2026-09-08', ends_at: '2026-09-16' }), '2026-10-01');
    expect(due.map((d) => d.renewal_date)).toEqual(['2026-09-15']);
  });
  it('is idempotent once everything is written', () => {
    expect(dueRenewals(line({ last_renewal_date: '2026-09-29' }), '2026-10-01')).toEqual([]);
  });
  it('owes nothing for a zero quantity or a non-renewing frequency', () => {
    expect(dueRenewals(line({ quantity: 0, last_renewal_date: '2026-09-01' }), '2026-10-01')).toEqual([]);
    expect(dueRenewals(line({ frequency: 'once', last_renewal_date: '2026-09-01' }), '2026-10-01')).toEqual([]);
  });
});

describe('wiring', () => {
  const root = join(__dirname, '..', '..', '..');
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  it('the plan_session grant adds the renewal rows to the line quantity', () => {
    expect(read('api/src/domain/memberProfessionalServices.ts')).toContain('FROM plan_allowance_renewals par');
  });
  it('the run is a step of the billing workflow and relayed', () => {
    expect(read('.github/workflows/billing-run.yml')).toContain('$API_BASE_URL/plan-allowance-renewals/run"');
    expect(read('apps/admin/src/lib/internalRunRelay.ts')).toContain("'/plan-allowance-renewals/run'");
  });
  it('inserts are idempotent and claim no run-log slot', () => {
    const code = read('api/src/api/plan-allowance-renewals.ts');
    expect(code).toContain('INSERT IGNORE INTO plan_allowance_renewals');
    expect(code).not.toMatch(/claimRun\(/);
  });
});
