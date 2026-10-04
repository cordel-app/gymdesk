// #922 — `GET /promotions/:id/billing-event-simulation`.
//
// The projection itself is pure and is covered by
// `promotion-billing-event-simulation.test.ts`; what this file exercises is the
// route around it: tenant isolation, auth, and that the grants the three Benefit
// sections store are what reaches the simulation — at the same VAT-inclusive
// prices those sections quote (#919/#920), since the whole point of the ticket
// is that the card's two halves cannot price one item two ways.

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

describe('Promotion Billing Event Simulation (#922)', () => {
  let gymId: string;
  let otherGymId: string;
  let promoId: number;

  async function createItem(opts: {
    name: string;
    type: 'sessions' | 'service' | 'fee' | 'other';
    frequency: string | null;
    amount: string | null;
  }): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, billing_frequency, status, is_system, currency, amount, tax_behavior)
       VALUES (?, ?, ?, ?, 'active', 0, 'EUR', ?, 'inclusive')`,
      [gymId, opts.name, opts.type, opts.frequency, opts.amount],
    );
    return insertId;
  }

  function get(promotionId: number | string, gym = gymId) {
    return request
      .get(`/promotions/${promotionId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym);
  }

  function putSection(section: string, items: unknown[]) {
    return request
      .put(`/promotions/${promoId}/${section}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items });
  }

  beforeAll(async () => {
    gymId = await createTestGym('PBES Gym');
    await createTestMembership(gymId, 'admin');
    otherGymId = await createTestGym('PBES Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                               free_months, paid_months, bonus_months)
       VALUES (?, 'PBES Promo', '2026-08-01', '2026-12-31', 'active', 1, 2, 0)`,
      [gymId],
    );
    promoId = insertId;
  });

  it('401s without authentication', async () => {
    const res = await request
      .get(`/promotions/${promoId}/billing-event-simulation`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it("404s for another gym's Promotion", async () => {
    const res = await get(promoId, otherGymId);
    expect(res.status).toBe(404);
  });

  it('404s for a Promotion that does not exist', async () => {
    const res = await get(999999);
    expect(res.status).toBe(404);
  });

  it('reports unavailable, with a reason, while the Promotion grants nothing', async () => {
    const res = await get(promoId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.dates).toEqual([]);
  });

  it('groups the granted items by billing date, priced by their own treatment', async () => {
    const insuranceId = await createItem({
      name: 'PBES Insurance Fee', type: 'fee', frequency: 'month', amount: '20.00',
    });
    const registrationId = await createItem({
      name: 'PBES Registration Fee', type: 'fee', frequency: 'once', amount: '100.00',
    });
    expect((await putSection('periodical-benefits', [
      { product_id: insuranceId, quantity: 3, action: 'waive' },
    ])).status).toBe(200);
    expect((await putSection('oneoff-benefits', [
      { product_id: registrationId, quantity: 1, action: 'percentage_discount', value: 20 },
    ])).status).toBe(200);

    const res = await get(promoId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.tax_included).toBe(true);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.dates.length).toBeGreaterThan(1);

    // The first group is the anchor date and carries both items: the one-off
    // charge (which appears exactly once) and the first monthly occurrence.
    const first = res.body.dates[0];
    expect(first.date).toBe(res.body.anchor_date);
    const registration = first.lines.find((l: any) => l.product_id === registrationId);
    expect(registration.regular_price).toBe(100);
    expect(registration.actual_charge).toBe(80);
    const insurance = first.lines.find((l: any) => l.product_id === insuranceId);
    expect(insurance.regular_price).toBe(20);
    expect(insurance.actual_charge).toBe(0);
    expect(insurance.benefits[0]).toMatchObject({ source: 'promotion', action: 'waive' });
    // The total is the sum of the final prices on that date.
    expect(first.total).toBe(80);

    // The one-off item is billed once, never per period.
    const oneoffGroups = res.body.dates.filter((g: any) =>
      g.lines.some((l: any) => l.product_id === registrationId));
    expect(oneoffGroups.length).toBe(1);

    // Nothing was persisted: a second read answers the same, and no billing
    // event row was written.
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('never projects a Membership Fee — a Promotion carries no price of its own', async () => {
    const res = await get(promoId);
    const kinds = new Set<string>(
      res.body.dates.flatMap((g: any) => g.lines.map((l: any) => l.kind)),
    );
    expect([...kinds]).toEqual(['product']);
  });
});
