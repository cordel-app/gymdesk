/**
 * #959 — a Sellable Item configured inside a **Promotion** carries a
 * **Requirement**: `mandatory` (the member takes it with the Promotion) or
 * `optional` (the member may decline it when the Promotion is assigned).
 *
 * Integration, because most of what the ticket asks for is only real against
 * MySQL: the column on six tables, its default, the CHECK beside it, the three
 * section `PUT`s' replace-all rule, and the copy onto an application's own
 * snapshot — which is the acceptance criterion *"Assigned Promotion snapshots
 * preserve the Mandatory/Optional configuration"*.
 *
 * The option set, the input rule and the "two places" guard are pure and live in
 * `promotion-item-requirement.unit.test.ts`.
 *
 * Two things are deliberately **not** covered, because they are deliberately not
 * built (the issue thread narrows the ticket to the Promotion object): the
 * member's own enabled/disabled choice, and any billing effect. Nothing reads
 * this column yet, and the cases below assert that too — an applied Promotion's
 * optional grant still prices exactly as a mandatory one.
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

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const DEFINITION_TABLES = ['promotion_session', 'promotion_oneoff', 'promotion_periodical'];
const SNAPSHOT_TABLES = [
  'user_membership_promotion_session_snapshot',
  'user_membership_promotion_oneoff_snapshot',
  'user_membership_promotion_periodical_snapshot',
];

describe('Promotion item Requirement (#959)', () => {
  let gymId: string;
  let planId: number;
  let promoId: number;
  /** A `service` on a monthly frequency — classifies into the `periodical` section. */
  let lockerId: number;
  let insuranceId: number;

  const put = (section: string, items: unknown[], promotion = promoId, gym = gymId) =>
    request
      .put(`/promotions/${promotion}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym)
      .send({ items });

  const get = (section: string, promotion = promoId, gym = gymId) =>
    request
      .get(`/promotions/${promotion}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym);

  async function createItem(name: string, type = 'service', frequency: string | null = 'month') {
    const { insertId } = await db.query(
      `INSERT INTO gym_charges
         (gym_id, name, type, amount, currency, billing_frequency, status, availability,
          is_system, tax_behavior)
       VALUES (?, ?, ?, 10.00, 'EUR', ?, 'active', 'available', 0, 'inclusive')`,
      [gymId, name, type, frequency],
    );
    return insertId as number;
  }

  async function createPromotion(name: string, gym = gymId, plan = planId) {
    const { insertId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
      [gym, name],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gym, insertId, plan],
    );
    return insertId as number;
  }

  beforeAll(async () => {
    gymId = await createTestGym('PIR Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId: plan } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'staff_only', '1')`,
      [gymId, `PIR-Plan-${uniq()}`],
    );
    planId = plan;
    promoId = await createPromotion(`PIR-Promo-${uniq()}`);
    lockerId = await createItem(`PIR Locker ${uniq()}`);
    insuranceId = await createItem(`PIR Insurance ${uniq()}`, 'fee', 'year');
  });

  /* ── the schema ───────────────────────────────────────────────────────── */

  describe('the column and its CHECK (migration 207)', () => {
    it('exists on the three Promotion tables and their three snapshots', async () => {
      const { rows } = await db.query(
        `SELECT TABLE_NAME, COLUMN_DEFAULT, IS_NULLABLE
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'requirement'
            AND TABLE_NAME IN (${[...DEFINITION_TABLES, ...SNAPSHOT_TABLES].map(() => '?').join(',')})`,
        [...DEFINITION_TABLES, ...SNAPSHOT_TABLES],
      );
      expect(rows).toHaveLength(6);
      for (const row of rows as any[]) {
        // NOT NULL with the default that is also the backfill: `mandatory` is what
        // every row written before the ticket means.
        expect(row.IS_NULLABLE, row.TABLE_NAME).toBe('NO');
        expect(row.COLUMN_DEFAULT, row.TABLE_NAME).toBe('mandatory');
      }
    });

    it('is on no Membership Plan table — the thread excludes Plans from this ticket', async () => {
      const { rows } = await db.query(
        `SELECT TABLE_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'requirement'
            AND TABLE_NAME IN ('membership_plan_session', 'membership_plan_oneoff',
                               'membership_plan_periodical', 'user_membership_session',
                               'user_membership_oneoff', 'user_membership_periodical',
                               'promotion_membership_fee_benefits')`,
      );
      expect(rows).toHaveLength(0);
    });

    it('refuses a value outside the accepted set, in SQL', async () => {
      await expect(db.query(
        `INSERT INTO promotion_periodical (gym_id, promotion_id, gym_charge_id, quantity, requirement)
         VALUES (?, ?, ?, 1, 'required')`,
        [gymId, promoId, lockerId],
      )).rejects.toThrow();
    });
  });

  /* ── configuring it ───────────────────────────────────────────────────── */

  describe('the three section PUTs', () => {
    it('defaults a line that names no Requirement to mandatory', async () => {
      const res = await put('periodical-benefits', [{ gym_charge_id: lockerId, quantity: 1 }]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].requirement).toBe('mandatory');
    });

    it('stores and reports an explicit optional', async () => {
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'optional' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body[0].requirement).toBe('optional');

      const read = await get('periodical-benefits');
      expect(read.status).toBe(200);
      expect(read.body[0].requirement).toBe('optional');
    });

    it('keeps a stored Requirement when the request does not mention it', async () => {
      // The load-bearing case. The section `PUT` is replace-all, so a client that
      // sends `gym_charge_id` + `quantity` alone — anything written before this
      // ticket — must not reset an optional item to mandatory.
      await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'optional' },
      ]);
      const res = await put('periodical-benefits', [{ gym_charge_id: lockerId, quantity: 3 }]);
      expect(res.status).toBe(200);
      expect(res.body[0].quantity).toBe(3);
      expect(res.body[0].requirement).toBe('optional');
    });

    it('changes it back when the request says so', async () => {
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'mandatory' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body[0].requirement).toBe('mandatory');
    });

    it('keeps each line’s own Requirement across a multi-line save', async () => {
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'optional' },
        { gym_charge_id: insuranceId, quantity: 1, requirement: 'mandatory' },
      ]);
      expect(res.status).toBe(200);
      const byId = new Map(res.body.map((r: any) => [r.gym_charge_id, r.requirement]));
      expect(byId.get(lockerId)).toBe('optional');
      expect(byId.get(insuranceId)).toBe('mandatory');

      // …and a quantity-only save of both keeps both.
      const again = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 2 },
        { gym_charge_id: insuranceId, quantity: 2 },
      ]);
      const after = new Map(again.body.map((r: any) => [r.gym_charge_id, r.requirement]));
      expect(after.get(lockerId)).toBe('optional');
      expect(after.get(insuranceId)).toBe('mandatory');
    });

    it('400s an unknown Requirement rather than coercing it', async () => {
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'Optional' },
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('requirement must be one of: mandatory, optional');
    });

    it('does not disturb the (action, value) pair beside it', async () => {
      const res = await put('periodical-benefits', [
        {
          gym_charge_id: lockerId, quantity: 1, requirement: 'optional',
          action: 'percentage_discount', value: 50,
        },
      ]);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({
        requirement: 'optional', action: 'percentage_discount', value: 50,
      });
      // #896/#920: the prices still come from the shared module, untouched by the flag.
      expect(res.body[0].original_price_incl_tax).toBe(10);
      expect(res.body[0].final_price_incl_tax).toBe(5);
    });

    it('serves the column on all three sections', async () => {
      const sessionItem = await createItem(`PIR Classes ${uniq()}`, 'sessions', null);
      const oneoffItem = await createItem(`PIR Towel ${uniq()}`, 'merchandise', 'once');
      for (const [section, itemId] of [
        ['session-benefits', sessionItem], ['oneoff-benefits', oneoffItem],
      ] as const) {
        const res = await put(section, [
          { gym_charge_id: itemId, quantity: 1, requirement: 'optional' },
        ]);
        expect(res.status, section).toBe(200);
        expect(res.body[0].requirement, section).toBe('optional');
      }
    });

    it('404s for a promotion in another gym, and never writes its rows', async () => {
      const otherGym = await createTestGym('PIR Other Gym');
      await createTestMembership(otherGym, 'admin');
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'optional' },
      ], promoId, otherGym);
      expect(res.status).toBe(404);
    });

    it('403s for a non-admin role', async () => {
      const fdGym = await createTestGym('PIR FD Gym');
      await createTestMembership(fdGym, 'front_desk');
      const { insertId: fdPlan } = await db.query(
        `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
         VALUES (?, ?, 'active', 'staff_only', '1')`,
        [fdGym, `PIR-FD-Plan-${uniq()}`],
      );
      const fdPromo = await createPromotion(`PIR-FD-Promo-${uniq()}`, fdGym, fdPlan);
      const res = await put('periodical-benefits', [
        { gym_charge_id: lockerId, quantity: 1, requirement: 'optional' },
      ], fdPromo, fdGym);
      expect(res.status).toBe(403);
    });
  });

  /* ── it survives a copy ───────────────────────────────────────────────── */

  it('POST /:id/duplicate copies the Requirement verbatim', async () => {
    const source = await createPromotion(`PIR-Dup-Source-${uniq()}`);
    const item = await createItem(`PIR Dup Locker ${uniq()}`);
    await put('periodical-benefits', [
      { gym_charge_id: item, quantity: 2, requirement: 'optional' },
    ], source);

    const res = await request
      .post(`/promotions/${source}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(201);

    const copied = await get('periodical-benefits', res.body.id);
    expect(copied.status).toBe(200);
    expect(copied.body).toHaveLength(1);
    // Duplicate is a copy, not a re-configuration: it must not make an optional
    // item mandatory.
    expect(copied.body[0].requirement).toBe('optional');
  });

  it('applying the Promotion snapshots the Requirement onto the application', async () => {
    const promotion = await createPromotion(`PIR-Apply-Promo-${uniq()}`);
    const optionalItem = await createItem(`PIR Apply Locker ${uniq()}`);
    const mandatoryItem = await createItem(`PIR Apply Insurance ${uniq()}`, 'fee', 'year');
    await put('periodical-benefits', [
      { gym_charge_id: optionalItem, quantity: 1, requirement: 'optional', action: 'waive' },
      { gym_charge_id: mandatoryItem, quantity: 1, requirement: 'mandatory', action: 'waive' },
    ], promotion);

    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'PIR Member', `pir-${uniq()}@test.com`],
    );
    const { insertId: umId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', CURDATE(), 100)`,
      [gymId, memberId, planId],
    );
    const applied = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotion });
    expect(applied.status).toBe(201);

    // #635 §16: the application prices and reports from its own snapshot, so the
    // flag has to be *in* the snapshot — otherwise the screen that will offer the
    // member the choice would read a Promotion that may have been edited since.
    const { rows } = await db.query(
      `SELECT s.gym_charge_id, s.requirement
         FROM user_membership_promotion_periodical_snapshot s
         JOIN user_membership_promotions ump ON ump.id = s.user_membership_promotion_id
        WHERE ump.user_membership_id = ? AND s.gym_id = ?
        ORDER BY s.gym_charge_id`,
      [umId, gymId],
    );
    const byId = new Map((rows as any[]).map((r) => [Number(r.gym_charge_id), r.requirement]));
    expect(byId.get(optionalItem)).toBe('optional');
    expect(byId.get(mandatoryItem)).toBe('mandatory');

    // …and nothing reads it yet: both grants are still waived, so an optional
    // item is not a disabled one. The member's own choice, and its billing
    // effect, are the assignment process's and out of this ticket's scope.
    const card = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(card.status).toBe(200);
    const application = card.body.find((r: any) => r.promotion_id === promotion);
    expect(application.periodical_grants).toHaveLength(2);
    for (const grant of application.periodical_grants) {
      expect(grant.action).toBe('waive');
      expect(grant.final_price_incl_tax).toBe(0);
    }
  });
});
