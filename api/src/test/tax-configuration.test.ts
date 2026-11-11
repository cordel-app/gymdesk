// #2647 stage 2: Settings → Tax & Compliance — Tax Configuration (one row per gym)
// and Electronic Invoicing integrations, each change recorded in the Compliance History.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymA: string;
let gymB: string;
let gymNoCountry: string;
let gymFrontDesk: string;

const as = (gymId: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

async function events(gymId: string): Promise<{ event_type: string; integration_id: number | null; metadata: unknown }[]> {
  const res = await request.get('/system/tax-compliance/history').set(as(gymId));
  return res.body;
}

beforeAll(async () => {
  gymA = await createTestGym('TaxCfg A');
  gymB = await createTestGym('TaxCfg B');
  gymNoCountry = await createTestGym('TaxCfg none');
  gymFrontDesk = await createTestGym('TaxCfg FD');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
  await createTestMembership(gymNoCountry, 'admin');
  await createTestMembership(gymFrontDesk, 'front_desk');
  await db.query(`UPDATE gyms SET country_code = 'ES' WHERE id IN (?, ?)`, [gymA, gymB]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Tax Configuration (#2647 stage 2)', () => {
  it('401 without a token, 403 for a role without SYSTEM access', async () => {
    expect((await request.get('/system/tax-compliance/configuration').set('x-gym-id', gymA)).status).toBe(401);
    expect((await request.get('/system/tax-compliance/configuration').set(as(gymFrontDesk))).status).toBe(403);
    expect((await request.put('/system/tax-compliance/configuration').set(as(gymFrontDesk)).send({ tax_status: 'registered' })).status).toBe(403);
    expect((await request.get('/system/tax-compliance/integrations').set(as(gymFrontDesk))).status).toBe(403);
  });

  it('reports an empty configuration before one is saved, and the per-country options', async () => {
    const res = await request.get('/system/tax-compliance/configuration').set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tax_regime: null, tax_status: null, tax_calculation_method: null,
      additional_tax_identification: null, configuration_metadata: null,
    });
    const opts = await request.get('/system/tax-compliance/configuration/options').set(as(gymA));
    expect(opts.body.tax_regimes.ES).toContain('es_general');
    expect(opts.body.tax_regimes.FR).not.toContain('es_general');
    expect(opts.body.providers.ES).toContain('verifactu');
    expect(opts.body.providers.FR).not.toContain('verifactu');
  });

  it('refuses a regime the gym country does not offer, an unknown status and secret-looking metadata', async () => {
    expect((await request.put('/system/tax-compliance/configuration').set(as(gymNoCountry)).send({ tax_regime: 'es_general' })).status).toBe(400);
    expect((await request.put('/system/tax-compliance/configuration').set(as(gymA)).send({ tax_status: 'maybe' })).status).toBe(400);
    expect((await request.put('/system/tax-compliance/configuration').set(as(gymA))
      .send({ configuration_metadata: { nested: { certificate_password: 'x' } } })).status).toBe(400);
    expect((await request.put('/system/tax-compliance/configuration').set(as(gymA)).send({ configuration_metadata: [1] })).status).toBe(400);
    const { rows } = await db.query('SELECT id FROM gym_tax_configs WHERE gym_id = ?', [gymA]);
    expect(rows).toHaveLength(0);
    expect(await events(gymA)).toEqual([]);
  });

  it('creates the one row, then updates it partially, recording each change', async () => {
    const created = await request.put('/system/tax-compliance/configuration').set(as(gymA)).send({
      tax_regime: 'es_general', tax_status: 'registered', tax_calculation_method: 'inclusive',
      configuration_metadata: { epigrafe_iae: '967.2' },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ tax_regime: 'es_general', configuration_metadata: { epigrafe_iae: '967.2' } });

    const partial = await request.put('/system/tax-compliance/configuration').set(as(gymA)).send({ additional_tax_identification: 'ROI ES123' });
    expect(partial.body).toMatchObject({ tax_regime: 'es_general', additional_tax_identification: 'ROI ES123' });

    // unchanged save writes no event
    await request.put('/system/tax-compliance/configuration').set(as(gymA)).send({ tax_status: 'registered' });

    const { rows } = await db.query<{ created_by: string | null; modified_by: string | null }>(
      'SELECT created_by, modified_by FROM gym_tax_configs WHERE gym_id = ?', [gymA]);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).not.toBeNull();
    expect(rows[0].modified_by).not.toBeNull();
    const evs = await events(gymA);
    expect(evs.map((e) => e.event_type)).toEqual(['tax_configuration_updated', 'tax_configuration_updated']);
  });

  it('isolates gyms', async () => {
    const res = await request.get('/system/tax-compliance/configuration').set(as(gymB));
    expect(res.body.tax_regime).toBeNull();
  });
});

describe('Electronic Invoicing integrations (#2647 stage 2)', () => {
  let integrationId: number;

  it('creates an integration, defaulting the country to the gym fiscal country', async () => {
    const res = await request.post('/system/tax-compliance/integrations').set(as(gymA)).send({
      provider: 'verifactu', integration_type: 'invoice_reporting', authorization_status: 'pending',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      country_code: 'ES', provider: 'verifactu', integration_type: 'invoice_reporting',
      enabled: false, authorization_status: 'pending', authorization_date: null,
    });
    integrationId = res.body.id;
    const [ev] = await events(gymA);
    expect(ev).toMatchObject({ event_type: 'integration_created', integration_id: integrationId });
  });

  it('refuses a duplicate, a provider the country does not have and a missing country', async () => {
    expect((await request.post('/system/tax-compliance/integrations').set(as(gymA))
      .send({ provider: 'verifactu', integration_type: 'invoice_reporting' })).status).toBe(409);
    expect((await request.post('/system/tax-compliance/integrations').set(as(gymA))
      .send({ provider: 'verifactu', integration_type: 'invoice_reporting', country_code: 'FR' })).status).toBe(400);
    expect((await request.post('/system/tax-compliance/integrations').set(as(gymA))
      .send({ provider: 'verifactu', integration_type: 'e_invoicing' })).status).toBe(400);
    expect((await request.post('/system/tax-compliance/integrations').set(as(gymNoCountry))
      .send({ provider: 'other', integration_type: 'e_invoicing' })).status).toBe(400);
  });

  it('updates the authorization fields but not the identity of an integration', async () => {
    const res = await request.put(`/system/tax-compliance/integrations/${integrationId}`).set(as(gymA)).send({
      authorization_status: 'authorized', authorization_date: '2026-11-01', authorization_reference: 'AEAT-REF-1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authorization_status: 'authorized', authorization_date: '2026-11-01', authorization_reference: 'AEAT-REF-1' });
    expect((await request.put(`/system/tax-compliance/integrations/${integrationId}`).set(as(gymA)).send({ provider: 'other' })).status).toBe(400);
    expect((await request.put(`/system/tax-compliance/integrations/${integrationId}`).set(as(gymA)).send({ enabled: true })).status).toBe(400);
    expect((await request.put(`/system/tax-compliance/integrations/${integrationId}`).set(as(gymA)).send({ authorization_date: '2026-02-30' })).status).toBe(400);
  });

  it('enables and disables, recording one event per real change', async () => {
    const on = await request.post(`/system/tax-compliance/integrations/${integrationId}/enable`).set(as(gymA));
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    await request.post(`/system/tax-compliance/integrations/${integrationId}/enable`).set(as(gymA));
    const off = await request.post(`/system/tax-compliance/integrations/${integrationId}/disable`).set(as(gymA));
    expect(off.body.enabled).toBe(false);
    const types = (await events(gymA)).map((e) => e.event_type);
    expect(types.slice(0, 3)).toEqual(['integration_disabled', 'integration_enabled', 'integration_updated']);
  });

  it('isolates gyms: another gym neither lists nor changes the integration', async () => {
    expect((await request.get('/system/tax-compliance/integrations').set(as(gymB))).body).toEqual([]);
    expect((await request.put(`/system/tax-compliance/integrations/${integrationId}`).set(as(gymB))
      .send({ authorization_status: 'revoked' })).status).toBe(404);
    expect((await request.post(`/system/tax-compliance/integrations/${integrationId}/enable`).set(as(gymB))).status).toBe(404);
    const list = await request.get('/system/tax-compliance/integrations').set(as(gymA));
    expect(list.body).toHaveLength(1);
    expect(list.body[0].authorization_status).toBe('authorized');
  });

  it('a front desk role cannot write', async () => {
    expect((await request.post('/system/tax-compliance/integrations').set(as(gymFrontDesk))
      .send({ provider: 'other', integration_type: 'e_invoicing', country_code: 'FR' })).status).toBe(403);
  });
});
