// #1121 stage 1 — `GET /me/products`, the member's own read of the gym's
// Product catalogue.
//
// Integration, not unit: what is under test is **which rows a member is shown**
// and that the catalogue is their gym's alone. What each row says, and how the
// Members App words it, is asserted in `member-products.unit.test.ts`, where
// both halves are pure.
//
// Fixtures are inserted directly; the HTTP API is used only for the action under
// test (CLAUDE.md).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const ROOT = '/me/products';

let gymId: string;

// `members.clerk_user_id` is globally UNIQUE (migration 003), so this file
// brings its own Clerk ids rather than claiming the shared `TEST_USER_ID` row.
const MEMBER_CLERK = `mep-member-${Date.now()}`;

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

interface ItemOpts {
  name: string;
  type?: 'fee' | 'sessions' | 'service' | 'other';
  status?: 'active' | 'inactive';
  enrollment?: 'public' | 'staff_only';
  amount?: string | null;
  frequency?: string | null;
  units?: number | null;
  isSystem?: 0 | 1;
  taxRateId?: number | null;
  description?: string | null;
  deleted?: boolean;
}

async function createItem(gid: string, opts: ItemOpts): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, description, type, units, billing_frequency, status,
        enrollment_status, is_system, currency, amount, tax_rate_id, tax_behavior,
        deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 'inclusive', ?)`,
    [
      gid, opts.name, opts.description ?? null, opts.type ?? 'fee', opts.units ?? null,
      opts.frequency ?? null, opts.status ?? 'active', opts.enrollment ?? 'public',
      opts.isSystem ?? 0, opts.amount === undefined ? '15.00' : opts.amount,
      opts.taxRateId ?? null, opts.deleted ? new Date() : null,
    ],
  );
  return insertId;
}

/** A member row linked to a Clerk id, so `resolveMemberId()` finds it. */
async function createLinkedMember(gid: string, clerkId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gid, 'Catalogue Member', `mep-${uniq()}@test.com`, clerkId],
  );
  return insertId;
}

/** The member's own call: their token, their gym. */
function asMember(gid: string = gymId, clerkId: string = MEMBER_CLERK) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.get(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

const names = (body: any): string[] => body.items.map((i: any) => i.name);

beforeAll(async () => {
  gymId = await createTestGym('Member Products Gym');
  await createTestMembership(gymId, 'member', MEMBER_CLERK);
  await createLinkedMember(gymId, MEMBER_CLERK);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('auth and gating', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(ROOT).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a gym role that is not a member', async () => {
    const roleGymId = await createTestGym('Products Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'mep-role-admin');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'mep-role-admin' } as any);
    const res = await request.get(ROOT)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });
});

describe('which Products the member is shown (#1121 Q1)', () => {
  it('lists the gym’s active, public items alphabetically', async () => {
    const gid = await createTestGym('Products Catalogue Gym');
    await createTestMembership(gid, 'member', 'mep-cat-member');
    await createLinkedMember(gid, 'mep-cat-member');
    await createItem(gid, { name: 'Locker Rental', frequency: 'month' });
    await createItem(gid, { name: 'Access Key', frequency: 'once', amount: '5.00' });

    const res = await asMember(gid, 'mep-cat-member');
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Access Key', 'Locker Rental']);
  });

  it('excludes an inactive item, a staff-only one and a deleted one', async () => {
    const gid = await createTestGym('Products Exclusion Gym');
    await createTestMembership(gid, 'member', 'mep-excl-member');
    await createLinkedMember(gid, 'mep-excl-member');
    await createItem(gid, { name: 'Shown' });
    await createItem(gid, { name: 'Parking Fee', status: 'inactive' });
    await createItem(gid, { name: 'Insurance Fee', enrollment: 'staff_only' });
    await createItem(gid, { name: 'Retired Item', deleted: true });

    const res = await asMember(gid, 'mep-excl-member');
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Shown']);
  });

  // `is_system` says an item was seeded from `charge_types`, not that it is
  // internal — a Locker Rental is a System row and a public one (#1149).
  it('includes a System item that the gym made public', async () => {
    const gid = await createTestGym('Products System Gym');
    await createTestMembership(gid, 'member', 'mep-sys-member');
    await createLinkedMember(gid, 'mep-sys-member');
    await createItem(gid, { name: 'Locker Rental', isSystem: 1, frequency: 'month' });

    const res = await asMember(gid, 'mep-sys-member');
    expect(names(res.body)).toEqual(['Locker Rental']);
  });

  it('is scoped to the caller’s gym', async () => {
    const otherGym = await createTestGym('Products Other Gym');
    await createItem(otherGym, { name: 'Another Gym Locker' });

    const res = await asMember();
    expect(res.status).toBe(200);
    expect(names(res.body)).not.toContain('Another Gym Locker');
  });

  it('a gym with nothing public answers an empty catalogue, not an error', async () => {
    const gid = await createTestGym('Products Empty Gym');
    await createTestMembership(gid, 'member', 'mep-empty-member');
    await createLinkedMember(gid, 'mep-empty-member');
    await createItem(gid, { name: 'Staff Only Fee', enrollment: 'staff_only' });

    const res = await asMember(gid, 'mep-empty-member');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('what each row carries (#1121 §4)', () => {
  it('quotes the VAT-inclusive price and says tax is included', async () => {
    const gid = await createTestGym('Products Tax Gym');
    await createTestMembership(gid, 'member', 'mep-tax-member');
    await createLinkedMember(gid, 'mep-tax-member');
    const { insertId: rateId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 21%', 21, 0, 'active')`,
      [gid],
    );
    // Stored inclusive, so the gross figure is the stored amount itself — what
    // changes with the rate is only whether the row claims tax at all.
    await createItem(gid, {
      name: 'Taxed Locker', amount: '15.00', frequency: 'month', taxRateId: rateId,
    });

    const res = await asMember(gid, 'mep-tax-member');
    expect(res.body.items[0]).toMatchObject({
      name: 'Taxed Locker', price_incl_tax: 15, currency: 'EUR',
      tax_included: true, billing_frequency: 'month',
    });
  });

  it('an item with no tax rate claims no tax, and still reports its price', async () => {
    const gid = await createTestGym('Products Untaxed Gym');
    await createTestMembership(gid, 'member', 'mep-untax-member');
    await createLinkedMember(gid, 'mep-untax-member');
    await createItem(gid, { name: 'Plain Fee', amount: '20.00', frequency: 'once' });

    const res = await asMember(gid, 'mep-untax-member');
    expect(res.body.items[0]).toMatchObject({
      name: 'Plain Fee', price_incl_tax: 20, tax_included: false,
    });
  });

  it('an unpriced item reports null rather than zero', async () => {
    const gid = await createTestGym('Products Unpriced Gym');
    await createTestMembership(gid, 'member', 'mep-unpriced-member');
    await createLinkedMember(gid, 'mep-unpriced-member');
    await createItem(gid, { name: 'Premium Fitness App', amount: null, frequency: 'once' });

    const res = await asMember(gid, 'mep-unpriced-member');
    expect(res.body.items[0].price_incl_tax).toBeNull();
  });

  // #942 — the price is the whole package's, and `units` travels so the member
  // can be told so. Nothing divides by it.
  it('a Sessions package carries its units beside the package price', async () => {
    const gid = await createTestGym('Products Sessions Gym');
    await createTestMembership(gid, 'member', 'mep-sess-member');
    await createLinkedMember(gid, 'mep-sess-member');
    await createItem(gid, {
      name: 'Personal Training Class Package (10 Sessions)',
      type: 'sessions', units: 10, amount: '500.00', frequency: 'once',
    });

    const res = await asMember(gid, 'mep-sess-member');
    expect(res.body.items[0]).toMatchObject({ type: 'sessions', units: 10, price_incl_tax: 500 });
  });

  // Stage 1 is a read: the catalogue says what exists, never what the member
  // holds. A purchase state arriving here early would be stage 2's decision
  // taken by accident.
  it('reports no purchase state', async () => {
    const res = await asMember();
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('purchased');
      expect(item).not.toHaveProperty('status');
    }
  });
});
