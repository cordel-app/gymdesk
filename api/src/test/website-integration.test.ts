// Tests for website-integration.ts router
// #599: GET /system/website-integration, POST + DELETE /system/website-integration/key —
// an admin manages the per-gym key the gym's website presents to
// POST /public/gyms/:slug/registrations. The plaintext key is returned exactly once.

import { verifyToken } from '@clerk/backend';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { verifyWebsiteApiKey } from '../infra/website-api-key';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const BASE = '/system/website-integration';

let gymId: string;
let slug: string;

let seq = 0;
const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 7)}@website-int.test`;

async function gymRow(id: string) {
  const { rows } = await db.query<{
    slug: string; website_api_key_hash: string | null; website_api_key_prefix: string | null; website_api_key_created_at: Date | null;
  }>(
    'SELECT slug, website_api_key_hash, website_api_key_prefix, website_api_key_created_at FROM gyms WHERE id = ?',
    [id],
  );
  return rows[0];
}

const authed = (method: 'get' | 'post' | 'delete', path: string, id: string) =>
  request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', id);

/** Calls the public registration route the key is meant for. */
const registerWith = (gymSlug: string, key: string) =>
  request.post(`/public/gyms/${gymSlug}/registrations`).set('x-api-key', key).send({ name: 'Web Person', email: uniqueEmail('reg') });

/** A fresh gym with TEST_USER_ID as admin and the single center the public route needs. */
async function createAdminGym(name: string) {
  const id = await createTestGym(name);
  await createTestMembership(id, 'admin');
  await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'Main Center', 'active')`, [id]);
  return { id, slug: (await gymRow(id)).slug };
}

let savedIpLimit: string | undefined;

beforeAll(async () => {
  savedIpLimit = process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR;
  process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR = '1000';
  const gym = await createAdminGym('Website Integration Gym');
  gymId = gym.id;
  slug = gym.slug;
});

afterAll(async () => {
  if (savedIpLimit === undefined) delete process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR;
  else process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR = savedIpLimit;
  await cleanupTestGyms();
  await db.end(); // must be last
});

describe('website-integration — auth and role guards', () => {
  it('returns 401 without auth', async () => {
    expect((await request.get(BASE)).status).toBe(401);
    expect((await request.post(`${BASE}/key`)).status).toBe(401);
    expect((await request.delete(`${BASE}/key`)).status).toBe(401);
  });

  it('returns 403 when the user has no membership in this gym', async () => {
    const otherId = await createTestGym('Website Integration No Membership');
    expect((await authed('get', BASE, otherId)).status).toBe(403);
    expect((await authed('post', `${BASE}/key`, otherId)).status).toBe(403);
    expect((await gymRow(otherId)).website_api_key_hash).toBeNull();
  });

  // SYSTEM is admin=RW and NONE for every other role (infra/permissions.ts).
  it.each(['front_desk', 'trainer_performance', 'accountant', 'member'] as const)(
    'returns 403 for role %s on GET, POST /key and DELETE /key',
    async (role) => {
      const roleGym = await createTestGym(`Website Integration ${role}`);
      const userId = `wi-${role}-${Date.now()}`;
      await createTestMembership(roleGym, role, userId);

      for (const [method, path] of [['get', BASE], ['post', `${BASE}/key`], ['delete', `${BASE}/key`]] as const) {
        vi.mocked(verifyToken).mockResolvedValueOnce({ sub: userId } as any);
        const res = await authed(method, path, roleGym);
        expect(res.status).toBe(403);
      }
      expect((await gymRow(roleGym)).website_api_key_hash).toBeNull();
    },
  );
});

describe('website-integration — key lifecycle', () => {
  let firstKey: string;
  let secondKey: string;

  it('GET when unconfigured → configured:false, key_prefix:null and the endpoint path', async () => {
    const res = await authed('get', BASE, gymId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      key_prefix: null,
      created_at: null,
      slug,
      endpoint_path: `/public/gyms/${slug}/registrations`,
    });
    expect(res.body).not.toHaveProperty('key');
  });

  it('DELETE /key with no key → 404', async () => {
    const res = await authed('delete', `${BASE}/key`, gymId);
    expect(res.status).toBe(404);
  });

  it('POST /key → 201 with a gdk_ key; the DB holds only a scrypt digest', async () => {
    const res = await authed('post', `${BASE}/key`, gymId);

    expect(res.status).toBe(201);
    expect(typeof res.body.key).toBe('string');
    expect(res.body.key.startsWith('gdk_')).toBe(true);
    expect(res.body).toMatchObject({
      configured: true,
      key_prefix: res.body.key.slice(0, 12),
      endpoint_path: `/public/gyms/${slug}/registrations`,
    });
    expect(res.body.created_at).toBeTruthy();
    firstKey = res.body.key;

    const row = await gymRow(gymId);
    expect(row.website_api_key_hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(row.website_api_key_hash).not.toContain(firstKey);
    expect(await verifyWebsiteApiKey(firstKey, row.website_api_key_hash, row.website_api_key_prefix)).toBe(true);
    expect(row.website_api_key_prefix).toBe(firstKey.slice(0, 12));
    expect(row.website_api_key_created_at).not.toBeNull();
    // The plaintext key is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(firstKey);
  });

  it('GET afterwards reports the prefix but never the key or its hash', async () => {
    const res = await authed('get', BASE, gymId);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.key_prefix).toBe(firstKey.slice(0, 12));
    expect(res.body).not.toHaveProperty('key');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(firstKey);
    expect(raw).not.toContain((await gymRow(gymId)).website_api_key_hash!);
    expect(raw).not.toContain('scrypt$');
  });

  it('the returned key authenticates against the public registration route', async () => {
    expect((await registerWith(slug, firstKey)).status).toBe(202);
  });

  it('POST /key again rotates: the old key is 401 immediately, the new key works', async () => {
    const res = await authed('post', `${BASE}/key`, gymId);

    expect(res.status).toBe(201);
    secondKey = res.body.key;
    expect(secondKey.startsWith('gdk_')).toBe(true);
    expect(secondKey).not.toBe(firstKey);
    const rotated = await gymRow(gymId);
    expect(await verifyWebsiteApiKey(secondKey, rotated.website_api_key_hash, rotated.website_api_key_prefix)).toBe(true);
    expect(await verifyWebsiteApiKey(firstKey, rotated.website_api_key_hash, rotated.website_api_key_prefix)).toBe(false);

    expect((await registerWith(slug, firstKey)).status).toBe(401);
    expect((await registerWith(slug, secondKey)).status).toBe(202);
  });

  it('DELETE /key → configured:false, columns cleared, and the key stops working', async () => {
    const res = await authed('delete', `${BASE}/key`, gymId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, key_prefix: null, created_at: null });
    expect(res.body).not.toHaveProperty('key');

    const row = await gymRow(gymId);
    expect(row.website_api_key_hash).toBeNull();
    expect(row.website_api_key_prefix).toBeNull();
    expect(row.website_api_key_created_at).toBeNull();

    expect((await registerWith(slug, secondKey)).status).toBe(401);
    expect((await authed('get', BASE, gymId)).body.configured).toBe(false);
  });

  it('DELETE /key a second time → 404', async () => {
    expect((await authed('delete', `${BASE}/key`, gymId)).status).toBe(404);
  });
});

describe('website-integration — audit trail', () => {
  it('records create / rotate / revoke with the key prefix only — never the key or its hash', async () => {
    const gym = await createAdminGym('Website Integration Audit');
    const first = await authed('post', `${BASE}/key`, gym.id);
    const second = await authed('post', `${BASE}/key`, gym.id);
    expect((await authed('delete', `${BASE}/key`, gym.id)).status).toBe(200);

    // recordAudit is fire-and-forget, so poll for the three rows.
    const rows = await vi.waitFor(async () => {
      const { rows: found } = await db.query<any>(
        `SELECT action, entity_id, previous_values, new_values FROM audit_logs
         WHERE gym_id = ? AND entity_type = 'website_api_key' ORDER BY id`,
        [gym.id],
      );
      expect(found).toHaveLength(3);
      return found;
    }, { timeout: 5000, interval: 50 });

    expect(rows.map((r: any) => r.action)).toEqual(['create', 'rotate', 'revoke']);
    const raw = JSON.stringify(rows);
    expect(raw).toContain(first.body.key_prefix);
    expect(raw).toContain(second.body.key_prefix);
    for (const key of [first.body.key, second.body.key]) {
      expect(raw).not.toContain(key);
    }
    expect(raw).not.toContain('scrypt$'); // no stored digest either
  });
});

describe('website-integration — tenant isolation', () => {
  it("generating, rotating and revoking gym A's key never touches gym B", async () => {
    const gymA = await createAdminGym('Website Integration Iso A');
    const gymB = await createAdminGym('Website Integration Iso B');

    const created = await authed('post', `${BASE}/key`, gymA.id);
    expect(created.status).toBe(201);

    // B is still unconfigured, in the API and in the DB.
    const statusB = await authed('get', BASE, gymB.id);
    expect(statusB.body).toMatchObject({
      configured: false, key_prefix: null, endpoint_path: `/public/gyms/${gymB.slug}/registrations`,
    });
    expect((await gymRow(gymB.id)).website_api_key_hash).toBeNull();
    // A's key is worthless against B's slug.
    expect((await registerWith(gymB.slug, created.body.key)).status).toBe(401);

    // B gets its own key; revoking A's leaves B's working.
    const createdB = await authed('post', `${BASE}/key`, gymB.id);
    expect(createdB.body.key).not.toBe(created.body.key);
    expect((await authed('delete', `${BASE}/key`, gymA.id)).status).toBe(200);
    const rowB = await gymRow(gymB.id);
    expect(await verifyWebsiteApiKey(createdB.body.key, rowB.website_api_key_hash, rowB.website_api_key_prefix)).toBe(true);
    expect((await registerWith(gymB.slug, createdB.body.key)).status).toBe(202);
    expect((await registerWith(gymA.slug, created.body.key)).status).toBe(401);
  });
});

// gyms.ts reads gym rows with `SELECT g.*`, so a new column on `gyms` is
// serialised unless `stripGymSecrets` drops it.
describe('website-integration — the key hash never leaves through the gyms API', () => {
  it('GET /gyms omits website_api_key_hash for a gym with a live key', async () => {
    const gym = await createAdminGym('Website Integration Leak Check');
    expect((await authed('post', `${BASE}/key`, gym.id)).status).toBe(201);
    const hash = (await gymRow(gym.id)).website_api_key_hash!;

    const res = await request.get('/gyms').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const listed = res.body.find((g: any) => g.id === gym.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('website_api_key_hash');
    expect(JSON.stringify(res.body)).not.toContain(hash);
  });
});
