// #2256 — "Update System Data" syncs name, description and their translations from the
// originating Base Professional Service and nothing else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const PREFIX = `ps-usd-${Date.now()}`;
let gymA: string;
let gymB: string;
let frontDesk: string;
let base: number;
let copyId: number;
let ownId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const url = (id: number) => `/professional-services/${id}/update-system-data`;

beforeAll(async () => {
  gymA = await createTestGym('PS USD A');
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym('PS USD B');
  await createTestMembership(gymB, 'admin');
  frontDesk = await createTestGym('PS USD FD');
  await createTestMembership(frontDesk, 'front_desk');
  const ins = await db.query(
    "INSERT INTO professional_services (gym_id, name, description, is_system, max_capacity, created_by) VALUES (NULL, ?, 'v1', 0, 4, 'test')",
    [`${PREFIX}-base`],
  );
  base = ins.insertId;
  await db.query(
    "INSERT INTO professional_service_translations (professional_service_id, locale, name, description) VALUES (?, 'es', 'Base ES', 'desc es')",
    [base],
  );
  const imp = await request.post('/professional-services/import').set(as(gymA)).send({ base_professional_service_ids: [base] });
  expect(imp.body.imported).toEqual([base]);
  const { rows } = await db.query('SELECT id FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gymA, base]);
  copyId = rows[0].id;
  ownId = (await request.post('/professional-services').set(as(gymA)).send({ name: `${PREFIX}-own` })).body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM professional_service_translations WHERE professional_service_id = ?', [base]);
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  await db.end();
});

describe('POST /professional-services/:id/update-system-data', () => {
  it('reports nothing to do when the copy is current', async () => {
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
  });

  it('syncs name, description and translations, keeping gym-specific fields', async () => {
    await db.query("UPDATE professional_services SET max_capacity = 9 WHERE id = ?", [copyId]);
    await db.query("UPDATE professional_services SET name = ?, description = 'v2' WHERE id = ?", [`${PREFIX}-base2`, base]);
    await db.query("UPDATE professional_service_translations SET name = 'Base ES 2' WHERE professional_service_id = ? AND locale = 'es'", [base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(expect.arrayContaining(['name', 'description']));
    expect(res.body.service.name).toBe(`${PREFIX}-base2`);
    expect(res.body.service.description).toBe('v2');
    expect(res.body.service.translations.es.name).toBe('Base ES 2');
    expect(res.body.service.max_capacity).toBe(9);
    expect(res.body.service.base_professional_service_id).toBe(base);
    const { rows } = await db.query('SELECT name FROM professional_services WHERE id = ?', [base]);
    expect(rows[0].name).toBe(`${PREFIX}-base2`);
  });

  it('refuses a service the gym created itself', async () => {
    const res = await request.post(url(ownId)).set(as(gymA));
    expect(res.status).toBe(400);
  });

  it("is a 404 across tenants", async () => {
    expect((await request.post(url(copyId)).set(as(gymB))).status).toBe(404);
  });

  it('requires an admin and authentication', async () => {
    expect((await request.post(url(copyId)).set(as(frontDesk))).status).toBe(403);
    expect((await request.post(url(copyId))).status).toBe(401);
  });

  it('explains when the Base service is gone', async () => {
    await db.query('UPDATE professional_services SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [base]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('base_unavailable');
  });
});
