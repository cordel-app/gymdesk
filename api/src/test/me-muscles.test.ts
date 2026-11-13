// #2333 stage 4: GET /me/muscles, the muscle names the Members App shows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

const NAME = 'Test Muscle T2333S4';
let memberGymId: string;
let staffGymId: string;
let slug: string;

beforeAll(async () => {
  memberGymId = await createTestGym('Me Muscles Gym');
  staffGymId = await createTestGym('Me Muscles Staff Gym');
  await createTestMembership(memberGymId, 'member');
  await createTestMembership(staffGymId, 'front_desk');
  slug = `test_muscle_t2333s4_${Date.now()}`;
  const { insertId } = await db.query('INSERT INTO muscles (name, slug) VALUES (?, ?)', [NAME, slug]);
  await db.query("INSERT INTO muscle_translations (muscle_id, locale, name) VALUES (?, 'es', 'Músculo socio')", [insertId]);
});

afterAll(async () => {
  await db.query('DELETE FROM muscles WHERE name = ?', [NAME]);
  await cleanupTestGyms();
  await db.end();
});

const as = (gymId: string, locale: string) =>
  request.get('/me/muscles').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).set('x-locale', locale);

describe('GET /me/muscles (#2333 stage 4)', () => {
  it('rejects an unauthenticated request', async () => {
    await request.get('/me/muscles').set('x-gym-id', memberGymId).expect(401);
  });

  it('is the member\'s own read: a staff role is refused', async () => {
    await as(staffGymId, 'en').expect(403);
  });

  it('names a muscle in the request language, as Cordel → Muscles stores it', async () => {
    const es = await as(memberGymId, 'es').expect(200);
    expect(es.body.find((m: any) => m.key === slug)).toEqual({ key: slug, display_name: 'Músculo socio' });
    // The seeded catalogue reads translated too (migration backfill, stage 2).
    expect(es.body.find((m: any) => m.key === 'chest').display_name).toBe('Pecho');
  });

  it('falls back to the base name for a language with no translation', async () => {
    const ca = await as(memberGymId, 'ca').expect(200);
    expect(ca.body.find((m: any) => m.key === slug).display_name).toBe(NAME);
  });
});
