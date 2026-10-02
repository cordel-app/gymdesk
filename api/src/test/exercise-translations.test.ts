// #967 — multilingual exercise names, end to end.
//
// `exercises.name` stays the base (English) value an edit form submits back, and
// `exercise_translations` (migration 208) carries one row per (exercise, locale).
// Every read resolves the caller's `x-locale` into `display_name`, falls back to
// the base name, and carries the stored map as `translations` so the editor can
// seed its inputs from the row it already holds.
//
// Covered here: tenant isolation, auth, the happy path on both routers, the
// replace-all write rule (including the omitted-field case that must *not* clear
// anything), search across any translation, locale-aware ordering, and the copy
// paths — Duplicate, Clone and the Base Exercise import, which is what makes §4
// true for a gym.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const NAME_PREFIX = 'Zz967 ';
const baseIds: number[] = [];

let gymId: string;
let otherGymId: string;

const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin' };
const regularUser = { publicMetadata: {}, fullName: 'Test User' };

function mockUser(user: unknown) {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(user as any);
}

beforeEach(() => { mockUser(regularUser); });

function gymRequest(method: 'get' | 'post' | 'put', path: string, locale?: string, gym = gymId) {
  const req = request[method](path)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
  return locale ? req.set('x-locale', locale) : req;
}

async function createBaseExercise(name: string, translations: Record<string, string> = {}): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, status) VALUES (NULL, ?, 'active')",
    [name],
  );
  baseIds.push(insertId);
  for (const [locale, value] of Object.entries(translations)) {
    await db.query(
      'INSERT INTO exercise_translations (exercise_id, locale, name) VALUES (?, ?, ?)',
      [insertId, locale, value],
    );
  }
  return insertId;
}

async function storedTranslations(id: number): Promise<Record<string, string>> {
  const { rows } = await db.query<{ locale: string; name: string }>(
    'SELECT locale, name FROM exercise_translations WHERE exercise_id = ? ORDER BY locale',
    [id],
  );
  return Object.fromEntries(rows.map((r) => [r.locale, r.name]));
}

beforeAll(async () => {
  gymId = await createTestGym('Exercise Translations Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Exercise Translations Other Gym');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  if (baseIds.length > 0) {
    const marks = baseIds.map(() => '?').join(',');
    await db.query(`DELETE FROM exercises WHERE cloned_from_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, baseIds);
  }
  await db.query(`DELETE FROM exercises WHERE name LIKE '${NAME_PREFIX}%'`);
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /exercises/locales ───────────────────────────────────────────────────

describe('GET /exercises/locales', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/exercises/locales').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('reports the application\'s own language configuration, base locale apart', async () => {
    const res = await gymRequest('get', '/exercises/locales');
    expect(res.status).toBe(200);
    expect(res.body.locales).toContain(res.body.base_locale);
    expect(res.body.translatable).not.toContain(res.body.base_locale);
    for (const locale of res.body.translatable) expect(res.body.locales).toContain(locale);
  });

  it('is not read as an exercise id', async () => {
    // Registered before `/:id`; otherwise Express answers this route's name as a
    // lookup and the editor has no locale list.
    const res = await gymRequest('get', '/exercises/locales');
    expect(res.body.id).toBeUndefined();
  });
});

// ─── Writing them ─────────────────────────────────────────────────────────────

describe('POST /exercises with translations', () => {
  it('stores the per-locale names and reports them back', async () => {
    const res = await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Bench Press`,
      translations: { es: 'Press de Banca', ca: 'Press de banca' },
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${NAME_PREFIX}Bench Press`);
    expect(res.body.translations).toEqual({ es: 'Press de Banca', ca: 'Press de banca' });
    expect(await storedTranslations(res.body.id)).toEqual({ ca: 'Press de banca', es: 'Press de Banca' });
  });

  it('creates an exercise with its base name alone when the field is absent', async () => {
    const res = await gymRequest('post', '/exercises').send({ name: `${NAME_PREFIX}Plank` });
    expect(res.status).toBe(201);
    // §9: a translation is never invented for an exercise that has one name.
    expect(res.body.translations).toEqual({});
  });

  it('rejects the base locale, an unknown locale and an over-long name', async () => {
    const base = await gymRequest('post', '/exercises')
      .send({ name: `${NAME_PREFIX}Rejected A`, translations: { en: 'Bench Press' } });
    expect(base.status).toBe(400);
    expect(base.body.error).toMatch(/base locale/);

    const unknown = await gymRequest('post', '/exercises')
      .send({ name: `${NAME_PREFIX}Rejected B`, translations: { fr: 'Développé Couché' } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/unsupported locale/);

    const long = await gymRequest('post', '/exercises')
      .send({ name: `${NAME_PREFIX}Rejected C`, translations: { es: 'x'.repeat(201) } });
    expect(long.status).toBe(400);
  });
});

describe('PUT /exercises/:id with translations', () => {
  let id: number;

  beforeEach(async () => {
    mockUser(regularUser);
    const res = await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Squat ${Date.now()}`,
      translations: { es: 'Sentadilla', ca: 'Esquat' },
    });
    id = res.body.id;
  });

  it('replaces the whole set, dropping a locale the payload omits', async () => {
    const res = await gymRequest('put', `/exercises/${id}`).send({ translations: { es: 'Sentadilla profunda' } });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ es: 'Sentadilla profunda' });
    expect(await storedTranslations(id)).toEqual({ es: 'Sentadilla profunda' });
  });

  it('clears them all on an explicit empty set', async () => {
    const res = await gymRequest('put', `/exercises/${id}`).send({ translations: {} });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({});
    expect(await storedTranslations(id)).toEqual({});
  });

  it('leaves them untouched when the request never mentions the field', async () => {
    // The load-bearing case: a client written before this ticket, or one editing
    // another field, must not wipe a gym's translations.
    const res = await gymRequest('put', `/exercises/${id}`).send({ description: 'Legs' });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ es: 'Sentadilla', ca: 'Esquat' });
  });

  it('rejects an unsupported locale without writing anything', async () => {
    const res = await gymRequest('put', `/exercises/${id}`).send({ translations: { fr: 'Squat' } });
    expect(res.status).toBe(400);
    expect(await storedTranslations(id)).toEqual({ ca: 'Esquat', es: 'Sentadilla' });
  });
});

// ─── Reading them ─────────────────────────────────────────────────────────────

describe('display_name follows x-locale', () => {
  let id: number;

  beforeAll(async () => {
    mockUser(regularUser);
    const res = await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Deadlift`,
      translations: { es: 'Peso Muerto' },
    });
    id = res.body.id;
  });

  it('resolves the translated name for a locale that has one', async () => {
    const res = await gymRequest('get', `/exercises/${id}`, 'es');
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Peso Muerto');
    // `name` is still the base value, so the edit form cannot overwrite the
    // English original by saving in Spanish.
    expect(res.body.name).toBe(`${NAME_PREFIX}Deadlift`);
  });

  it('falls back to the base name for a locale that has none', async () => {
    const res = await gymRequest('get', `/exercises/${id}`, 'ca');
    expect(res.body.display_name).toBe(`${NAME_PREFIX}Deadlift`);
  });

  it('reads the base name with no x-locale at all', async () => {
    const res = await gymRequest('get', `/exercises/${id}`);
    expect(res.body.display_name).toBe(`${NAME_PREFIX}Deadlift`);
  });

  it('carries both fields on the list read too, so ⋮ → Edit can seed from the row', async () => {
    const res = await gymRequest('get', '/exercises', 'es');
    const row = res.body.find((r: any) => Number(r.id) === id);
    expect(row.display_name).toBe('Peso Muerto');
    expect(row.translations).toEqual({ es: 'Peso Muerto' });
  });

  it('404s for another gym\'s exercise', async () => {
    const res = await gymRequest('get', `/exercises/${id}`, 'es', otherGymId);
    expect(res.status).toBe(404);
  });
});

describe('search and ordering follow the translations', () => {
  beforeAll(async () => {
    mockUser(regularUser);
    await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Pull Up`,
      translations: { es: `${NAME_PREFIX}Dominada` },
    });
  });

  it('finds an exercise by a translated name (§7)', async () => {
    const res = await gymRequest('get', `/exercises?q=${encodeURIComponent('Dominada')}`, 'es');
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.name)).toContain(`${NAME_PREFIX}Pull Up`);
  });

  it('finds it by its translated name even when reading in another language', async () => {
    const res = await gymRequest('get', `/exercises?q=${encodeURIComponent('Dominada')}`, 'ca');
    expect(res.body.map((r: any) => r.name)).toContain(`${NAME_PREFIX}Pull Up`);
  });

  it('still finds it by its base name', async () => {
    const res = await gymRequest('get', `/exercises?q=${encodeURIComponent('Pull Up')}`, 'es');
    expect(res.body.map((r: any) => r.name)).toContain(`${NAME_PREFIX}Pull Up`);
  });

  it('orders by the displayed name', async () => {
    // Two exercises whose base order is the reverse of their Spanish order, so
    // the assertion fails if the ORDER BY reads the base column.
    // The Spanish order is the reverse of the base order, so this fails if the
    // ORDER BY reads the base column.
    await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Zz Alpha`, translations: { es: `${NAME_PREFIX}Zzb Alpha` },
    });
    await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Zz Beta`, translations: { es: `${NAME_PREFIX}Zza Beta` },
    });
    const res = await gymRequest('get', `/exercises?q=${encodeURIComponent(`${NAME_PREFIX}Zz`)}`, 'es');
    const names = res.body.map((r: any) => r.display_name);
    expect(names.indexOf(`${NAME_PREFIX}Zza Beta`)).toBeLessThan(names.indexOf(`${NAME_PREFIX}Zzb Alpha`));
  });
});

// ─── The copy paths ───────────────────────────────────────────────────────────

describe('a copy is a copy', () => {
  it('Duplicate carries the translations onto the copy', async () => {
    const created = await gymRequest('post', '/exercises').send({
      name: `${NAME_PREFIX}Row`,
      translations: { es: 'Remo', ca: 'Rem' },
    });
    const res = await gymRequest('post', `/exercises/${created.body.id}/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body.translations).toEqual({ es: 'Remo', ca: 'Rem' });
  });

  it('Clone carries a Base Exercise\'s translations into the gym\'s catalogue', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Base Lunge`, { es: 'Zancada', ca: 'Gambada' });
    const res = await gymRequest('post', `/exercises/${baseId}/clone`);
    expect(res.status).toBe(201);
    expect(res.body.translations).toEqual({ es: 'Zancada', ca: 'Gambada' });
  });

  it('Import preserves the catalogue\'s three names (§4)', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Base Dip`, { es: 'Fondo', ca: 'Fons' });
    const res = await gymRequest('post', '/exercises/import').send({ baseExerciseIds: [baseId] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.imported[0].translations).toEqual({ es: 'Fondo', ca: 'Fons' });
  });

  it('a re-import never overwrites a translation the gym has corrected (§4)', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Base Curl`, { es: 'Curl' });
    const first = await gymRequest('post', '/exercises/import').send({ baseExerciseIds: [baseId] });
    const copyId = Number(first.body.imported[0].id);
    await gymRequest('put', `/exercises/${copyId}`).send({ translations: { es: 'Curl de bíceps' } });

    const again = await gymRequest('post', '/exercises/import').send({ baseExerciseIds: [baseId] });
    expect(again.status).toBe(201);
    expect(await storedTranslations(copyId)).toEqual({ es: 'Curl de bíceps' });
  });

  it('lists the Base Exercises library in the reader\'s language', async () => {
    const baseId = await createBaseExercise(`${NAME_PREFIX}Base Press`, { es: `${NAME_PREFIX}Prensa` });
    const res = await gymRequest('get', `/exercises/base?q=${encodeURIComponent('Prensa')}`, 'es');
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => Number(r.id) === baseId);
    expect(row).toBeTruthy();
    expect(row.display_name).toBe(`${NAME_PREFIX}Prensa`);
  });
});

// ─── The platform router ──────────────────────────────────────────────────────

describe('/platform/exercises', () => {
  beforeEach(() => { mockUser(superadminUser); });

  function platform(method: 'get' | 'post' | 'put', path: string, locale?: string) {
    const req = request[method](path).set('Authorization', TEST_AUTH_HEADER);
    return locale ? req.set('x-locale', locale) : req;
  }

  it('returns 403 for an authenticated non-superadmin', async () => {
    mockUser(regularUser);
    const res = await platform('post', '/platform/exercises')
      .send({ name: `${NAME_PREFIX}Platform Denied` });
    expect(res.status).toBe(403);
  });

  it('carries the locale list on /lookups, so the shared editor needs no language list', async () => {
    const res = await platform('get', '/platform/exercises/lookups');
    expect(res.status).toBe(200);
    expect(res.body.locales).toContain(res.body.base_locale);
    expect(res.body.translatable).not.toContain(res.body.base_locale);
  });

  it('writes and resolves a Base Exercise\'s names exactly as the gym router does', async () => {
    const created = await platform('post', '/platform/exercises').send({
      name: `${NAME_PREFIX}Base Overhead Press`,
      translations: { es: 'Press Militar', ca: 'Press Militar' },
    });
    expect(created.status).toBe(201);
    baseIds.push(created.body.id);
    expect(created.body.translations).toEqual({ es: 'Press Militar', ca: 'Press Militar' });

    const read = await platform('get', `/platform/exercises/${created.body.id}`, 'es');
    expect(read.body.display_name).toBe('Press Militar');
    expect(read.body.name).toBe(`${NAME_PREFIX}Base Overhead Press`);

    const updated = await platform('put', `/platform/exercises/${created.body.id}`)
      .send({ translations: { es: 'Press de hombros' } });
    expect(updated.status).toBe(200);
    expect(updated.body.translations).toEqual({ es: 'Press de hombros' });

    const untouched = await platform('put', `/platform/exercises/${created.body.id}`)
      .send({ description: 'Shoulders' });
    expect(untouched.body.translations).toEqual({ es: 'Press de hombros' });
  });

  it('rejects the base locale on a Base Exercise too', async () => {
    const res = await platform('post', '/platform/exercises')
      .send({ name: `${NAME_PREFIX}Base Rejected`, translations: { en: 'Nope' } });
    expect(res.status).toBe(400);
  });
});
