// #1623 — a Nutrition Goal's WebP image and its name/description in every
// language: `POST`/`DELETE /nutrition-goals/:id/image`, the `translations` field
// of `POST`/`PUT /nutrition-goals`, the localized reads and the multilingual
// search. Mocks @aws-sdk/client-s3 (membership-plan-images.test.ts' shape).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import sharp from 'sharp';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'put', input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'get', input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'delete', input })),
  CopyObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'copy', input })),
}));

const R2_ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;
const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
}

async function photo(format: 'jpeg' | 'png' = 'jpeg', width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })[format]().toBuffer();
}

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue({ publicMetadata: {}, fullName: 'Test User' } as any);
}

function sent(type: 'put' | 'delete' | 'copy') {
  return sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === type);
}
const putKeys = () => sent('put').map((c: any) => c.input.Key as string).filter((k) => !k.endsWith('/'));
const deletedKeys = () => sent('delete').map((c: any) => c.input.Key as string);
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

const RUN = `${Date.now()}`;
let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let frontDeskGymId: string;

function api(method: 'get' | 'post' | 'put' | 'delete', path: string, gym: string, locale?: string) {
  const req = request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
  return locale ? req.set('x-locale', locale) : req;
}
async function createGoal(body: Record<string, unknown>, gym = gymId, locale?: string) {
  return api('post', '/nutrition-goals', gym, locale).send(body);
}
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM nutrition_goals WHERE id = ?', [id]);
  return rows[0];
}
function upload(id: number, gym: string, body: Buffer, contentType = 'image/jpeg') {
  return request.post(`/nutrition-goals/${id}/image`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).set('Content-Type', contentType).send(body);
}

beforeAll(async () => {
  gymId = await createTestGym('NG Img Gym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-NGImgGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('NG Img Other');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-NGImgOther`, otherGymId]);

  noBucketGymId = await createTestGym('NG Img NoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  frontDeskGymId = await createTestGym('NG Img FrontDesk');
  await createTestMembership(frontDeskGymId, 'front_desk');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${frontDeskGymId}-NGImgFrontDesk`, frontDeskGymId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(() => {
  setStorageConfigured();
  mockAsNonSuperadmin();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});
afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('System Nutrition Goals (migration 282 seeds)', () => {
  it('read in the caller\'s language and keep the English base when asked in English', async () => {
    const es = await api('get', '/nutrition-goals?search=Protein', gymId, 'es');
    const system = es.body.items.find((g: any) => g.slug === 'protein');
    expect(system.name).toBe('Protein');
    expect(system.display_name).toBe('Proteínas');
    expect(system.display_description).toMatch(/proteínas/);
    expect(system.translations.ca.name).toBe('Proteïnes');

    const en = await api('get', '/nutrition-goals?search=Protein', gymId, 'en');
    expect(en.body.items.find((g: any) => g.slug === 'protein').display_name).toBe('Protein');
  });

  it('are found by a search in another language', async () => {
    const res = await api('get', '/nutrition-goals?search=Hidrats', gymId, 'en');
    expect(res.body.items.map((g: any) => g.slug)).toContain('carbohydrates');
  });

  it('are read-only to a gym for the image too (403)', async () => {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM nutrition_goals WHERE gym_id IS NULL AND slug = 'water'");
    const res = await upload(rows[0].id, gymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('translations on a gym goal', () => {
  it('are written with the goal and read back localized, with a fallback to the base text', async () => {
    const created = await createGoal({
      name: `Hydration ${RUN}`, description: 'Drink enough',
      translations: { es: { name: `Hidratación ${RUN}`, description: 'Bebe suficiente' }, ca: { name: `Hidratació ${RUN}` } },
    });
    expect(created.status).toBe(201);
    expect(created.body.translations.es.description).toBe('Bebe suficiente');

    const es = await api('get', `/nutrition-goals?search=${RUN}`, gymId, 'es');
    const goal = es.body.items.find((g: any) => g.id === created.body.id);
    expect(goal.display_name).toBe(`Hidratación ${RUN}`);
    expect(goal.display_description).toBe('Bebe suficiente');

    // `ca` has a name but no description: the description falls back to the base one.
    const ca = await api('get', `/nutrition-goals?search=${RUN}`, gymId, 'ca');
    const caGoal = ca.body.items.find((g: any) => g.id === created.body.id);
    expect(caGoal.display_name).toBe(`Hidratació ${RUN}`);
    expect(caGoal.display_description).toBe('Drink enough');

    // Searching in a language other than the screen's finds it.
    const found = await api('get', `/nutrition-goals?search=${encodeURIComponent(`Hidratació ${RUN}`)}`, gymId, 'en');
    expect(found.body.items.map((g: any) => g.id)).toContain(created.body.id);
  });

  it('an update that omits translations leaves them; {} clears them', async () => {
    const created = await createGoal({ name: `Keep ${RUN}`, translations: { es: { name: `Mantener ${RUN}` } } });
    const rename = await api('put', `/nutrition-goals/${created.body.id}`, gymId).send({ description: 'Changed' });
    expect(rename.status).toBe(200);
    expect(rename.body.translations.es.name).toBe(`Mantener ${RUN}`);

    const cleared = await api('put', `/nutrition-goals/${created.body.id}`, gymId).send({ translations: {} });
    expect(cleared.body.translations).toEqual({});
  });

  it('refuses a bad payload without writing anything', async () => {
    const bad = await createGoal({ name: `Bad ${RUN}`, translations: { en: { name: 'x' } } });
    expect(bad.status).toBe(400);
    const noName = await createGoal({ name: `Bad2 ${RUN}`, translations: { es: { description: 'sin nombre' } } });
    expect(noName.status).toBe(400);
    const { rows } = await db.query('SELECT id FROM nutrition_goals WHERE gym_id = ? AND name LIKE ?', [gymId, `Bad%${RUN}`]);
    expect(rows).toHaveLength(0);
  });

  it("another gym's goal is a 404 for an update", async () => {
    const other = await createGoal({ name: `Theirs ${RUN}` }, otherGymId);
    const res = await api('put', `/nutrition-goals/${other.body.id}`, gymId).send({ translations: { es: { name: 'x' } } });
    expect(res.status).toBe(404);
  });
});

describe('POST/DELETE /nutrition-goals/:id/image', () => {
  let goalId: number;
  const NAME = `Image Goal ${RUN}`;
  const sanitized = `Image-Goal-${RUN}`;

  beforeEach(async () => {
    const created = await createGoal({ name: NAME });
    goalId = created.body.id;
  });

  it('stores a 1080 and a 256 WebP under nutrition_goals/ and points the row at both', async () => {
    const res = await upload(goalId, gymId, await photo('png', 900, 500), 'image/png');
    expect(res.status).toBe(200);
    const key = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}.webp`;
    const thumbKey = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    const master = sent('put').find((c: any) => c.input.Key === key) as any;
    const meta = await sharp(master.input.Body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1080, 1080]);
    const thumb = sent('put').find((c: any) => c.input.Key === thumbKey) as any;
    const thumbMeta = await sharp(thumb.input.Body).metadata();
    expect([thumbMeta.format, thumbMeta.width, thumbMeta.height]).toEqual(['webp', 256, 256]);
    expect(await urlsOf(goalId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));
  });

  it('refuses a non-image and bytes that are not a picture, uploading nothing', async () => {
    expect((await upload(goalId, gymId, await photo(), 'application/pdf')).status).toBe(415);
    expect((await upload(goalId, gymId, Buffer.from('not a picture'))).status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(goalId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's goal and 409 for a gym with no bucket", async () => {
    expect((await upload(goalId, otherGymId, await photo())).status).toBe(404);
    const own = await createGoal({ name: `NoBucket ${RUN}` }, noBucketGymId);
    expect((await upload(own.body.id, noBucketGymId, await photo())).status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('is a 403 for a role with read-only nutrition access', async () => {
    const res = await upload(goalId, frontDeskGymId, await photo());
    expect(res.status).toBe(403);
  });

  it('DELETE clears both references and deletes only the gym-owned objects', async () => {
    const key = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}.webp`;
    const thumbKey = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}-thumbnail.webp`;
    await db.query('UPDATE nutrition_goals SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key), url(thumbKey), goalId]);
    const res = await api('delete', `/nutrition-goals/${goalId}/image`, gymId).send();
    expect(res.status).toBe(200);
    expect(await urlsOf(goalId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([key, thumbKey].sort());

    await db.query('UPDATE nutrition_goals SET image_url = ? WHERE id = ?', [url('cordel/nutrition_goals/1-x.webp'), goalId]);
    sendMock.mockClear();
    await api('delete', `/nutrition-goals/${goalId}/image`, gymId).send();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('a rename moves the image onto the keys the new name builds', async () => {
    const key = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}.webp`;
    const thumbKey = `${gymPrefix}/nutrition_goals/${goalId}-${sanitized}-thumbnail.webp`;
    await db.query('UPDATE nutrition_goals SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key), url(thumbKey), goalId]);
    const res = await api('put', `/nutrition-goals/${goalId}`, gymId).send({ name: `Renamed ${RUN}` });
    expect(res.status).toBe(200);
    const newKey = `${gymPrefix}/nutrition_goals/${goalId}-Renamed-${RUN}.webp`;
    const newThumb = `${gymPrefix}/nutrition_goals/${goalId}-Renamed-${RUN}-thumbnail.webp`;
    expect(await urlsOf(goalId)).toEqual({ image_url: url(newKey), image_thumbnail_url: url(newThumb) });
    expect(sent('copy')).toHaveLength(2);
    expect(deletedKeys().sort()).toEqual([key, thumbKey].sort());
  });
});

describe('Personal Goals are untouched', () => {
  it("has no WebP image route (the PNG one is Personal Goals' own) and no translations", async () => {
    const created = await request.post('/personal-goals')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ name: `Personal ${RUN}` });
    expect(created.status).toBe(201);
    expect(created.body.translations).toBeUndefined();
    expect(created.body.image_thumbnail_url).toBeUndefined();
  });
});
