// #2478 — what the Assigned Plan card needs to place each applied Promotion
// under the Product it affects and to show a detail modal for both: the
// Product's and the Promotion's image URLs (never the bytes — the browser
// downloads them), the Product's description and the Membership Plans the
// Promotion targets. Display only: the frozen prices and treatments are
// unchanged, and a tenant never sees another gym's plans.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let gymId: string;
let otherGymId: string;
let planId: number;
let imagedProductId: number;
let plainProductId: number;
let promotionId: number;

async function createProduct(name: string, opts: { image?: boolean; description?: string | null } = {}) {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system,
        tax_behavior, description, image_url, image_thumbnail_url)
     VALUES (?, ?, 'service', 30, 'EUR', 'once', 'active', 'available', 0, 'inclusive', ?, ?, ?)`,
    [gymId, name, opts.description ?? null,
      opts.image ? `https://img.test/products/${name}.webp` : null,
      opts.image ? `https://img.test/products/${name}-thumbnail.webp` : null],
  );
  return Number(insertId);
}

beforeAll(async () => {
  gymId = await createTestGym('APPD Gym');
  otherGymId = await createTestGym('APPD Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');

  const { insertId: plan } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `APPD Plan ${uniq()}`],
  );
  planId = Number(plan);
  // A deleted plan the Promotion also targets is not listed.
  const { insertId: deletedPlan } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, deleted_at)
     VALUES (?, 'APPD Deleted Plan', 'active', 'staff_only', NOW())`,
    [gymId],
  );

  imagedProductId = await createProduct(`appd-towel-${uniq()}`, { image: true, description: 'A fresh towel' });
  plainProductId = await createProduct(`appd-locker-${uniq()}`);
  for (const productId of [imagedProductId, plainProductId]) {
    await db.query(
      `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity)
       VALUES (?, ?, ?, 1)`,
      [gymId, planId, productId],
    );
  }

  const { insertId: promo } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
        only_applicable_for_new_members, paid_months, image_url, image_thumbnail_url)
     VALUES (?, 'APPD Promo', 'Half the towel', '2026-01-01', '2099-12-31', 'active', 1, 0, 6,
             'https://img.test/promotions/p.webp', 'https://img.test/promotions/p-thumbnail.webp')`,
    [gymId],
  );
  promotionId = Number(promo);
  for (const id of [planId, Number(deletedPlan)]) {
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, id],
    );
  }
  await db.query(
    `INSERT INTO promotion_oneoff (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 1, 'percentage_discount', 50)`,
    [gymId, promotionId, imagedProductId],
  );
});

async function createAssignment(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APPD Member', `appd-${uniq()}@test.com`],
  );
  return createTestDraftAssignment(gymId, Number(insertId), planId, { config: { base_price: 100 } });
}

const getDetail = (umId: number, gym = gymId) =>
  request.get(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

describe('Assigned Plan card display data (#2478)', () => {
  it('reports each Product line\'s image URLs and description, and nothing for a Product without them', async () => {
    const umId = await createAssignment();
    const res = await getDetail(umId);
    expect(res.status).toBe(200);
    const lines = res.body.snapshot.oneoff_benefits;
    const imaged = lines.find((l: any) => l.product_id === imagedProductId);
    const plain = lines.find((l: any) => l.product_id === plainProductId);
    expect(imaged).toMatchObject({
      image_url: expect.stringContaining('products/appd-towel'),
      image_thumbnail_url: expect.stringContaining('-thumbnail.webp'),
      description: 'A fresh towel',
    });
    expect(plain).toMatchObject({ image_url: null, image_thumbnail_url: null, description: null });
  });

  it('reports an applied Promotion\'s image URLs, dates, grants and the live plans it targets', async () => {
    const umId = await createAssignment();
    const apply = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(apply.status).toBe(201);

    const res = await getDetail(umId);
    expect(res.status).toBe(200);
    const application = res.body.promotions.find((p: any) => p.promotion_id === promotionId);
    expect(application).toMatchObject({
      promotion_name: 'APPD Promo',
      promotion_description: 'Half the towel',
      promotion_image_url: 'https://img.test/promotions/p.webp',
      promotion_image_thumbnail_url: 'https://img.test/promotions/p-thumbnail.webp',
      included_plans: [{ id: planId, name: expect.stringContaining('APPD Plan') }],
    });
    expect(application.starts_at).toBeTruthy();
    expect(application.ends_at).toBeTruthy();
    // The grant the card nests under the towel line, with its own frozen treatment.
    expect(application.oneoff_grants).toEqual([
      expect.objectContaining({ product_id: imagedProductId, action: 'percentage_discount', value: 50 }),
    ]);
  });

  it('leaves the frozen line prices exactly as they were', async () => {
    const umId = await createAssignment();
    const line = (await getDetail(umId)).body.snapshot.oneoff_benefits
      .find((l: any) => l.product_id === imagedProductId);
    expect(line.original_price_incl_tax).toBe(30);
    expect(line.final_price_incl_tax).toBe(30);
  });

  it('answers 404 for another gym', async () => {
    const umId = await createAssignment();
    expect((await getDetail(umId, otherGymId)).status).toBe(404);
  });
});
