// #958 / migration 215 — the creation-actor backfill, exercised against the real
// migration rather than taken on trust.
//
// Every assignment that existed before the snapshot pair did has its creator in
// `audit_logs`, recorded under one of **three** actions — one per insert path:
// `create` (`POST /user-memberships`), `assign_new_plan` (supersede a member's
// current plan, #412) and `assign_plan` (the Plans page's bulk Assign). Missing
// one would leave every assignment made that way reading `—` for ever with its
// actor sitting in the audit log, and a shipped migration is never edited — so
// each action is pinned here, beside the cases the statement must *not* touch.
//
// Mechanics: the columns already exist by the time the suite runs, so the
// migration's two guarded `ALTER`s are skipped and only its `UPDATE` runs. The
// `knex` stub is the one `one-active-plan-migration.test.ts` uses, plus the
// `schema` facade this migration asks about its columns.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';

const require = createRequire(import.meta.url);
const migration = require('../infra/migrations/215_user_memberships_actor_snapshot.js');

const knex = {
  raw: async (sql: string, params: any[] = []) => {
    const { rows } = await db.query(sql, params);
    return [rows] as [any[]];
  },
  schema: {
    // The pair is already there — this suite runs against a migrated database.
    hasColumn: async () => true,
    alterTable: async () => {
      throw new Error('migration 215 tried to add a column that already exists');
    },
  },
};

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

let gymId: string;
let otherGymId: string;
let memberId: number;
let planId: number;

async function createAssignment(gym: string, member: number, plan: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
     VALUES (?, ?, ?, 'cancelled', '2026-01-01')`,
    [gym, member, plan],
  );
  return insertId;
}

async function audit(gym: string, umId: number, action: string, actorName: string | null, at: string) {
  await db.query(
    `INSERT INTO audit_logs (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, created_at)
     VALUES (?, 'actor-id', ?, ?, 'user_membership', ?, ?)`,
    [gym, actorName, action, String(umId), at],
  );
}

async function actorOf(umId: number) {
  const { rows } = await db.query(
    'SELECT created_by_name, created_by_type FROM user_memberships WHERE id = ?',
    [umId],
  );
  return rows[0];
}

/** Every assignment is seeded `cancelled`, so #956's one-live-plan index is not in play. */
beforeAll(async () => {
  gymId = await createTestGym('Actor Backfill Gym');
  otherGymId = await createTestGym('Actor Backfill Other Gym');
  const { insertId: m } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Backfill Member', `backfill-${uniq()}@test.com`],
  );
  memberId = m;
  const { insertId: p } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Backfill Plan ${uniq()}`],
  );
  planId = p;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('#958 — migration 215 backfills the creation actor from audit_logs', () => {
  it('adopts the actor of each of the three creation actions, and only the earliest', async () => {
    const created = await createAssignment(gymId, memberId, planId);
    const superseding = await createAssignment(gymId, memberId, planId);
    const bulkAssigned = await createAssignment(gymId, memberId, planId);

    await audit(gymId, created, 'create', 'Alice', '2026-01-01 10:00:00');
    // A later change of any kind is not this row's creation.
    await audit(gymId, created, 'update', 'Zach', '2026-02-01 10:00:00');
    await audit(gymId, superseding, 'assign_new_plan', 'Bob', '2026-01-01 10:00:00');
    // The Plans page's bulk Assign — the action the first draft of this
    // migration missed.
    await audit(gymId, bulkAssigned, 'assign_plan', 'Carol', '2026-01-01 10:00:00');

    await migration.up(knex);

    expect(await actorOf(created)).toEqual({ created_by_name: 'Alice', created_by_type: null });
    expect(await actorOf(superseding)).toEqual({ created_by_name: 'Bob', created_by_type: null });
    expect(await actorOf(bulkAssigned)).toEqual({ created_by_name: 'Carol', created_by_type: null });
  });

  it('leaves a row with no creation row of its own alone', async () => {
    const onlyModified = await createAssignment(gymId, memberId, planId);
    const unnamedActor = await createAssignment(gymId, memberId, planId);
    const noAudit = await createAssignment(gymId, memberId, planId);

    await audit(gymId, onlyModified, 'update', 'Dave', '2026-01-01 10:00:00');
    // An audit row that recorded no name is not an actor.
    await audit(gymId, unnamedActor, 'create', null, '2026-01-01 10:00:00');

    await migration.up(knex);

    for (const id of [onlyModified, unnamedActor, noAudit]) {
      expect(await actorOf(id)).toEqual({ created_by_name: null, created_by_type: null });
    }
  });

  it('never reads another gym\'s audit row for a same-numbered assignment', async () => {
    const mine = await createAssignment(gymId, memberId, planId);
    // Same `entity_id`, different gym: `entity_id` is a bare id string, so the
    // gym is the only thing keeping one gym's actors out of another's rows.
    await audit(otherGymId, mine, 'create', 'Other Gym Admin', '2026-01-01 10:00:00');

    await migration.up(knex);

    expect(await actorOf(mine)).toEqual({ created_by_name: null, created_by_type: null });
  });

  it('does not overwrite what the application already snapshotted', async () => {
    const stamped = await createAssignment(gymId, memberId, planId);
    await db.query(
      'UPDATE user_memberships SET created_by_name = ?, created_by_type = ? WHERE id = ?',
      ['Live Writer', 'superadmin', stamped],
    );
    // An audit row that disagrees — the column wins, and a re-run is a no-op.
    await audit(gymId, stamped, 'create', 'Audit Name', '2026-01-01 10:00:00');

    await migration.up(knex);
    await migration.up(knex);

    expect(await actorOf(stamped)).toEqual({
      created_by_name: 'Live Writer', created_by_type: 'superadmin',
    });
  });
});
