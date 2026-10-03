// #956 / migration 213 — the data sweep, exercised against the real migration.
//
// The sweep cancels the live assignments a Member holds beyond their current
// one, because the restored UNIQUE index on `active_member_key` cannot be
// created while two active rows share an owner. It is the one destructive step
// in this ticket, so it is tested rather than taken on trust: which row
// survives, what the cancelled ones are stamped with, and that a Member with a
// single live plan is left completely alone.
//
// Mechanics: the index is dropped in `beforeAll` so the violating state can be
// seeded at all, and restored in `afterAll` by the migration's own `up()`.
// `fileParallelism: false` (vitest.config.ts) is what makes that safe — no other
// test file is running while this one holds the schema open.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { buildMultiActiveReport } from '../scripts/report-multi-active-memberships';

const require = createRequire(import.meta.url);
const migration = require('../infra/migrations/213_one_active_membership_plan.js');

// The migration only ever calls `knex.raw(sql, params)` and destructures
// `[rows]` from it, so the pool speaks that dialect with four lines.
const knex = {
  raw: async (sql: string, params: any[] = []) => {
    const { rows } = await db.query(sql, params);
    return [rows] as [any[]];
  },
};

const INDEX = 'user_memberships_one_active';

async function indexExists(name: string): Promise<boolean> {
  const { rows } = await db.query('SHOW INDEX FROM user_memberships WHERE Key_name = ?', [name]);
  return rows.length > 0;
}

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Migration 213 Gym');
  if (await indexExists(INDEX)) {
    await db.query(`ALTER TABLE user_memberships DROP INDEX ${INDEX}`);
  }
});

// Each case calls the migration, which puts the index back, so the next case
// needs it out of the way again before it can seed a violating Member.
beforeEach(async () => {
  if (await indexExists(INDEX)) {
    await db.query(`ALTER TABLE user_memberships DROP INDEX ${INDEX}`);
  }
});

afterAll(async () => {
  // Leave the schema as the migration leaves it, whatever happened above.
  await migration.up(knex);
  await cleanupTestGyms();
  await db.end();
});

async function createPlan(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `${name}-${Math.random().toString(36).slice(2, 7)}`],
  );
  return insertId;
}

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M213 Member', `m213-${Math.random().toString(36).slice(2, 9)}@test.com`],
  );
  return insertId;
}

async function seedAssignment(
  memberId: number, planId: number, status: string, startsAt: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, ?, ?, 30)`,
    [gymId, memberId, planId, status, startsAt],
  );
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, insertId, memberId],
  );
  return insertId;
}

async function read(id: number) {
  const { rows } = await db.query(
    `SELECT status, closed_at, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at
     FROM user_memberships WHERE id = ?`,
    [id],
  );
  return rows[0];
}

describe('migration 213 — the sweep', () => {
  it('keeps the latest active row, cancels the rest and dates them at the keeper\'s start', async () => {
    const memberId = await createMember();
    const older = await seedAssignment(memberId, await createPlan('M213 Older'), 'active', '2026-01-01');
    const oldest = await seedAssignment(memberId, await createPlan('M213 Oldest'), 'active', '2025-06-01');
    const current = await seedAssignment(memberId, await createPlan('M213 Current'), 'active', '2026-06-01');

    await migration.up(knex);

    expect(await read(current)).toMatchObject({ status: 'active' });
    for (const id of [older, oldest]) {
      const row = await read(id);
      expect(row.status).toBe('cancelled');
      // The same shape a replacement made through the API leaves behind.
      expect(row.ends_at).toBe('2026-06-01');
      expect(row.closed_at).not.toBeNull();
    }
  });

  it('prefers an active row over a paused one even when the paused one is newer', async () => {
    const memberId = await createMember();
    const active = await seedAssignment(memberId, await createPlan('M213 Active'), 'active', '2026-01-01');
    const newerPaused = await seedAssignment(memberId, await createPlan('M213 Paused'), 'paused', '2026-09-01');

    await migration.up(knex);

    // Cancelling the active row and keeping the paused one would leave the
    // Member with no plan that bills — hence the status-first ordering.
    expect((await read(active)).status).toBe('active');
    expect((await read(newerPaused)).status).toBe('cancelled');
  });

  it('separates two rows that tie on status and start date by id, rather than at random', async () => {
    const memberId = await createMember();
    const first = await seedAssignment(memberId, await createPlan('M213 Tie A'), 'active', '2026-04-01');
    const second = await seedAssignment(memberId, await createPlan('M213 Tie B'), 'active', '2026-04-01');

    await migration.up(knex);

    expect((await read(second)).status).toBe('active');
    expect((await read(first)).status).toBe('cancelled');
  });

  it('appends a status_changed ledger row for every row it cancels', async () => {
    const memberId = await createMember();
    const swept = await seedAssignment(memberId, await createPlan('M213 Ledger Old'), 'paused', '2026-01-01');
    await seedAssignment(memberId, await createPlan('M213 Ledger New'), 'active', '2026-05-01');

    await migration.up(knex);

    const { rows } = await db.query(
      `SELECT previous_status, new_status, source FROM billing_events
       WHERE user_membership_id = ? AND event_type = 'status_changed' ORDER BY id DESC LIMIT 1`,
      [swept],
    );
    expect(rows[0]).toMatchObject({ previous_status: 'paused', new_status: 'cancelled', source: 'system' });
  });

  it('leaves a Member with one live plan, and their cancelled history, untouched', async () => {
    const memberId = await createMember();
    const live = await seedAssignment(memberId, await createPlan('M213 Only'), 'active', '2026-02-01');
    const history = await seedAssignment(memberId, await createPlan('M213 History'), 'expired', '2025-01-01');

    await migration.up(knex);

    expect(await read(live)).toMatchObject({ status: 'active', closed_at: null, ends_at: null });
    expect(await read(history)).toMatchObject({ status: 'expired', closed_at: null });
  });

  it('is idempotent, and leaves the one-active-per-member index in place', async () => {
    const memberId = await createMember();
    const older = await seedAssignment(memberId, await createPlan('M213 Idem Old'), 'active', '2026-01-01');
    const current = await seedAssignment(memberId, await createPlan('M213 Idem New'), 'active', '2026-07-01');

    await migration.up(knex);
    const afterFirst = await read(older);
    await migration.up(knex);

    expect(await read(older)).toEqual(afterFirst);
    expect((await read(current)).status).toBe('active');
    expect(await indexExists(INDEX)).toBe(true);
    expect(await indexExists('user_memberships_one_active_per_plan')).toBe(false);
  });
});

// ─── The report that identifies them (npm run memberships:multi-active) ──────
//
// #956 asks that the Members violating the new rule be identified *before*
// anything is cancelled, so this is what to run ahead of migration 213. It
// lives in this file because it needs the same violating state, and therefore
// the same index gymnastics.

describe('buildMultiActiveReport', () => {
  it('names each owned conflict with the row the migration would keep', async () => {
    const memberId = await createMember();
    const older = await seedAssignment(memberId, await createPlan('Report Older'), 'active', '2026-01-01');
    const current = await seedAssignment(memberId, await createPlan('Report Current'), 'active', '2026-08-01');

    const report = await buildMultiActiveReport();
    const group = report.owned.find((g) => g.member_id === memberId);
    expect(group).toBeDefined();
    expect(group!.assignments.map((a) => a.user_membership_id)).toEqual([current, older]);
    expect(group!.assignments.map((a) => a.keeper)).toEqual([true, false]);
    expect(group!.assignments[0].membership_plan_name).toContain('Report Current');
  });

  it('leaves a Member with one live plan out of the report entirely', async () => {
    const memberId = await createMember();
    await seedAssignment(memberId, await createPlan('Report Single'), 'active', '2026-01-01');
    await seedAssignment(memberId, await createPlan('Report Dead'), 'cancelled', '2025-01-01');

    const report = await buildMultiActiveReport();
    expect(report.owned.some((g) => g.member_id === memberId)).toBe(false);
    expect(report.covered.some((g) => g.member_id === memberId)).toBe(false);
  });

  it('reports a Member covered by two live plans separately, since the sweep leaves those', async () => {
    // The overlap the restored index cannot express: the co-member owns
    // neither row, so `active_member_key` never collides and migration 213
    // deliberately does not cancel a family plan on their behalf.
    const owner = await createMember();
    const coMember = await createMember();
    const family = await seedAssignment(owner, await createPlan('Report Family'), 'active', '2026-01-01');
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, family, coMember],
    );
    const own = await seedAssignment(coMember, await createPlan('Report Own'), 'active', '2026-05-01');

    const report = await buildMultiActiveReport();
    expect(report.owned.some((g) => g.member_id === coMember)).toBe(false);
    const group = report.covered.find((g) => g.member_id === coMember);
    expect(group).toBeDefined();
    expect(group!.assignments.map((a) => a.user_membership_id).sort()).toEqual([family, own].sort());
    // And nothing about it is a keeper decision — there is none to make.
    expect(group!.assignments.every((a) => a.keeper === undefined)).toBe(true);
  });
});
