// #1694 stage 2 — migration 297 deletes the cancelled assignments that have no
// end date, and only those; it keeps their payment requests and ProductSets and
// audits each deletion. Run against real MySQL, scoped to this file's gyms
// because other test files share the database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory, { type Knex } from 'knex';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, legacyAssignmentQuery } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../infra/migrations/297_delete_cancelled_assignments_without_end_date.js');

let knex: Knex;
let gymId: string;
let otherGymId: string;
let memberId: number;
let planId: number;
let otherMemberId: number;
let otherPlanId: number;

async function assignment(gym: string, status: string, endsAt: string | null): Promise<number> {
  const { insertId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price)
     VALUES (?, ?, ?, ?, '2026-01-01', ?, 29.99)`,
    [gym, gym === gymId ? memberId : otherMemberId, gym === gymId ? planId : otherPlanId, status, endsAt],
  );
  return insertId;
}
async function exists(id: number): Promise<boolean> {
  const { rows } = await db.query('SELECT id FROM user_memberships WHERE id = ?', [id]);
  return rows.length === 1;
}

const run = (gyms: string[]) =>
  knex.transaction((trx) => migration.deleteCancelledWithoutEndDate(trx, { gymIds: gyms }));

beforeAll(async () => {
  knex = knexFactory({ client: 'mysql2', connection: process.env.DATABASE_URL });
  gymId = await createTestGym('Cleanup 1694');
  otherGymId = await createTestGym('Cleanup 1694 other');
  for (const g of [gymId, otherGymId]) {
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [g, 'Cleanup Member', `c1694-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`]);
    const p = await db.query(
      "INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit) VALUES (?, ?, 'active', 'public', '1')",
      [g, `C1694-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`]);
    if (g === gymId) { memberId = m.insertId; planId = p.insertId; } else { otherMemberId = m.insertId; otherPlanId = p.insertId; }
  }
});

afterAll(async () => {
  await knex.destroy();
  await cleanupTestGyms();
  await db.end();
});

describe('migration 297 — cancelled assignments without an end date (#1694)', () => {
  it('deletes only cancelled rows with ends_at NULL, keeps payment requests, audits each delete, and is re-runnable', async () => {
    const target = await assignment(gymId, 'cancelled', null);
    const cancelledWithEnd = await assignment(gymId, 'cancelled', '2026-02-01');
    const keep = await Promise.all(['active', 'paused', 'draft', 'expired', 'pending_payment']
      .map((s) => assignment(gymId, s, null)));
    const otherGym = await assignment(otherGymId, 'cancelled', null);

    const pr = await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, user_membership_id, amount, status, source)
       VALUES (?, ?, ?, 29.99, 'completed', 'admin')`,
      [gymId, memberId, target],
    );

    const result = await run([gymId]);
    expect(result).toEqual({ counted: 1, deleted: 1, detached: 1 });

    expect(await exists(target)).toBe(false);
    expect(await exists(cancelledWithEnd)).toBe(true);
    for (const id of keep) expect(await exists(id)).toBe(true);
    expect(await exists(otherGym)).toBe(true); // outside the scope this run was given

    const { rows: prRows } = await db.query('SELECT user_membership_id, amount FROM payment_requests WHERE id = ?', [pr.insertId]);
    expect(prRows).toHaveLength(1);
    expect(prRows[0].user_membership_id).toBeNull();

    const { rows: audit } = await db.query(
      "SELECT previous_values, source FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ? AND action = 'delete'",
      [gymId, String(target)],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].source).toBe('system');
    const previous = typeof audit[0].previous_values === 'string' ? JSON.parse(audit[0].previous_values) : audit[0].previous_values;
    expect(previous.status).toBe('cancelled');

    expect(await run([gymId])).toEqual({ counted: 0, deleted: 0, detached: 0 });
    expect(await exists(cancelledWithEnd)).toBe(true);
  });
});
