// #2952 stage 3: Cordel → Export / Import of Base Professional Services.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const platformRole = vi.hoisted(() => ({ value: 'superadmin' as string | undefined }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockImplementation(async () => ({
          publicMetadata: platformRole.value ? { platform_role: platformRole.value } : {},
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        })),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv' }), revokeInvitation: vi.fn().mockResolvedValue({}) },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 't@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const STAMP = Date.now();
const SLUG = `transfer-service-${STAMP}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer Services Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  const ids = await db.query<{ id: number }>(
    'SELECT id FROM professional_services WHERE gym_id IS NULL AND slug LIKE ?', ['transfer-service-%'],
  );
  for (const { id } of ids.rows) {
    await db.query('DELETE FROM gym_professional_services WHERE professional_service_id = ?', [id]);
    await db.query('DELETE FROM professional_service_translations WHERE professional_service_id = ?', [id]);
    await db.query('DELETE FROM professional_services WHERE id = ?', [id]);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of Base Professional Services (#2952 stage 3)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/base_professional_services').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_professional_services').set(H).set('x-gym-id', gymId)
        .send({ slug: SLUG, name: 'X' })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('creates a Base service under the archive slug, ignoring what is not its own content', async () => {
    const created = await request.post('/platform/transfer/base_professional_services').set(H)
      .send({
        slug: SLUG, name: `Transfer Service ${STAMP}`, description: 'One', max_capacity: 4, min_participants: 2,
        booking_type: 'family_only', translations: { es: { name: `Servicio ${STAMP}`, description: null } },
        id: 999999, is_system: 0, system_key: 'personal_training', gym_id: gymId,
      });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    const e = created.body.entity;
    expect(e.slug).toBe(SLUG);
    expect(e.id).not.toBe(999999);
    expect(e.is_system).toBe(1);
    expect(e.system_key).toBeNull();
    expect(e.max_capacity).toBe(4);
    expect(e.min_participants).toBe(2);
    expect(e.booking_type).toBe('family_only');
    expect(e.translations.es.name).toBe(`Servicio ${STAMP}`);
    const row = await db.query<{ gym_id: number | null }>('SELECT gym_id FROM professional_services WHERE id = ?', [e.id]);
    expect(row.rows[0].gym_id).toBeNull();
  });

  it('exports it as its slug, its own fields and its image slot', async () => {
    const res = await request.get('/platform/transfer/base_professional_services').set(H);
    expect(res.status).toBe(200);
    const mine = res.body.entities.find((x: any) => x.slug === SLUG);
    expect(Object.keys(mine.data).sort())
      .toEqual(['booking_type', 'description', 'max_capacity', 'min_participants', 'name', 'translations']);
    expect(mine.data.translations.es.name).toBe(`Servicio ${STAMP}`);
    expect(mine.images).toEqual({ image: null });
  });

  it('updates the service in place and never touches a gym\'s availability of it', async () => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM professional_services WHERE gym_id IS NULL AND slug = ?', [SLUG]);
    const id = rows[0].id;
    await db.query(
      `INSERT INTO gym_professional_services (gym_id, professional_service_id, status, created_at, created_by)
       VALUES (?, ?, 'inactive', UTC_TIMESTAMP(), 'Test')
       ON DUPLICATE KEY UPDATE status = 'inactive'`,
      [gymId, id],
    );

    const updated = await request.post('/platform/transfer/base_professional_services').set(H)
      .send({
        slug: SLUG, name: `Transfer Service ${STAMP} Renamed`, description: 'Two', max_capacity: 6, min_participants: 1,
        booking_type: 'open_group', translations: { ca: { name: `Servei ${STAMP}`, description: null } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(SLUG);
    expect(updated.body.entity.name).toBe(`Transfer Service ${STAMP} Renamed`);
    expect(updated.body.entity.max_capacity).toBe(6);
    expect(updated.body.entity.booking_type).toBe('open_group');
    expect(updated.body.entity.translations.ca.name).toBe(`Servei ${STAMP}`);

    const avail = await db.query<{ status: string }>(
      'SELECT status FROM gym_professional_services WHERE gym_id = ? AND professional_service_id = ?', [gymId, id],
    );
    expect(avail.rows[0].status).toBe('inactive');
    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM professional_services WHERE gym_id IS NULL AND slug = ?', [SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('keeps the editor\'s rules: a minimum above the capacity is refused', async () => {
    const res = await request.post('/platform/transfer/base_professional_services').set(H)
      .send({ slug: SLUG, name: `Transfer Service ${STAMP} Renamed`, max_capacity: 2, min_participants: 5 });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed slug, an image for an unknown slug or slot, and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/base_professional_services').set(H)
      .send({ slug: 'Bad Slug', name: 'X' })).status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_professional_services/transfer-service-missing/image/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_professional_services/${SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);

    await db.query('UPDATE professional_services SET deleted_at = UTC_TIMESTAMP() WHERE gym_id IS NULL AND slug = ?', [SLUG]);
    const res = await request.post('/platform/transfer/base_professional_services').set(H)
      .send({ slug: SLUG, name: 'Resurrected' });
    expect(res.status).toBe(409);
  });
});
