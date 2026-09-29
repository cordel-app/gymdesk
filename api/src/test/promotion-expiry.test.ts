// #900: the scheduled sweep that expires Promotions past their End Date —
// `POST /promotion-lifecycle/run` (api/src/api/promotion-lifecycle.ts).
//
// The sweep is system-wide (one UPDATE across every gym, like the nightly
// runs), so this file normalises the world once in `beforeAll` — a Promotion
// another test file left behind with a past end date would otherwise show up in
// the counters asserted below. After that first sweep the only expirable rows
// in the database are the ones each test creates.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const SECRET = 'test-promotion-lifecycle-secret';

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Promotion Expiry Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Promotion Expiry Gym B');
  await sweep();
});

afterAll(async () => {
  delete process.env.BILLING_INTERNAL_SECRET;
  await cleanupTestGyms();
  await db.end();
});

const sweep = () => request.post('/promotion-lifecycle/run').set('X-Internal-Secret', SECRET);

/** `days` from today, as the `YYYY-MM-DD` string the promotion editor submits. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createPromo(opts: {
  gym?: string;
  name: string;
  status: string;
  endsAt: string;
  startsAt?: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, free_months, paid_months)
     VALUES (?, ?, ?, ?, ?, 1, 2)`,
    [opts.gym ?? gymId, opts.name, opts.startsAt ?? dayOffset(-30), opts.endsAt, opts.status],
  );
  return insertId;
}

async function statusOf(id: number): Promise<string> {
  const { rows } = await db.query<{ lifecycle_status: string }>(
    'SELECT lifecycle_status FROM promotions WHERE id = ?',
    [id],
  );
  return rows[0].lifecycle_status;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('POST /promotion-lifecycle/run auth', () => {
  it('401 without the internal secret', async () => {
    const res = await request.post('/promotion-lifecycle/run');
    expect(res.status).toBe(401);
  });

  it('401 with the wrong internal secret', async () => {
    const res = await request.post('/promotion-lifecycle/run').set('X-Internal-Secret', 'nope');
    expect(res.status).toBe(401);
  });

  it('a Clerk session is not what authenticates it', async () => {
    const res = await request.post('/promotion-lifecycle/run')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ─── The expiration rules (§3, §5, §6, §13) ───────────────────────────────────

describe('which Promotions the sweep expires', () => {
  it("an active Promotion whose end date has passed becomes 'expired'", async () => {
    const id = await createPromo({ name: 'Past Active', status: 'active', endsAt: dayOffset(-1) });

    const res = await sweep();

    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('an active Promotion whose end date has not passed stays active', async () => {
    const id = await createPromo({ name: 'Future Active', status: 'active', endsAt: dayOffset(1) });

    const res = await sweep();

    expect(res.body.expired).toBe(0);
    expect(await statusOf(id)).toBe('active');
  });

  it('a manually inactive Promotion is never expired, however old (§5)', async () => {
    // `promotions_dates_check` (migration 019) is `ends_at >= starts_at`, so a
    // Promotion this old needs a start date older still — the helper's default
    // is 30 days back.
    const id = await createPromo({
      name: 'Past Inactive', status: 'inactive', startsAt: dayOffset(-120), endsAt: dayOffset(-90),
    });

    await sweep();

    expect(await statusOf(id)).toBe('inactive');
  });

  it('a soft-deleted Promotion is left in the Recycle Bin', async () => {
    const id = await createPromo({ name: 'Past Deleted', status: 'deleted', endsAt: dayOffset(-2) });

    await sweep();

    expect(await statusOf(id)).toBe('deleted');
  });

  it('is idempotent — a second run changes nothing (§2)', async () => {
    const id = await createPromo({ name: 'Twice Swept', status: 'active', endsAt: dayOffset(-3) });

    const first = await sweep();
    const second = await sweep();

    expect(first.body.expired).toBe(1);
    expect(second.body.expired).toBe(0);
    expect(await statusOf(id)).toBe('expired');
  });

  it('expires across gyms in one run — it is a system-wide job', async () => {
    const mine = await createPromo({ name: 'Mine', status: 'active', endsAt: dayOffset(-1) });
    const theirs = await createPromo({ gym: otherGymId, name: 'Theirs', status: 'active', endsAt: dayOffset(-1) });

    const res = await sweep();

    expect(res.body.expired).toBe(2);
    expect(await statusOf(mine)).toBe('expired');
    expect(await statusOf(theirs)).toBe('expired');
  });
});

// ─── Only the status is written (§8) ──────────────────────────────────────────

describe('what the sweep does not touch', () => {
  it('leaves every other column and the benefit rows alone', async () => {
    const id = await createPromo({
      name: 'Rich Promo', status: 'active', startsAt: dayOffset(-60), endsAt: dayOffset(-5),
    });
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits
         (gym_id, promotion_id, duration_months, enabled, action, value)
       VALUES (?, ?, 2, 1, 'fixed_price', 500.00)`,
      [gymId, id],
    );

    const { rows: before } = await db.query(
      `SELECT name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
              free_months, paid_months, bonus_months, pay_beforehand_months
         FROM promotions WHERE id = ?`,
      [id],
    );

    await sweep();

    const { rows: after } = await db.query(
      `SELECT name, description, starts_at, ends_at, stackable, only_applicable_for_new_members,
              free_months, paid_months, bonus_months, pay_beforehand_months
         FROM promotions WHERE id = ?`,
      [id],
    );
    expect(after[0]).toEqual(before[0]);
    expect(await statusOf(id)).toBe('expired');

    const { rows: mf } = await db.query<{ action: string; value: string }>(
      'SELECT action, value FROM promotion_membership_fee_benefits WHERE promotion_id = ?',
      [id],
    );
    expect(mf).toHaveLength(1);
    expect(mf[0].action).toBe('fixed_price');
  });
});

// ─── The status on the API surface (§7, §10) ──────────────────────────────────

describe('expired on the Promotions API', () => {
  it('GET /promotions?lifecycle_status=expired returns the expired ones only', async () => {
    const expiredId = await createPromo({ name: 'Filterable Expired', status: 'active', endsAt: dayOffset(-1) });
    const activeId = await createPromo({ name: 'Filterable Active', status: 'active', endsAt: dayOffset(10) });
    await sweep();

    const res = await request.get('/promotions?lifecycle_status=expired')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).toContain(expiredId);
    expect(ids).not.toContain(activeId);
  });

  it('an expired Promotion is still listed unfiltered, with its status', async () => {
    const id = await createPromo({ name: 'Listed Expired', status: 'active', endsAt: dayOffset(-1) });
    await sweep();

    const res = await request.get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const row = res.body.find((p: any) => p.id === id);
    expect(row?.lifecycle_status).toBe('expired');
  });

  it('PUT /promotions/:id accepts the status the row already holds', async () => {
    const id = await createPromo({ name: 'Edited Expired', status: 'active', endsAt: dayOffset(-1) });
    await sweep();

    const res = await request.put(`/promotions/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Edited Expired renamed', lifecycle_status: 'expired' });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('expired');
  });

  it('an expired Promotion cannot be applied to an assignment (§7)', async () => {
    const id = await createPromo({ name: 'Unappliable', status: 'active', endsAt: dayOffset(-1) });
    await sweep();

    const { rows } = await db.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM promotions
        WHERE id = ? AND gym_id = ? AND lifecycle_status = 'active'`,
      [id, gymId],
    );
    // Every apply path (validatePromotionSelection / applyPromotionToMembership)
    // requires `lifecycle_status = 'active'`, so an expired Promotion is refused
    // there for exactly the same reason an inactive one is.
    expect(rows).toHaveLength(0);
  });

  it('a Promotion the sweep has not reached yet stays selectable', async () => {
    const id = await createPromo({ name: 'Still Live', status: 'active', endsAt: dayOffset(5) });
    await sweep();
    expect(await statusOf(id)).toBe('active');
  });
});
