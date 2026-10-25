// #2010 stage 1 — a **Professional Service's image**: `POST`/`DELETE
// /professional-services/:id/image` (a gym's own) and `/platform/professional-services/:id/image`
// (a Base service, under `cordel/`), the two WebP objects the server makes from
// one uploaded original, what may and may not be deleted, and Duplicate
// inheriting the references.
//
// Separate from professional-services.test.ts because this file mocks
// @aws-sdk/client-s3 and moves the CLOUDFLARE_R2_* env around (member-images.test.ts' shape).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import sharp from 'sharp';
import { memberImageMaxBytes } from '../domain/memberImages';

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

/** A picture a phone or a website might send — any size, any accepted format. */
async function photo(format: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg', width = 800, height = 600): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  return base[format]().toBuffer();
}

/** A PNG whose bytes are not a picture, whatever the header claimed. */
const NOT_AN_IMAGE = Buffer.from('this is plain text, not a picture at all');

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue({ publicMetadata: {}, fullName: 'Test User' } as any);
}

function sentCommands(type: 'put' | 'delete' | 'copy') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
}
/** The bytes uploaded under `key`. */
function putBody(key: string): Buffer {
  const command = sentCommands('put').find((c: any) => c.input.Key === key) as any;
  return command.input.Body as Buffer;
}
function putKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key as string).filter((key) => !key.endsWith('/'));
}
function markerKeys(): string[] {
  return sentCommands('put').map((c: any) => c.input.Key as string).filter((key) => key.endsWith('/'));
}
function deletedKeys(): string[] {
  return sentCommands('delete').map((c: any) => c.input.Key as string);
}
function copies(): Array<{ from: string; to: string }> {
  return sentCommands('copy').map((c: any) => ({ from: c.input.CopySource as string, to: c.input.Key as string }));
}

const NAME = 'Nutrition Coaching';
const superadminUser = { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin' };

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let serviceId: number;
let otherGymServiceId: number;
let noBucketServiceId: number;
let readOnlyServiceId: number;
let baseServiceId: number;

async function createService(gym: string | null, name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, ?)',
    [gym, name, gym ? 0 : 1],
  );
  if (gym) {
    await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gym, insertId]);
  }
  return insertId as number;
}
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM professional_services WHERE id = ?', [id]);
  return rows[0];
}
function upload(path: string, gym: string | null, body: Buffer, contentType = 'image/jpeg') {
  const req = request.post(path).set('Authorization', TEST_AUTH_HEADER).set('Content-Type', contentType);
  if (gym) req.set('x-gym-id', gym);
  return req.send(body);
}
function remove(path: string, gym: string | null) {
  const req = request.delete(path).set('Authorization', TEST_AUTH_HEADER);
  if (gym) req.set('x-gym-id', gym);
  return req.send();
}
function duplicate(id: number, gym: string) {
  return request.post(`/professional-services/${id}/duplicate`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}
function mockAsSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue(superadminUser as any);
}

beforeAll(async () => {
  gymId = await createTestGym('PSImagesGym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-PSImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('PSImagesOther');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-PSImagesOther`, otherGymId]);

  noBucketGymId = await createTestGym('PSImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  readOnlyGymId = await createTestGym('PSImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-PSImagesReadOnly`, readOnlyGymId]);

  serviceId = await createService(gymId, NAME);
  otherGymServiceId = await createService(otherGymId, 'Other Gym Service');
  noBucketServiceId = await createService(noBucketGymId, 'No Bucket Service');
  readOnlyServiceId = await createService(readOnlyGymId, 'Read Only Service');
  baseServiceId = await createService(null, `PSImagesBase-${Date.now()}`);
});

afterAll(async () => {
  await db.query('DELETE FROM professional_services WHERE id = ?', [baseServiceId]);
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  mockAsNonSuperadmin();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query('DELETE FROM professional_services WHERE gym_id = ? AND id <> ?', [gymId, serviceId]);
  await db.query(
    'UPDATE professional_services SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?, ?, ?)',
    [serviceId, otherGymServiceId, noBucketServiceId, readOnlyServiceId, baseServiceId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /professional-services/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/professional-services/${serviceId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await upload(`/professional-services/${readOnlyServiceId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect((await urlsOf(readOnlyServiceId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's service, and writes nothing", async () => {
    const res = await upload(`/professional-services/${otherGymServiceId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses a Base service from a gym (403), and writes nothing', async () => {
    const res = await upload(`/professional-services/${baseServiceId}/image`, gymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(baseServiceId)).image_url).toBeNull();
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/professional-services/${noBucketServiceId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('a gym service image: upload, replacement and inheritance', () => {
  const masterKey = () => `${gymPrefix}/professional_services/${serviceId}-Nutrition-Coaching.webp`;
  const thumbKey = () => `${gymPrefix}/professional_services/${serviceId}-Nutrition-Coaching-thumbnail.webp`;

  it('stores a 1080 WebP master and a 256 WebP thumbnail and points the row at both', async () => {
    const res = await upload(`/professional-services/${serviceId}/image`, gymId, await photo('png', 900, 400), 'image/png');
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([masterKey(), thumbKey()]);
    const master = await sharp(putBody(masterKey())).metadata();
    const thumb = await sharp(putBody(thumbKey())).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
    expect(await urlsOf(serviceId)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
    expect(res.body.image_url).toBe(url(masterKey()));
    expect(res.body.status).toBe('active');
  });

  it('keeps the existing image when the replacement is not a picture', async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await upload(`/professional-services/${serviceId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(serviceId)).image_url).toBe(url(masterKey()));
  });

  it('the list and the single read report both URLs', async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    const one = await request.get(`/professional-services/${serviceId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(one.body.image_url).toBe(url(masterKey()));
    expect(one.body.image_thumbnail_url).toBe(url(thumbKey()));
    const list = await request.get('/professional-services').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(list.body.find((r: any) => r.id === serviceId).image_thumbnail_url).toBe(url(thumbKey()));
  });

  it('Duplicate inherits both URLs and copies, uploads and processes nothing', async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await duplicate(serviceId, gymId);
    expect(res.status).toBe(201);
    expect(sendMock).not.toHaveBeenCalled();
    expect(await urlsOf(res.body.id)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
  });

  it("replacing the source's image never overwrites or deletes what a copy still shows", async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    const copy = await duplicate(serviceId, gymId);
    sendMock.mockClear();

    const res = await upload(`/professional-services/${serviceId}/image`, gymId, await photo('png'), 'image/png');
    expect(res.status).toBe(200);
    expect(putKeys()).not.toContain(masterKey());
    expect(putKeys()).not.toContain(thumbKey());
    expect(deletedKeys()).toEqual([]);
    expect(await urlsOf(copy.body.id)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
  });

  it('removing an image deletes its objects unless a copy still references them', async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    const copy = await duplicate(serviceId, gymId);
    sendMock.mockClear();

    expect((await remove(`/professional-services/${serviceId}/image`, gymId)).status).toBe(200);
    expect(deletedKeys()).toEqual([]);
    expect((await urlsOf(serviceId)).image_url).toBeNull();

    sendMock.mockClear();
    expect((await remove(`/professional-services/${copy.body.id}/image`, gymId)).status).toBe(200);
    expect(deletedKeys().sort()).toEqual([masterKey(), thumbKey()].sort());
  });

  it('a rename moves both objects to the new name', async () => {
    await upload(`/professional-services/${serviceId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await request.put(`/professional-services/${serviceId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ name: 'Renamed Coaching' });
    expect(res.status).toBe(200);
    expect(copies().map((c) => c.to).sort()).toEqual([
      `${gymPrefix}/professional_services/${serviceId}-Renamed-Coaching-thumbnail.webp`,
      `${gymPrefix}/professional_services/${serviceId}-Renamed-Coaching.webp`,
    ]);
    expect((await urlsOf(serviceId)).image_url).toBe(url(`${gymPrefix}/professional_services/${serviceId}-Renamed-Coaching.webp`));
    await db.query('UPDATE professional_services SET name = ? WHERE id = ?', [NAME, serviceId]);
  });
});

describe('a Base service image (/platform)', () => {
  const masterKey = () => `cordel/professional_services/${baseServiceId}-`;

  it('refuses a non-superadmin', async () => {
    const res = await upload(`/platform/professional-services/${baseServiceId}/image`, null, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
  });

  it('stores the pair under cordel/professional_services/ and reports it on the read', async () => {
    mockAsSuperadmin();
    const res = await upload(`/platform/professional-services/${baseServiceId}/image`, null, await photo());
    expect(res.status).toBe(200);
    const keys = putKeys();
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith(masterKey()))).toBe(true);
    expect(keys.some((k) => k.endsWith('-thumbnail.webp'))).toBe(true);
    expect(res.body.image_url).toMatch(/\/cordel\/professional_services\/\d+-.*\.webp$/);
    const one = await request.get(`/platform/professional-services/${baseServiceId}`).set('Authorization', TEST_AUTH_HEADER);
    expect(one.body.image_thumbnail_url).toMatch(/-thumbnail\.webp$/);
  });

  it('removes only its own objects and clears the row', async () => {
    mockAsSuperadmin();
    await upload(`/platform/professional-services/${baseServiceId}/image`, null, await photo());
    sendMock.mockClear();
    const res = await remove(`/platform/professional-services/${baseServiceId}/image`, null);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(2);
    expect((await urlsOf(baseServiceId)).image_url).toBeNull();
  });

  it("returns 404 for a gym's own service", async () => {
    mockAsSuperadmin();
    const res = await upload(`/platform/professional-services/${serviceId}/image`, null, await photo());
    expect(res.status).toBe(404);
  });
});
