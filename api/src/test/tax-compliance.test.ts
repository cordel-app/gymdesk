// #2647 stage 1: Settings → Tax & Compliance — the gym's Tax Profile (columns of
// `gyms`, the gym being the legal entity) and its Compliance History.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const PROFILE = {
  legal_name: 'Gimnasio Prueba SL',
  country_code: 'ES',
  tax_id_type: 'nif',
  cif: 'B-12345678',
  fiscal_address: 'Carrer Major 1',
  fiscal_postal_code: '08001',
  fiscal_city: 'Barcelona',
  fiscal_region: 'Barcelona',
  tax_registration_date: '2020-01-15',
};

let gymA: string;
let gymB: string;
let gymFrontDesk: string;

const as = (gymId: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

beforeAll(async () => {
  gymA = await createTestGym('Tax A');
  gymB = await createTestGym('Tax B');
  gymFrontDesk = await createTestGym('Tax FD');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
  await createTestMembership(gymFrontDesk, 'front_desk');
  await db.query(`UPDATE gyms SET legal_name = 'Old Name SL', cif = 'B87654321', fiscal_address = 'Old 2' WHERE id = ?`, [gymB]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Tax & Compliance (#2647 stage 1)', () => {
  it('401 without a token, 403 for a role without SYSTEM access', async () => {
    expect((await request.get('/system/tax-compliance/profile').set('x-gym-id', gymA)).status).toBe(401);
    expect((await request.get('/system/tax-compliance/profile').set(as(gymFrontDesk))).status).toBe(403);
    expect((await request.put('/system/tax-compliance/profile').set(as(gymFrontDesk)).send(PROFILE)).status).toBe(403);
  });

  it('reports the fiscal fields the gym already holds', async () => {
    const res = await request.get('/system/tax-compliance/profile').set(as(gymB));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ legal_name: 'Old Name SL', cif: 'B87654321', fiscal_address: 'Old 2', country_code: null });
  });

  it('offers the countries and their identifier types', async () => {
    const res = await request.get('/system/tax-compliance/profile/options').set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.countries).toContain('ES');
    expect(res.body.tax_id_types.ES).toEqual(['nif', 'nie', 'vat', 'other']);
  });

  it('refuses an incomplete or invalid profile and writes nothing', async () => {
    const missing = await request.put('/system/tax-compliance/profile').set(as(gymA)).send({ legal_name: 'X' });
    expect(missing.status).toBe(400);
    const badId = await request.put('/system/tax-compliance/profile').set(as(gymA)).send({ ...PROFILE, tax_id_type: 'nie' });
    expect(badId.status).toBe(400);
    const { rows } = await db.query('SELECT legal_name FROM gyms WHERE id = ?', [gymA]);
    expect(rows[0].legal_name).toBeNull();
    const { rows: events } = await db.query('SELECT id FROM compliance_audit_events WHERE gym_id = ?', [gymA]);
    expect(events).toHaveLength(0);
  });

  it('saves the profile, normalising the tax id, and records a compliance event', async () => {
    const res = await request.put('/system/tax-compliance/profile').set(as(gymA)).send(PROFILE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...PROFILE, cif: 'B12345678' });

    const history = await request.get('/system/tax-compliance/history').set(as(gymA));
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({ event_type: 'tax_profile_updated', status: 'success' });
    expect(history.body[0].metadata.fields).toContain('cif');
  });

  it('a partial save keeps the unmentioned fields and an unchanged save records nothing', async () => {
    const res = await request.put('/system/tax-compliance/profile').set(as(gymA)).send({ fiscal_city: 'Girona' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ legal_name: PROFILE.legal_name, fiscal_city: 'Girona' });
    await request.put('/system/tax-compliance/profile').set(as(gymA)).send({ fiscal_city: 'Girona' });
    const history = await request.get('/system/tax-compliance/history').set(as(gymA));
    expect(history.body).toHaveLength(2);
  });

  it('isolates gyms: one gym reads neither the other profile nor its history', async () => {
    const profile = await request.get('/system/tax-compliance/profile').set(as(gymB));
    expect(profile.body.legal_name).toBe('Old Name SL');
    const history = await request.get('/system/tax-compliance/history').set(as(gymB));
    expect(history.body).toEqual([]);
  });

  it('refuses an invalid history limit', async () => {
    expect((await request.get('/system/tax-compliance/history?limit=abc').set(as(gymA))).status).toBe(400);
    expect((await request.get('/system/tax-compliance/history?limit=1').set(as(gymA))).body).toHaveLength(1);
  });
});
