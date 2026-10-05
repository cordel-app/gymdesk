// #1039 — the Member's own default language for the Members App:
// `GET`/`PATCH /me/profile` carrying `members.preferred_locale` (migration 220).
//
// Ownership needs no test of its own beyond the 401/403 pair below, and that is
// structural rather than lucky: both routes resolve the member from the
// authenticated context (`resolveMemberId()`), so there is no member id on the
// wire to tamper with (§9's "do not rely solely on the frontend").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;

beforeAll(async () => {
  gymId = await createTestGym('Preferred Locale Gym');
  await createTestMembership(gymId, 'member');
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Locale Member', 'locale-member@example.com', ?)`,
    [gymId, TEST_USER_ID],
  );
  memberId = Number(insertId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

function patch(body: Record<string, unknown>) {
  return request
    .patch('/me/profile')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(body);
}

function read() {
  return request
    .get('/me/profile')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);
}

async function storedLocale(): Promise<string | null> {
  const { rows } = await db.query<{ preferred_locale: string | null }>(
    'SELECT preferred_locale FROM members WHERE id = ?',
    [memberId],
  );
  return rows[0].preferred_locale;
}

describe('PATCH /me/profile preferred_locale', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request.patch('/me/profile').send({ preferred_locale: 'es' });
    expect(res.status).toBe(401);
  });

  it('reports no preference for a member who has never chosen one', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    // §3/§11: NULL means "follow the application's default", never a stored
    // copy of it.
    expect(res.body.preferred_locale).toBeNull();
  });

  it('stores a supported locale and reports it back', async () => {
    const res = await patch({ preferred_locale: 'es' });
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBe('es');
    expect(await storedLocale()).toBe('es');

    const reread = await read();
    expect(reread.body.preferred_locale).toBe('es');
  });

  it('folds a regional tag onto the supported locale', async () => {
    const res = await patch({ preferred_locale: 'ca-ES' });
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBe('ca');
    expect(await storedLocale()).toBe('ca');
  });

  it('refuses an unsupported locale rather than coercing it (§10)', async () => {
    const res = await patch({ preferred_locale: 'fr' });
    expect(res.status).toBe(400);
    // The member asked for something the app cannot render; storing `en` would
    // tell them the choice was saved.
    expect(await storedLocale()).toBe('ca');
  });

  it('refuses a non-string value', async () => {
    const res = await patch({ preferred_locale: 42 });
    expect(res.status).toBe(400);
    expect(await storedLocale()).toBe('ca');
  });

  it('keeps the stored locale when the field is not mentioned', async () => {
    // Every client written before this ticket patches the phone alone.
    const res = await patch({ phone: '+34 600 000 000' });
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBe('ca');
    expect(await storedLocale()).toBe('ca');
  });

  it('clears the preference on an explicit null', async () => {
    const res = await patch({ preferred_locale: null });
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBeNull();
    // The distinction the `IF(?, ?, …)` write exists for: a `COALESCE` on the
    // value would have made this unpersistable.
    expect(await storedLocale()).toBeNull();
  });

  it('clears the preference on an empty string', async () => {
    await patch({ preferred_locale: 'es' });
    const res = await patch({ preferred_locale: '' });
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBeNull();
    expect(await storedLocale()).toBeNull();
  });

  it('reports a stored locale the deployment no longer supports as no preference', async () => {
    // Written directly: the route would refuse it. A locale dropped from
    // `SUPPORTED_LOCALES` has no route segment in the Members App, so the read
    // answers "no preference" while leaving the column alone.
    await db.query('UPDATE members SET preferred_locale = ? WHERE id = ?', ['de', memberId]);
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.preferred_locale).toBeNull();
    expect(await storedLocale()).toBe('de');
    await db.query('UPDATE members SET preferred_locale = NULL WHERE id = ?', [memberId]);
  });
});

describe('PATCH /me/profile preferred_locale — other roles', () => {
  it('returns 403 for a staff login of the same gym', async () => {
    const staffGym = await createTestGym('Preferred Locale Staff Gym');
    await createTestMembership(staffGym, 'admin');
    const res = await request
      .patch('/me/profile')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGym)
      .send({ preferred_locale: 'es' });
    expect(res.status).toBe(403);
  });
});
