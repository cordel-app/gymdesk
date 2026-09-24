// Tests for public-registrations.ts router
// #599: POST /public/gyms/:gymRef/registrations — website self-registration. No Clerk
// session: the gym's website authenticates with the per-gym key in `x-api-key`. The
// route only ever issues a Clerk invitation; the members row is created later by
// POST /me/link (see me-link-self-registration.test.ts).
// #645: :gymRef is `{gymId}-{gym-name}`, a bare slug is still accepted, and
// `{ name: 'test', email: '' }` is a health check that registers nobody.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { generateWebsiteApiKey } from '../infra/website-api-key';
import { cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

// Per-test control over the Clerk side effects (the global mock in setup.ts builds
// fresh vi.fn()s per client, which a test can't reach).
const clerk = vi.hoisted(() => ({
  getUser: vi.fn(),
  createInvitation: vi.fn(),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: clerk.getUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
        updateUserMetadata: vi.fn().mockResolvedValue({}),
      },
      invitations: {
        createInvitation: clerk.createInvitation,
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

const ENV_KEYS = ['PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR', 'PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY'] as const;
const savedEnv: Record<string, string | undefined> = {};

let gymId: string;
let slug: string;
let ref: string;
let centerId: number;
let apiKey: string;

let seq = 0;
const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 7)}@public-reg.test`;

async function slugOf(id: string): Promise<string> {
  const { rows } = await db.query<{ slug: string }>('SELECT slug FROM gyms WHERE id = ?', [id]);
  return rows[0].slug;
}

async function insertCenter(id: string, name = 'Main Center'): Promise<number> {
  const { insertId } = await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')`, [id, name]);
  return insertId as number;
}

/** Setup via SQL: store the hash + prefix exactly as POST /system/website-integration/key would. */
async function setApiKey(id: string): Promise<string> {
  const { key, hash, prefix } = await generateWebsiteApiKey();
  await db.query(
    `UPDATE gyms SET website_api_key_hash = ?, website_api_key_prefix = ?, website_api_key_created_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [hash, prefix, id],
  );
  return key;
}

/** A gym ready to accept registrations: one center + a configured key. */
async function createRegistrationGym(name: string) {
  const id = await createTestGym(name);
  const center = await insertCenter(id);
  const gymSlug = await slugOf(id);
  return { id, slug: gymSlug, ref: `${id}-${gymSlug}`, centerId: center, key: await setApiKey(id) };
}

function register(gymRef: string, key: string | undefined, body: Record<string, unknown>) {
  const req = request.post(`/public/gyms/${gymRef}/registrations`);
  if (key !== undefined) req.set('x-api-key', key);
  return req.send(body);
}

async function membersByEmail(email: string) {
  const { rows } = await db.query<any>('SELECT * FROM members WHERE email = ?', [email]);
  return rows;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Limits are read from env on every request — keep the per-IP limiter out of the way.
  process.env.PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR = '1000';
  delete process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY;

  const gym = await createRegistrationGym('Public Reg Gym');
  gymId = gym.id;
  slug = gym.slug;
  ref = gym.ref;
  centerId = gym.centerId;
  apiKey = gym.key;
  await createTestMembership(gymId, 'admin'); // uses TEST_USER_ID
});

beforeEach(() => {
  clerk.createInvitation.mockReset().mockResolvedValue({ id: 'inv-test-id' });
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await cleanupTestGyms();
  await db.end(); // must be last
});

describe('POST /public/gyms/:gymRef/registrations — API key guard', () => {
  it('returns 401 with no x-api-key header', async () => {
    const res = await register(ref, undefined, { name: 'Ana', email: uniqueEmail('nokey') });
    expect(res.status).toBe(401);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong key', async () => {
    const res = await register(ref, (await generateWebsiteApiKey()).key, { name: 'Ana', email: uniqueEmail('wrongkey') });
    expect(res.status).toBe(401);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('returns 401 for an unknown gym reference — same response as a wrong key', async () => {
    const wrongKey = await register(ref, 'gdk_nope', { name: 'Ana', email: uniqueEmail('a') });
    const unknown = await register(`no-such-gym-${Date.now()}`, apiKey, { name: 'Ana', email: uniqueEmail('b') });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongKey.body);

    // #645: an unknown gym id is the same 401, and so is a real gym's name
    // carried by somebody else's id — the id is what identifies the gym.
    const unknownId = await register(`3f9c1c6e-0000-4000-8000-000000000000-${slug}`, apiKey, { name: 'Ana', email: uniqueEmail('c') });
    expect(unknownId.status).toBe(401);
    expect(unknownId.body).toEqual(wrongKey.body);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("returns 401 when gym B's valid key is used against gym A's endpoint (tenant isolation)", async () => {
    const gymB = await createRegistrationGym('Public Reg Gym B');
    const email = uniqueEmail('crossgym');

    const res = await register(ref, gymB.key, { name: 'Ana', email });

    expect(res.status).toBe(401);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    // ...and the key still works where it belongs.
    const own = await register(gymB.ref, gymB.key, { name: 'Ana', email });
    expect(own.status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup.gym_id).toBe(gymB.id);
  });

  it('returns 401 when the gym has no key configured', async () => {
    const bareId = await createTestGym('Public Reg No Key');
    await insertCenter(bareId);
    const bareRef = `${bareId}-${await slugOf(bareId)}`;

    expect((await register(bareRef, apiKey, { name: 'Ana', email: uniqueEmail('nokeygym') })).status).toBe(401);
    expect((await register(bareRef, '', { name: 'Ana', email: uniqueEmail('nokeygym') })).status).toBe(401);
    expect((await register(bareRef, undefined, { name: 'Ana', email: uniqueEmail('nokeygym') })).status).toBe(401);
  });

  it('ignores a Clerk session: a valid Authorization header without the key is still 401', async () => {
    const res = await request
      .post(`/public/gyms/${ref}/registrations`)
      .set('Authorization', 'Bearer test-token')
      .set('x-gym-id', gymId)
      .send({ name: 'Ana', email: uniqueEmail('bearer') });
    expect(res.status).toBe(401);
  });
});

describe('POST /public/gyms/:gymRef/registrations — validation', () => {
  it('returns 400 for an invalid email', async () => {
    const res = await register(ref, apiKey, { name: 'Ana', email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 when email is missing', async () => {
    const res = await register(ref, apiKey, { name: 'Ana' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing or blank', async () => {
    const missing = await register(ref, apiKey, { email: uniqueEmail('noname') });
    expect(missing.status).toBe(400);
    const blank = await register(ref, apiKey, { name: '   ', email: uniqueEmail('blankname') });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/name/i);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 for an unsupported locale', async () => {
    const res = await register(ref, apiKey, { name: 'Ana', email: uniqueEmail('locale'), locale: 'fr' });
    expect(res.status).toBe(400);
  });

});

describe('POST /public/gyms/:gymRef/registrations — no center (#757)', () => {
  it('a gym with several active centers registers without center_id', async () => {
    const multi = await createRegistrationGym('Public Reg Multi Center');
    await insertCenter(multi.id, 'Second Center');

    const res = await register(multi.ref, multi.key, { name: 'Ana', email: uniqueEmail('multi') });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup).toEqual({ gym_id: multi.id, name: 'Ana' });
  });

  it('a gym whose only center is inactive still registers', async () => {
    const gym = await createRegistrationGym('Public Reg Only Inactive');
    await db.query("UPDATE centers SET status = 'inactive' WHERE id = ? AND gym_id = ?", [gym.centerId, gym.id]);

    const res = await register(gym.ref, gym.key, { name: 'Ana', email: uniqueEmail('only-inactive') });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['this gym\'s center', () => centerId],
    ['a non-existent center', () => 999999999],
    ['garbage', () => 'not-a-number'],
  ])('a center_id sent by an older site (%s) is ignored, not rejected', async (_label, value) => {
    const res = await register(ref, apiKey, { name: 'Ana', email: uniqueEmail('legacy-center'), center_id: value() });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup).toEqual({ gym_id: gymId, name: 'Ana' });
  });
});

describe('POST /public/gyms/:gymRef/registrations — happy path', () => {
  it('returns 202, issues an invitation carrying gym_signup, and creates NO members row', async () => {
    const email = uniqueEmail('happy');

    const res = await register(ref, apiKey, { name: '  Web Person ', email: email.toUpperCase() });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
    const arg = clerk.createInvitation.mock.calls[0][0];
    expect(arg.emailAddress).toBe(email); // lowercased
    expect(arg.publicMetadata).toEqual({ gym_signup: { gym_id: gymId, name: 'Web Person' } });
    // #701: no locale → Spanish, the Clerk template's fallback, so no lang flag.
    expect(arg.redirectUrl.endsWith(`/es/link?gym_id=${gymId}`)).toBe(true);
    expect(arg.redirectUrl.startsWith(process.env.CORDEL_FITNESS_MEMBERS_URL ?? '')).toBe(true);

    expect(await membersByEmail(email)).toHaveLength(0);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE gym_id = ? AND email = ?', [gymId, email]);
    expect(gm).toHaveLength(0);
  });

  it("redirects to the requested member-app locale ('es') with no lang flag", async () => {
    const res = await register(ref, apiKey, { name: 'Ana', email: uniqueEmail('es'), locale: 'es' });
    expect(res.status).toBe(202);
    const arg = clerk.createInvitation.mock.calls[0][0];
    expect(arg.redirectUrl.endsWith(`/es/link?gym_id=${gymId}`)).toBe(true);
    expect(arg.publicMetadata).not.toHaveProperty('lang');
  });

  it.each(['ca', 'en'] as const)("locale '%s' → that link page and a lang flag the email template reads", async (locale) => {
    const res = await register(ref, apiKey, { name: 'Ana', email: uniqueEmail(`lang-${locale}`), locale });
    expect(res.status).toBe(202);
    const arg = clerk.createInvitation.mock.calls[0][0];
    expect(arg.redirectUrl.endsWith(`/${locale}/link?gym_id=${gymId}`)).toBe(true);
    expect(arg.publicMetadata.lang).toEqual({ [locale]: true });
    expect(arg.publicMetadata.gym_signup).toMatchObject({ gym_id: gymId, name: 'Ana' });
  });

});

describe('POST /public/gyms/:gymRef/registrations — never an oracle (always 202)', () => {
  it('staff-login email → 202 and no invitation', async () => {
    const email = uniqueEmail('stafflogin');
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, email) VALUES (?, ?, 'front_desk', 'active', ?)`,
      [`staff-user-${Date.now()}`, gymId, email],
    );

    const res = await register(ref, apiKey, { name: 'Staff Person', email: email.toUpperCase() });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("a staff login of ANOTHER gym is a normal registration here", async () => {
    const other = await createTestGym('Public Reg Staff Elsewhere');
    const email = uniqueEmail('staffelsewhere');
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, email) VALUES (?, ?, 'front_desk', 'active', ?)`,
      [`staff-user-${Date.now()}`, other, email],
    );

    const res = await register(ref, apiKey, { name: 'Ana', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('existing unlinked, never-invited member row → invitation WITHOUT publicMetadata, invitation_id stored', async () => {
    const email = uniqueEmail('staffadded');
    const { insertId } = await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Added By Staff', email, gymId]);
    clerk.createInvitation.mockResolvedValueOnce({ id: 'inv-existing-row' });

    const res = await register(ref, apiKey, { name: 'Different Name', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
    const arg = clerk.createInvitation.mock.calls[0][0];
    expect(arg.emailAddress).toBe(email);
    expect(arg).not.toHaveProperty('publicMetadata');
    expect(arg.redirectUrl.endsWith(`/es/link?gym_id=${gymId}`)).toBe(true);

    const rows = await membersByEmail(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(insertId);
    expect(rows[0].invitation_id).toBe('inv-existing-row');
    expect(rows[0].name).toBe('Added By Staff'); // the website never edits the roster
    expect(rows[0].clerk_user_id).toBeNull();
  });

  it('existing member row + locale ca → invitation carries only the lang flag, no gym_signup', async () => {
    const email = uniqueEmail('staffadded-ca');
    await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Added By Staff', email, gymId]);

    const res = await register(ref, apiKey, { name: 'Ana', email, locale: 'ca' });

    expect(res.status).toBe(202);
    const arg = clerk.createInvitation.mock.calls[0][0];
    expect(arg.publicMetadata).toEqual({ lang: { ca: true } });
    expect(arg.redirectUrl.endsWith(`/ca/link?gym_id=${gymId}`)).toBe(true);
  });

  it('already-invited member → 202 and no second invitation', async () => {
    const email = uniqueEmail('invited');
    await db.query('INSERT INTO members (name, email, gym_id, invitation_id) VALUES (?, ?, ?, ?)', ['Invited', email, gymId, 'inv-earlier']);

    const res = await register(ref, apiKey, { name: 'Invited', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    expect((await membersByEmail(email))[0].invitation_id).toBe('inv-earlier');
  });

  it('already-linked member → 202 and no invitation', async () => {
    const email = uniqueEmail('linked');
    await db.query('INSERT INTO members (name, email, gym_id, clerk_user_id) VALUES (?, ?, ?, ?)', ['Linked', email, gymId, `user_linked_${Date.now()}`]);

    const res = await register(ref, apiKey, { name: 'Linked', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('soft-deleted member → 202 and no invitation', async () => {
    const email = uniqueEmail('softdeleted');
    await db.query('INSERT INTO members (name, email, gym_id, deleted_at) VALUES (?, ?, ?, UTC_TIMESTAMP())', ['Gone', email, gymId]);

    const res = await register(ref, apiKey, { name: 'Gone', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("email on ANOTHER gym's member record → 202, no invitation, that row untouched (members.email is platform-unique)", async () => {
    const other = await createTestGym('Public Reg Member Elsewhere');
    const email = uniqueEmail('elsewhere');
    await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Elsewhere', email, other]);

    const res = await register(ref, apiKey, { name: 'Elsewhere', email });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    const rows = await membersByEmail(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].gym_id).toBe(other);
    expect(rows[0].invitation_id).toBeNull();
  });

  it('Clerk 422 (invitation pending / account exists) → still 202', async () => {
    const email = uniqueEmail('clerk422');
    clerk.createInvitation.mockRejectedValueOnce(Object.assign(new Error('duplicate invitation'), { status: 422 }));

    const res = await register(ref, apiKey, { name: 'Ana', email });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
    expect(await membersByEmail(email)).toHaveLength(0);
  });

  it('Clerk 422 for an existing member row leaves invitation_id NULL', async () => {
    const email = uniqueEmail('clerk422row');
    await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Row', email, gymId]);
    clerk.createInvitation.mockRejectedValueOnce(Object.assign(new Error('duplicate invitation'), { status: 422 }));

    const res = await register(ref, apiKey, { name: 'Row', email });

    expect(res.status).toBe(202);
    expect((await membersByEmail(email))[0].invitation_id).toBeNull();
  });

  it('Clerk 500 → 502 with a generic message', async () => {
    clerk.createInvitation.mockRejectedValueOnce(Object.assign(new Error('clerk exploded: secret detail'), { status: 500 }));

    const res = await register(ref, apiKey, { name: 'Ana', email: uniqueEmail('clerk500') });

    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });
});

describe('POST /public/gyms/:gymRef/registrations — gym reference (#645)', () => {
  it('resolves the gym by id and ignores the readable name half', async () => {
    const res = await register(`${gymId}-any-old-name`, apiKey, { name: 'Ana', email: uniqueEmail('idonly') });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup.gym_id).toBe(gymId);
  });

  it('resolves a bare gym id with no name at all', async () => {
    expect((await register(gymId, apiKey, { name: 'Ana', email: uniqueEmail('bareid') })).status).toBe(202);
  });

  it('still accepts the legacy bare-slug format', async () => {
    const res = await register(slug, apiKey, { name: 'Ana', email: uniqueEmail('legacy') });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup.gym_id).toBe(gymId);
  });

  it('gives two gyms with the same name distinct, non-interchangeable endpoints', async () => {
    const a = await createRegistrationGym('Twin Name Gym');
    const b = await createRegistrationGym('Twin Name Gym');
    expect(a.id).not.toBe(b.id);

    // The readable half is identical in both URLs — only the id differs.
    const refA = `${a.id}-twin-name-gym`;
    const refB = `${b.id}-twin-name-gym`;

    expect((await register(refA, a.key, { name: 'A', email: uniqueEmail('twin-a') })).status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup.gym_id).toBe(a.id);

    clerk.createInvitation.mockClear();
    expect((await register(refB, b.key, { name: 'B', email: uniqueEmail('twin-b') })).status).toBe(202);
    expect(clerk.createInvitation.mock.calls[0][0].publicMetadata.gym_signup.gym_id).toBe(b.id);

    // Same name, so the only thing keeping the keys apart is the id.
    expect((await register(refA, b.key, { name: 'A', email: uniqueEmail('twin-x') })).status).toBe(401);
    expect((await register(refB, a.key, { name: 'B', email: uniqueEmail('twin-y') })).status).toBe(401);
  });
});

describe('POST /public/gyms/:gymRef/registrations — health check (#645)', () => {
  const HEALTH_CHECK = { name: 'test', email: '' };

  /** Everything a registration would write for this gym. */
  async function written() {
    const { rows } = await db.query<{ members: number; invited: number }>(
      'SELECT COUNT(*) AS members, COUNT(invitation_id) AS invited FROM members WHERE gym_id = ?',
      [gymId],
    );
    return rows[0];
  }

  it('returns 200 and creates no member, no invitation and no email', async () => {
    const before = await written();

    const res = await register(ref, apiKey, HEALTH_CHECK);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, health_check: true });
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    expect(await written()).toEqual(before);
  });

  it('tolerates surrounding whitespace and casing', async () => {
    expect((await register(ref, apiKey, { name: ' TEST ', email: '   ' })).status).toBe(200);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it('works through the legacy bare-slug endpoint too', async () => {
    expect((await register(slug, apiKey, HEALTH_CHECK)).status).toBe(200);
  });

  it('returns 401 with a missing, wrong or foreign key — the probe proves the key too', async () => {
    const other = await createRegistrationGym('Public Reg Health Other');

    expect((await register(ref, undefined, HEALTH_CHECK)).status).toBe(401);
    expect((await register(ref, 'gdk_nope', HEALTH_CHECK)).status).toBe(401);
    expect((await register(ref, other.key, HEALTH_CHECK)).status).toBe(401);
    expect((await register(`no-such-gym-${Date.now()}`, apiKey, HEALTH_CHECK)).status).toBe(401);
  });

  it('is not triggered by a real registration that happens to be named "test"', async () => {
    const res = await register(ref, apiKey, { name: 'test', email: uniqueEmail('named-test') });

    expect(res.status).toBe(202);
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('a blank email on any other name is still a 400, not a health check', async () => {
    const res = await register(ref, apiKey, { name: 'Ana', email: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
  });

  it("does not spend the gym's daily registration quota", async () => {
    const limited = await createRegistrationGym('Public Reg Health Quota');
    const previous = process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY;
    process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY = '1';
    try {
      for (let i = 0; i < 3; i++) {
        expect((await register(limited.ref, limited.key, HEALTH_CHECK)).status).toBe(200);
      }
      // The one real registration the quota allows still goes through...
      expect((await register(limited.ref, limited.key, { name: 'One', email: uniqueEmail('hq1') })).status).toBe(202);
      // ...and the quota is spent by registrations only.
      expect((await register(limited.ref, limited.key, { name: 'Two', email: uniqueEmail('hq2') })).status).toBe(429);
      expect((await register(limited.ref, limited.key, HEALTH_CHECK)).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY;
      else process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY = previous;
    }
  });
});

describe('POST /public/gyms/:gymRef/registrations — per-gym rate limit', () => {
  it('returns 429 once the gym has spent its daily quota, without touching other gyms', async () => {
    // The gym limiter is keyed by gym id, so a dedicated gym keeps the quota isolated.
    const limited = await createRegistrationGym('Public Reg Limited');
    const previous = process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY;
    process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY = '2';
    try {
      expect((await register(limited.ref, limited.key, { name: 'One', email: uniqueEmail('rl1') })).status).toBe(202);
      expect((await register(limited.ref, limited.key, { name: 'Two', email: uniqueEmail('rl2') })).status).toBe(202);

      // Unauthenticated calls must not spend the gym's quota (the limiter sits after the key check).
      expect((await register(limited.ref, 'gdk_wrong', { name: 'X', email: uniqueEmail('rlx') })).status).toBe(401);

      const third = await register(limited.ref, limited.key, { name: 'Three', email: uniqueEmail('rl3') });
      expect(third.status).toBe(429);
      expect(third.body).toEqual({ error: 'Too many requests.' });
      expect(clerk.createInvitation).toHaveBeenCalledTimes(2);

      // A different gym is unaffected even at the same low limit.
      const other = await createRegistrationGym('Public Reg Not Limited');
      expect((await register(other.ref, other.key, { name: 'Ok', email: uniqueEmail('rl-other') })).status).toBe(202);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY;
      else process.env.PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY = previous;
    }
  });
});
