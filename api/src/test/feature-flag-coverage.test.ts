// #609/#610: the flags the admin menu gates on must exist and gate their API.
// Toggles flags directly in the DB and clears the 30 s middleware cache; the
// caller is a gym admin (not a superadmin), since superadmins bypass flags.

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const KEYS = ['organization.professional_services', 'financials.assigned_plans', 'financials.taxes', 'financials.gym_charges'];
let original: Record<string, number> = {};
let gymId: string;

async function setFlag(key: string, enabled: boolean) {
  await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [enabled ? 1 : 0, key]);
  invalidateFeatureFlagsCache();
}

const get = (path: string) => request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Flag Coverage Gym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ feature_key: string; enabled: number }>(
    `SELECT feature_key, enabled FROM feature_flags WHERE feature_key IN (${KEYS.map(() => '?').join(',')})`, KEYS,
  );
  original = Object.fromEntries(rows.map((r) => [r.feature_key, r.enabled]));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(original)) await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [v, k]);
  invalidateFeatureFlagsCache();
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('feature flag coverage (#609, #610)', () => {
  it('seeds the three flags the admin menu gates on', () => {
    expect(Object.keys(original).sort()).toEqual([...KEYS].sort());
  });

  it('organization.professional_services now gates /professional-services', async () => {
    expect((await get('/professional-services')).status).toBe(200);
    await setFlag('organization.professional_services', false);
    expect((await get('/professional-services')).status).toBe(403);
  });

  it('financials.taxes blocks Tax writes but not the shared Tax list', async () => {
    await setFlag('financials.taxes', false);
    expect((await get('/taxes')).status).toBe(200);
    const res = await request.post('/taxes').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ name: 'Blocked', rate: 10 });
    expect(res.status).toBe(403);
  });

  it('disabling Sellable Items (financials.gym_charges) no longer breaks the Tax dropdown other forms use', async () => {
    await setFlag('financials.gym_charges', false);
    expect((await get('/sellable-items')).status).toBe(403);
    expect((await get('/taxes')).status).toBe(200);
  });

  it('the Financials group flag still blocks /taxes entirely', async () => {
    await db.query("UPDATE feature_flags SET enabled = 0 WHERE feature_key = 'financials'");
    invalidateFeatureFlagsCache();
    try {
      expect((await get('/taxes')).status).toBe(403);
    } finally {
      await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'financials'");
      invalidateFeatureFlagsCache();
    }
  });
});
