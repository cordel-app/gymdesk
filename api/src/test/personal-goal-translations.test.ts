// #1719 — a Personal Goal's name and description in every language: the
// `translations` field of `POST`/`PUT /personal-goals`, the localized reads, the
// multilingual search, Duplicate, tenant isolation and the seeded System goals.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const RUN = `${Date.now()}`;
let gymId: string;
let otherGymId: string;

function api(method: 'get' | 'post' | 'put' | 'delete', path: string, gym: string, locale?: string) {
  const req = request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
  return locale ? req.set('x-locale', locale) : req;
}
const createGoal = (body: Record<string, unknown>, gym = gymId) => api('post', '/personal-goals', gym).send(body);

beforeAll(async () => {
  gymId = await createTestGym('PG Trans Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('PG Trans Other');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('System Personal Goals (migration 292 seeds)', () => {
  it("read in the caller's language, with English as the base", async () => {
    const es = await api('get', '/personal-goals?search=weight_loss', gymId, 'es');
    const system = es.body.items.find((g: any) => g.slug === 'weight_loss');
    expect(system.display_name).toBe('Pérdida de peso');
    expect(system.translations.ca.name).toBe('Pèrdua de pes');
    const en = await api('get', '/personal-goals?search=weight_loss', gymId, 'en');
    expect(en.body.items.find((g: any) => g.slug === 'weight_loss').display_name).toBe('Weight Loss');
  });
});

describe('translations on a gym Personal Goal', () => {
  it('are written with the goal and read back localized, falling back to the base text', async () => {
    const created = await createGoal({
      name: `Stamina ${RUN}`, description: 'Last longer',
      translations: { es: { name: `Resistencia ${RUN}`, description: 'Aguanta más' }, ca: { name: `Resistència ${RUN}` } },
    });
    expect(created.status).toBe(201);
    expect(created.body.translations.es.description).toBe('Aguanta más');

    const es = await api('get', `/personal-goals?search=${RUN}`, gymId, 'es');
    const goal = es.body.items.find((g: any) => g.id === created.body.id);
    expect(goal.display_name).toBe(`Resistencia ${RUN}`);
    expect(goal.display_description).toBe('Aguanta más');

    const ca = await api('get', `/personal-goals?search=${RUN}`, gymId, 'ca');
    const caGoal = ca.body.items.find((g: any) => g.id === created.body.id);
    expect(caGoal.display_name).toBe(`Resistència ${RUN}`);
    expect(caGoal.display_description).toBe('Last longer');

    const found = await api('get', `/personal-goals?search=${encodeURIComponent(`Resistència ${RUN}`)}`, gymId, 'en');
    expect(found.body.items.map((g: any) => g.id)).toContain(created.body.id);
  });

  it('an update that omits translations leaves them; editing one locale keeps the others; {} clears', async () => {
    const created = await createGoal({
      name: `Keep ${RUN}`, translations: { es: { name: `Mantener ${RUN}` }, ca: { name: `Mantenir ${RUN}` } },
    });
    const rename = await api('put', `/personal-goals/${created.body.id}`, gymId).send({ name: `Keep2 ${RUN}` });
    expect(rename.body.translations.es.name).toBe(`Mantener ${RUN}`);

    const edit = await api('put', `/personal-goals/${created.body.id}`, gymId)
      .send({ translations: { es: { name: `Conservar ${RUN}` }, ca: { name: `Mantenir ${RUN}` } } });
    expect(edit.body.translations.es.name).toBe(`Conservar ${RUN}`);
    expect(edit.body.translations.ca.name).toBe(`Mantenir ${RUN}`);

    const cleared = await api('put', `/personal-goals/${created.body.id}`, gymId).send({ translations: {} });
    expect(cleared.body.translations).toEqual({});
  });

  it("one goal's translations never reach another", async () => {
    const a = await createGoal({ name: `A ${RUN}`, translations: { es: { name: `Uno ${RUN}` } } });
    const b = await createGoal({ name: `B ${RUN}` });
    expect(b.body.translations).toEqual({});
    await api('put', `/personal-goals/${b.body.id}`, gymId).send({ translations: { es: { name: `Dos ${RUN}` } } });
    const reread = await api('get', `/personal-goals?search=${encodeURIComponent(`Uno ${RUN}`)}`, gymId, 'es');
    const item = reread.body.items.find((g: any) => g.id === a.body.id);
    expect(item.display_name).toBe(`Uno ${RUN}`);
  });

  it('refuses a bad payload without writing anything', async () => {
    const bad = await createGoal({ name: `Bad ${RUN}`, translations: { en: { name: 'x' } } });
    expect(bad.status).toBe(400);
    const noName = await createGoal({ name: `Bad2 ${RUN}`, translations: { es: { description: 'sin nombre' } } });
    expect(noName.status).toBe(400);
    const { rows } = await db.query('SELECT id FROM personal_goals WHERE gym_id = ? AND name LIKE ?', [gymId, `Bad%${RUN}`]);
    expect(rows).toHaveLength(0);
  });

  it("another gym's goal is a 404 for an update", async () => {
    const other = await createGoal({ name: `Other ${RUN}` }, otherGymId);
    const res = await api('put', `/personal-goals/${other.body.id}`, gymId).send({ translations: { es: { name: 'x' } } });
    expect(res.status).toBe(404);
  });

  it('Duplicate carries the translations onto the copy', async () => {
    const created = await createGoal({ name: `Orig ${RUN}`, translations: { es: { name: `Original ${RUN}` } } });
    const copy = await api('post', `/personal-goals/${created.body.id}/duplicate`, gymId).send({});
    expect(copy.status).toBe(201);
    expect(copy.body.translations.es.name).toBe(`Original ${RUN}`);
  });

  it('unauthenticated requests are 401', async () => {
    const res = await request.get('/personal-goals/locales');
    expect(res.status).toBe(401);
  });
});
