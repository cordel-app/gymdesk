// #2664 — a Professional Service's Booking Type (family_only | open_group), for a
// gym's own services and Cordel's Base ones. Configuration only.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const PREFIX = `TestPSBookingType-${Date.now()}`;
let gymId: string;
let otherGymId: string;
const h = (g = gymId) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });
const uname = (p: string) => `${PREFIX}-${p}-${Math.random().toString(36).slice(2, 7)}`;

function mockSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) {
    vi.mocked(client.users.getUser).mockResolvedValue(
      { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin' } as any,
    );
  }
}

beforeAll(async () => {
  gymId = await createTestGym('PS BookingType Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('PS BookingType Other');
  await createTestMembership(otherGymId, 'admin');
});

beforeEach(() => mockSuperadmin());

afterAll(async () => {
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  await cleanupTestGyms();
  await db.end();
});

describe('gym-based Professional Service booking_type', () => {
  it('defaults to open_group, stores family_only, keeps it when absent and lists it', async () => {
    const plain = await request.post('/professional-services').set(h()).send({ name: uname('Plain') });
    expect(plain.status).toBe(201);
    expect(plain.body.booking_type).toBe('open_group');

    const created = await request.post('/professional-services').set(h())
      .send({ name: uname('Duo'), booking_type: 'family_only' });
    expect(created.status).toBe(201);
    expect(created.body.booking_type).toBe('family_only');
    const id = created.body.id;

    const renamed = await request.put(`/professional-services/${id}`).set(h()).send({ name: uname('Duo2') });
    expect(renamed.status).toBe(200);
    expect(renamed.body.booking_type).toBe('family_only');

    const switched = await request.put(`/professional-services/${id}`).set(h()).send({ booking_type: 'open_group' });
    expect(switched.body.booking_type).toBe('open_group');

    const list = await request.get('/professional-services').set(h());
    expect(list.body.find((r: any) => r.id === id).booking_type).toBe('open_group');
  });

  it('refuses an unknown, null or empty value rather than coercing it', async () => {
    for (const bad of ['family', 'FAMILY_ONLY', null, '', 1]) {
      const r = await request.post('/professional-services').set(h()).send({ name: uname('Bad'), booking_type: bad });
      expect(r.status).toBe(400);
    }
    const { body } = await request.post('/professional-services').set(h())
      .send({ name: uname('Keep'), booking_type: 'family_only' });
    const bad = await request.put(`/professional-services/${body.id}`).set(h()).send({ booking_type: 'nope' });
    expect(bad.status).toBe(400);
    const { rows } = await db.query('SELECT booking_type FROM professional_services WHERE id = ?', [body.id]);
    expect(rows[0].booking_type).toBe('family_only');
  });

  it('the database refuses a value outside the set', async () => {
    await expect(db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, booking_type) VALUES (?, ?, 0, 'other')`,
      [gymId, uname('Chk')],
    )).rejects.toThrow();
  });

  it('a service written without the column reads open_group', async () => {
    const { insertId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`, [gymId, uname('Legacy')],
    );
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, insertId]);
    const r = await request.get(`/professional-services/${insertId}`).set(h());
    expect(r.status).toBe(200);
    expect(r.body.booking_type).toBe('open_group');
  });

  it('Duplicate copies it, and another gym cannot change it', async () => {
    const { body } = await request.post('/professional-services').set(h())
      .send({ name: uname('Src'), booking_type: 'family_only' });
    const dup = await request.post(`/professional-services/${body.id}/duplicate`).set(h());
    expect(dup.status).toBe(201);
    expect(dup.body.booking_type).toBe('family_only');

    const foreign = await request.put(`/professional-services/${body.id}`).set(h(otherGymId)).send({ booking_type: 'open_group' });
    expect(foreign.status).toBe(404);
  });
});

describe('Base Professional Service booking_type', () => {
  it('is stored on a Base service, reported by /base and copied by import', async () => {
    const created = await request.post('/platform/professional-services').set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uname('Base'), booking_type: 'family_only' });
    expect(created.status).toBe(201);
    expect(created.body.booking_type).toBe('family_only');

    const bad = await request.put(`/platform/professional-services/${created.body.id}`).set('Authorization', TEST_AUTH_HEADER)
      .send({ booking_type: 'x' });
    expect(bad.status).toBe(400);

    const listed = await request.get('/professional-services/base').set(h());
    expect(listed.body.find((r: any) => r.id === created.body.id).booking_type).toBe('family_only');

    const imported = await request.post('/professional-services/import').set(h())
      .send({ base_professional_service_ids: [created.body.id] });
    expect(imported.status).toBe(200);
    const { rows } = await db.query(
      'SELECT booking_type FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?',
      [gymId, created.body.id],
    );
    expect(rows[0].booking_type).toBe('family_only');

    const edited = await request.put(`/platform/professional-services/${created.body.id}`).set('Authorization', TEST_AUTH_HEADER)
      .send({ booking_type: 'open_group' });
    expect(edited.status).toBe(200);
    expect(edited.body.booking_type).toBe('open_group');
  });
});
