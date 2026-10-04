/**
 * #896 stage 1 — the (action, value) pair on the twelve Promotion/Plan ↔
 * Product relationship tables (migration 203).
 *
 * Integration, because the thing under test *is* the schema: the columns, the
 * two CHECK sets and the default are only real against MySQL, so the action
 * here is a direct `db.query` rather than an HTTP call.
 *
 * The per-context option sets and the value rules themselves are pure and
 * covered by `product-benefit-actions.unit.test.ts`; this file is the
 * half that proves the database agrees with them. Stage 2's API — the six
 * replace-all `PUT`s that validate and persist the pair — is covered where
 * those routes already are, in `membership-plan-benefits.test.ts` and
 * `promotions.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const today = () => new Date().toISOString().slice(0, 10);

const PROMOTION_TABLES = [
  'promotion_session',
  'promotion_oneoff',
  'promotion_periodical',
  'user_membership_promotion_session_snapshot',
  'user_membership_promotion_oneoff_snapshot',
  'user_membership_promotion_periodical_snapshot',
];

const PLAN_TABLES = [
  'membership_plan_session',
  'membership_plan_oneoff',
  'membership_plan_periodical',
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
];

async function columnInfo(table: string, column: string) {
  const { rows } = await db.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, DATA_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows[0] as
    | { COLUMN_NAME: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null; DATA_TYPE: string }
    | undefined;
}

async function checkClause(table: string, name: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT cc.CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return rows.length > 0 ? String(rows[0].clause) : null;
}

describe('#896 — the pair reaches all twelve relationship tables', () => {
  it.each([...PROMOTION_TABLES, ...PLAN_TABLES])('%s carries action + value', async (table) => {
    const action = await columnInfo(table, 'action');
    expect(action).toBeDefined();
    // §13: a row written by a path that does not know about the column is
    // included at its normal price and can never read as discounted.
    expect(action!.IS_NULLABLE).toBe('NO');
    expect(action!.COLUMN_DEFAULT).toBe('no_benefit');

    const value = await columnInfo(table, 'value');
    expect(value).toBeDefined();
    expect(value!.IS_NULLABLE).toBe('YES');
    expect(value!.DATA_TYPE).toBe('decimal');
  });

  it.each(PROMOTION_TABLES)('%s permits the five Promotion actions', async (table) => {
    const clause = await checkClause(table, `chk_${table}_action`);
    expect(clause).not.toBeNull();
    // MySQL renders the literals with a charset introducer and escaped quotes
    // (`_utf8mb4\\'waive\\'`), so the assertion is on the value itself.
    for (const action of ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price']) {
      expect(clause).toContain(action);
    }
  });

  it.each(PLAN_TABLES)('%s permits three and refuses the two monetary ones (§16)', async (table) => {
    const clause = await checkClause(table, `chk_${table}_action`);
    expect(clause).not.toBeNull();
    for (const action of ['no_benefit', 'waive', 'percentage_discount']) {
      expect(clause).toContain(action);
    }
    expect(clause).not.toContain('fixed_discount');
    expect(clause).not.toContain('fixed_price');
  });

  it.each([...PROMOTION_TABLES, ...PLAN_TABLES])('%s constrains the value', async (table) => {
    expect(await checkClause(table, `chk_${table}_value`)).not.toBeNull();
  });

  it('adds nothing to the global Product (§12)', async () => {
    // The configuration belongs to the relationship; the same item may be
    // waived by one Plan and discounted by a Promotion.
    expect(await columnInfo('products', 'action')).toBeUndefined();
    expect(await columnInfo('products', 'value')).toBeUndefined();
  });
});

describe('#896 — what the database accepts', () => {
  let gymId: string;
  let planId: number;
  let promotionId: number;
  let itemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Benefit Action Gym');
    await createTestMembership(gymId, 'admin');
    const plan = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, 'Benefit Action Plan', 'active', 'public', '1')`,
      [gymId],
    );
    planId = plan.insertId;
    const promotion = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status)
       VALUES (?, 'Benefit Action Promo', '2026-08-01', '2026-08-31', 'active')`,
      [gymId],
    );
    promotionId = promotion.insertId;
    const item = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, is_system, currency)
       VALUES (?, 'Benefit Action Sessions', 'sessions', 'per_session', 'active', 0, 'EUR')`,
      [gymId],
    );
    itemId = item.insertId;
  });

  const insertPromotionGrant = (action?: string, value?: number | null) => (
    action === undefined
      ? db.query(
        'INSERT INTO promotion_session (gym_id, promotion_id, product_id, quantity) VALUES (?, ?, ?, 1)',
        [gymId, promotionId, itemId],
      )
      : db.query(
        `INSERT INTO promotion_session (gym_id, promotion_id, product_id, quantity, action, value)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [gymId, promotionId, itemId, action, value ?? null],
      )
  );

  const insertPlanBenefit = (action?: string, value?: number | null) => (
    action === undefined
      ? db.query(
        'INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)',
        [gymId, planId, itemId],
      )
      : db.query(
        `INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity, action, value)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [gymId, planId, itemId, action, value ?? null],
      )
  );

  const clear = async () => {
    await db.query('DELETE FROM promotion_session WHERE gym_id = ?', [gymId]);
    await db.query('DELETE FROM membership_plan_session WHERE gym_id = ?', [gymId]);
  };

  it('defaults an insert that never names the column to no_benefit', async () => {
    await clear();
    await insertPromotionGrant();
    await insertPlanBenefit();
    const { rows } = await db.query(
      `SELECT action, value FROM promotion_session WHERE gym_id = ?
       UNION ALL SELECT action, value FROM membership_plan_session WHERE gym_id = ?`,
      [gymId, gymId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.action).toBe('no_benefit');
      expect(row.value).toBeNull();
    }
  });

  it('stores each of the five Promotion actions with its own value', async () => {
    for (const [action, value] of [
      ['no_benefit', null], ['waive', null], ['percentage_discount', 20],
      ['fixed_discount', 10], ['fixed_price', 20],
    ] as const) {
      await clear();
      await insertPromotionGrant(action, value);
      const { rows } = await db.query('SELECT action, value FROM promotion_session WHERE gym_id = ?', [gymId]);
      expect(rows[0].action).toBe(action);
      expect(value === null ? rows[0].value : Number(rows[0].value)).toBe(value);
    }
  });

  it('refuses a Membership Plan the two monetary actions (§16)', async () => {
    await clear();
    await expect(insertPlanBenefit('fixed_price', 20)).rejects.toThrow();
    await expect(insertPlanBenefit('fixed_discount', 10)).rejects.toThrow();
    // …while the Promotion beside it may store both.
    await expect(insertPromotionGrant('fixed_price', 20)).resolves.toBeTruthy();
  });

  it('refuses an action outside the vocabulary entirely', async () => {
    await clear();
    await expect(insertPromotionGrant('free_forever', null)).rejects.toThrow();
  });

  it('refuses a value-requiring action with no value, and a value on one that takes none (§6)', async () => {
    await clear();
    await expect(insertPromotionGrant('percentage_discount', null)).rejects.toThrow();
    await expect(insertPromotionGrant('fixed_discount', null)).rejects.toThrow();
    await expect(insertPromotionGrant('waive', 20)).rejects.toThrow();
    await expect(insertPlanBenefit('no_benefit', 0)).rejects.toThrow();
  });

  it('holds a percentage to 0..100 and an amount to non-negative', async () => {
    await clear();
    await expect(insertPromotionGrant('percentage_discount', 101)).rejects.toThrow();
    await expect(insertPromotionGrant('percentage_discount', -1)).rejects.toThrow();
    await expect(insertPromotionGrant('fixed_price', -1)).rejects.toThrow();
    await expect(insertPlanBenefit('percentage_discount', 100)).resolves.toBeTruthy();
  });
});

describe('#896 — a save that names no treatment writes the neutral default', () => {
  let gymId: string;
  let planId: number;
  let itemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Benefit Action Routes Gym');
    await createTestMembership(gymId, 'admin');
    const plan = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, 'Benefit Action Routes Plan', 'active', 'public', '1')`,
      [gymId],
    );
    planId = plan.insertId;
    const item = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, is_system, currency)
       VALUES (?, 'Routes Sessions', 'sessions', 'per_session', 'active', 0, 'EUR')`,
      [gymId],
    );
    itemId = item.insertId;
  });

  it('still saves a section, and the row starts at the neutral default', async () => {
    const put = await request
      .put(`/membership-plans/${planId}/session-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ product_id: itemId, quantity: 4 }] });
    expect(put.status).toBe(200);

    const { rows } = await db.query(
      'SELECT quantity, action, value FROM membership_plan_session WHERE membership_plan_id = ?',
      [planId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(4);
    expect(rows[0].action).toBe('no_benefit');
    expect(rows[0].value).toBeNull();
  });
});

describe('#896 — a snapshot carries the treatment it was agreed with', () => {
  let gymId: string;
  let planId: number;
  let memberId: number;
  let promotionId: number;
  let sessionItemId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Benefit Action Snapshot Gym');
    await createTestMembership(gymId, 'admin');
    const plan = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, 'Snapshot Plan', 'active', 'public', '1')`,
      [gymId],
    );
    planId = plan.insertId;
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, 80, '2026-01-01', 'active')`,
      [gymId, planId],
    );
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, planId],
    );
    const item = await db.query(
      `INSERT INTO products
         (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, 'Snapshot Sessions', 'sessions', 10, 'EUR', 'per_session', 'active', 'available', 0)`,
      [gymId],
    );
    sessionItemId = item.insertId;
    // The Plan's own Session Benefit, configured as a waive.
    await db.query(
      `INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity, action, value)
       VALUES (?, ?, ?, 2, 'waive', NULL)`,
      [gymId, planId, sessionItemId],
    );
    const member = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Snapshot Member', `snapshot-${Date.now()}@test.com`],
    );
    memberId = member.insertId;
    const promotion = await db.query(
      `INSERT INTO promotions
         (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, 'Snapshot Promo', '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
      [gymId],
    );
    promotionId = promotion.insertId;
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    await db.query(
      `INSERT INTO promotion_session (gym_id, promotion_id, product_id, quantity, action, value)
       VALUES (?, ?, ?, 4, 'percentage_discount', 20)`,
      [gymId, promotionId, sessionItemId],
    );
  });

  it('copies the Plan benefit\'s pair into the Assigned Plan snapshot', async () => {
    const assign = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: today() });
    expect(assign.status).toBe(201);

    const { rows } = await db.query(
      'SELECT action, value FROM user_membership_session WHERE user_membership_id = ?',
      [assign.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('waive');
    expect(rows[0].value).toBeNull();

    // …and the applied Promotion's grant keeps its own, which is the half that
    // matters: billing reads the application's snapshot and never the live
    // `promotion_session` row, so a copy that dropped the pair would record a
    // Promotion the member was never given.
    const applied = await request
      .post(`/user-memberships/${assign.body.id}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);

    const snapshot = await db.query(
      `SELECT s.action, s.value
         FROM user_membership_promotion_session_snapshot s
         JOIN user_membership_promotions ump ON ump.id = s.user_membership_promotion_id
        WHERE ump.user_membership_id = ?`,
      [assign.body.id],
    );
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].action).toBe('percentage_discount');
    expect(Number(snapshot.rows[0].value)).toBe(20);
  });
});
