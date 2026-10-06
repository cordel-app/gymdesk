// #1130 stage 1 — where the renewal flag comes from.
//
// The engine's half (`domain/planDuration.ts`) is covered by
// `plan-duration-auto-renew.unit.test.ts`. This file covers the other half, the
// thread's answer **A**: `auto_renew` is the **assignment's own** frozen value,
// captured from its Plan when the assignment is created and never written onto
// one that already exists.
//
// That distinction is the whole safety argument of the ticket. Migration 229
// backfills every existing row to 0, so no live assignment's billing moves on
// deploy — but `materialiseAssignedPlanSnapshot()` would undo exactly that if it
// captured the Plan's current flag, because it runs the first time staff edit
// any section of an assignment that never captured a snapshot. A twenty-month-old
// contract would then start a second Free / Pre-paid / Bonus cycle because
// somebody corrected a benefit quantity.
//
// `snapshotAssignedPlan()` takes a `Tx`, so this needs no database: a recording
// fake is enough to assert which statement is sent, which is the invariant
// (CLAUDE.md — a pure or injectable dependency is a unit test).

import { beforeEach, describe, expect, it } from 'vitest';
import { Tx } from '../infra/db';
import {
  materialiseAssignedPlanSnapshot,
  snapshotAssignedPlan,
} from '../api/assigned-plan-snapshot';

interface Call { sql: string; params: any[] }

/** The Plan row `snapshotAssignedPlan()`'s own SELECT resolves. */
let planRow: Record<string, unknown>;
/** 1 when the assignment already owns a snapshot — `hasAssignedPlanSnapshot()`. */
let captured: number;
let calls: Call[];

const tx: Tx = {
  async query(sql: string, params: any[] = []) {
    calls.push({ sql, params });
    if (sql.includes('AS captured')) return { rows: [{ captured }] } as any;
    if (sql.includes('FROM membership_plans p')) return { rows: [planRow] } as any;
    return { rows: [] } as any;
  },
};

const params = {
  gymId: 'gym-1', userMembershipId: 7, membershipPlanId: 42, membershipFeePrice: 70,
};

/** The one `UPDATE user_memberships` the snapshot writes. */
const updateCall = () => {
  const found = calls.find((c) => c.sql.includes('UPDATE user_memberships'));
  expect(found, 'the snapshot UPDATE was never sent').toBeTruthy();
  return found!;
};

beforeEach(() => {
  calls = [];
  captured = 0;
  planRow = {
    free_periods: 3, paid_periods: 12, bonus_periods: 2, pay_beforehand_periods: 12,
    recurring_billing_interval: 1, recurring_billing_unit: 'month', auto_renew: 1,
  };
});

describe('snapshotAssignedPlan — creating an assignment', () => {
  it('freezes the Plan\'s auto_renew onto the assignment', async () => {
    await snapshotAssignedPlan(tx, params);
    const call = updateCall();
    expect(call.sql).toContain('auto_renew = ?');
    // Positioned after the seven existing snapshot values and before the WHERE's
    // id/gym pair, so the UPDATE's parameters and its SET list stay in step.
    expect(call.params).toEqual([3, 12, 2, 12, 1, 'month', 70, 1, 7, 'gym-1']);
  });

  it('freezes a Plan whose Auto Renew is off as not renewing', async () => {
    planRow.auto_renew = 0;
    await snapshotAssignedPlan(tx, params);
    expect(updateCall().params).toEqual([3, 12, 2, 12, 1, 'month', 70, 0, 7, 'gym-1']);
  });

  // A Plan with no `billing_policies` row has no cadence to step a cycle by, so
  // there is nothing for a cycle to repeat on — `false`, not the column's own
  // `DEFAULT true`, which is what a missing join would otherwise suggest.
  it('does not renew a Plan that has no billing policy at all', async () => {
    planRow = { free_periods: null, paid_periods: null, bonus_periods: null };
    await snapshotAssignedPlan(tx, params);
    expect(updateCall().params).toEqual([null, null, null, null, null, null, 70, 0, 7, 'gym-1']);
  });

  it('writes nothing at all for an assignment with no Plan', async () => {
    await snapshotAssignedPlan(tx, { ...params, membershipPlanId: null });
    expect(calls).toEqual([]);
  });
});

describe('materialiseAssignedPlanSnapshot — an assignment that already exists', () => {
  it('captures the Plan\'s configuration without touching auto_renew', async () => {
    const wrote = await materialiseAssignedPlanSnapshot(tx, params);
    expect(wrote).toBe(true);
    const call = updateCall();
    // The durations, the cadence and the fee are written down — that is what
    // materialising is for (#635 stage 6) …
    expect(call.sql).toContain('free_periods = ?');
    // … and the renewal flag is not, because the row's stored value *is* what it
    // resolves today. Answer A: no live assignment's billing changes.
    expect(call.sql).not.toContain('auto_renew');
    expect(call.params).toEqual([3, 12, 2, 12, 1, 'month', 70, 7, 'gym-1']);
  });

  it('is a no-op for an assignment that already captured a snapshot', async () => {
    captured = 1;
    expect(await materialiseAssignedPlanSnapshot(tx, params)).toBe(false);
    expect(calls.some((c) => c.sql.includes('UPDATE user_memberships'))).toBe(false);
  });
});
