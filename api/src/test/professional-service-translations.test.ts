// #2110 — a gym's own Professional Service carries the same per-locale name and
// description as a Base one (professional_service_translations is keyed by the
// service id for both).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe('gym Professional Service translations (#2110)', () => {
  let gymId: string;
  const h = () => ({ 'x-gym-id': gymId, Authorization: TEST_AUTH_HEADER });

  beforeAll(async () => {
    gymId = await createTestGym('PS Translations Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates with translations and reports them with the request locale\'s display values', async () => {
    const name = uniq('Massage');
    const created = await request.post('/professional-services').set(h()).send({
      name, description: 'Deep tissue',
      translations: { es: { name: 'Masaje', description: 'Tejido profundo' } },
    });
    expect(created.status).toBe(201);
    expect(created.body.translations.es).toEqual({ name: 'Masaje', description: 'Tejido profundo' });
    expect(created.body.translations.ca).toBeUndefined();

    const es = await request.get(`/professional-services/${created.body.id}`).set(h()).set('x-locale', 'es');
    expect(es.body.display_name).toBe('Masaje');
    // Catalan has no row, so it falls back to the base text.
    const ca = await request.get(`/professional-services/${created.body.id}`).set(h()).set('x-locale', 'ca');
    expect(ca.body.display_name).toBe(name);

    const found = await request.get('/professional-services').set(h()).query({ search: 'Masaje' });
    expect(found.body.map((r: any) => r.id)).toContain(created.body.id);
  });

  it('keeps translations when the field is omitted and clears a locale given blank', async () => {
    const created = await request.post('/professional-services').set(h()).send({
      name: uniq('Physio'), translations: { es: { name: 'Fisio' }, ca: { name: 'Fisio-ca' } },
    });
    const id = created.body.id;

    const keep = await request.put(`/professional-services/${id}`).set(h()).send({ max_capacity: 3 });
    expect(keep.status).toBe(200);
    expect(keep.body.translations.es.name).toBe('Fisio');

    const clear = await request.put(`/professional-services/${id}`).set(h()).send({ translations: { es: { name: '', description: '' } } });
    expect(clear.status).toBe(200);
    expect(clear.body.translations.es).toBeUndefined();
    expect(clear.body.translations.ca.name).toBe('Fisio-ca');
  });

  it('rejects an unsupported locale', async () => {
    const res = await request.post('/professional-services').set(h()).send({
      name: uniq('Bad'), translations: { fr: { name: 'x' } },
    });
    expect(res.status).toBe(400);
  });

  it('copies translations on Duplicate', async () => {
    const created = await request.post('/professional-services').set(h()).send({
      name: uniq('Yoga'), translations: { es: { name: 'Yoga-es' } },
    });
    const copy = await request.post(`/professional-services/${created.body.id}/duplicate`).set(h());
    expect(copy.status).toBe(201);
    expect(copy.body.translations.es.name).toBe('Yoga-es - Copy');
  });
});
