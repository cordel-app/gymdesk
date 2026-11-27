// #3539 — `GET /me/purchases` reports `past_items` beside `items`: the Products the member
// held and no longer holds, for the Members App's *Past Plans and Products*. A paid one-time
// purchase whose cancellation has taken effect leaves `items` and enters `past_items` on the
// same day; one cancelled but still valid stays current; one whose payment never completed is
// in neither; another member's purchases are never reported.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { legacyProductInsert } from './legacyProductFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const MEMBER_CLERK = `mpast-member-${uniq()}`;
const OTHER_CLERK = `mpast-other-${uniq()}`;
let memberId: number;
let otherId: number;

function asMember(clerk: string, r: any) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function member(name: string, clerk: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `mpast-${uniq()}@test.com`, clerk]);
  return insertId;
}

/** A one-time purchase with its own dates, `cancelled_on` / `valid_until` as SQL day offsets. */
async function purchase(opts: {
  owner: number; name: string; status: string; cancelledDaysAgo?: number | null; validUntilDays?: number | null;
}): Promise<number> {
  const productId = (await db.query<any>(
    `INSERT INTO products (gym_id, name, type, amount, billing_frequency, status, enrollment_status)
     VALUES (?, ?, 'other', '20.00', 'once', 'active', 'public')`, [gymId, `${opts.name} ${uniq()}`])).insertId;
  const cancelled = opts.cancelledDaysAgo == null ? 'NULL' : `DATE_SUB(UTC_DATE(), INTERVAL ${opts.cancelledDaysAgo} DAY)`;
  const validUntil = opts.validUntilDays == null ? 'NULL' : `DATE_ADD(UTC_DATE(), INTERVAL ${opts.validUntilDays} DAY)`;
  return (await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot
       (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency,
        units, amount, currency, purchased_at, cancelled_on, valid_until, created_by)
     VALUES (?, ?, ?, ?, ?, 'other', 'once', NULL, '20.00', 'EUR', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY),
             ${cancelled}, ${validUntil}, 'Test')`,
    [gymId, opts.owner, productId, opts.status, opts.name])).insertId;
}

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'member', MEMBER_CLERK);
  await createTestMembership(gymId, 'member', OTHER_CLERK);
  memberId = await member('Holder', MEMBER_CLERK);
  otherId = await member('Someone else', OTHER_CLERK);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/purchases — past_items (#3539)', () => {
  it('lists a held Product whose cancellation took effect, never one still current or never paid', async () => {
    const ended = await purchase({ owner: memberId, name: 'Ended locker', status: 'active', cancelledDaysAgo: 10, validUntilDays: -3 });
    const stillValid = await purchase({ owner: memberId, name: 'Still valid', status: 'active', cancelledDaysAgo: 2, validUntilDays: 20 });
    const current = await purchase({ owner: memberId, name: 'Current', status: 'active' });
    const neverPaid = await purchase({ owner: memberId, name: 'Never paid', status: 'cancelled', cancelledDaysAgo: 5 });
    await purchase({ owner: otherId, name: 'Not mine', status: 'active', cancelledDaysAgo: 10, validUntilDays: -3 });

    const res = await asMember(MEMBER_CLERK, request.get('/me/purchases'));
    expect(res.status).toBe(200);

    const past = res.body.past_items as any[];
    expect(past.map((p) => p.product_name)).toEqual(['Ended locker']);
    expect(past[0]).toMatchObject({ id: `one_time-${ended}`, status: 'cancelled', source: 'one_time' });
    expect(past[0].end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(past[0].start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Never listed twice: what is past is not current, and the current list is unchanged.
    const currentIds = (res.body.items as any[]).map((p) => Number(p.id));
    expect(currentIds).toEqual(expect.arrayContaining([stillValid, current]));
    expect(currentIds).not.toContain(ended);
    expect(currentIds).not.toContain(neverPaid);
  });
});
