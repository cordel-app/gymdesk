// #2261 — a **Center's image**: `POST`/`DELETE /centers/:id/image`, the two WebP
// objects the server makes from one uploaded original, tenant isolation, and the
// rename moving the objects.
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

const NAME = 'Image Center';
let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let centerId: number;
let otherCenterId: number;
let noBucketCenterId: number;
let readOnlyCenterId: number;

async function createCenter(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, created_by) VALUES (?, ?, ?)', [gym, name, 'test']);
  return insertId as number;
}
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM centers WHERE id = ?', [id]);
  return rows[0];
}
function upload(path: string, gym: string, body: Buffer, contentType = 'image/jpeg') {
  return request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).set('Content-Type', contentType).send(body);
}
function remove(path: string, gym: string) {
  return request.delete(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}

beforeAll(async () => {
  gymId = await createTestGym('CenterImagesGym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-CenterImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('CenterImagesOther');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-CenterImagesOther`, otherGymId]);

  noBucketGymId = await createTestGym('CenterImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  readOnlyGymId = await createTestGym('CenterImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-CenterImagesReadOnly`, readOnlyGymId]);

  centerId = await createCenter(gymId, NAME);
  otherCenterId = await createCenter(otherGymId, 'Other Center');
  noBucketCenterId = await createCenter(noBucketGymId, 'No Bucket Center');
  readOnlyCenterId = await createCenter(readOnlyGymId, 'Read Only Center');
});

afterAll(async () => {
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
  await db.query('UPDATE centers SET name = ?, image_url = NULL, image_thumbnail_url = NULL WHERE id = ?', [NAME, centerId]);
  await db.query(
    'UPDATE centers SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?)',
    [otherCenterId, noBucketCenterId, readOnlyCenterId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /centers/:id/image', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/centers/${centerId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await upload(`/centers/${readOnlyCenterId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect((await urlsOf(readOnlyCenterId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's center, and writes nothing", async () => {
    const res = await upload(`/centers/${otherCenterId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(otherCenterId)).image_url).toBeNull();
  });

  it('returns 409 when the gym bucket is not initialized, and uploads nothing', async () => {
    const res = await upload(`/centers/${noBucketCenterId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses something that is not a picture, and writes nothing', async () => {
    const res = await upload(`/centers/${centerId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(centerId)).image_url).toBeNull();
  });

  it('stores a 1080 and a 256 WebP under <prefix>/centers/ and persists both URLs', async () => {
    const res = await upload(`/centers/${centerId}/image`, gymId, await photo('jpeg', 800, 600));
    expect(res.status).toBe(200);
    const key = `${gymPrefix}/centers/${centerId}-Image-Center.webp`;
    const thumbKey = `${gymPrefix}/centers/${centerId}-Image-Center-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    const master = await sharp(putBody(key)).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    const thumb = await sharp(putBody(thumbKey)).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
    expect(res.body.image_url).toBe(url(key));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));
    expect(await urlsOf(centerId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });

    const list = await request.get('/centers').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(list.body.find((c: any) => c.id === centerId).image_thumbnail_url).toBe(url(thumbKey));
  });

  it('moves the objects when the Center is renamed', async () => {
    await upload(`/centers/${centerId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await request.put(`/centers/${centerId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ name: 'Renamed Center' });
    expect(res.status).toBe(200);
    const newKey = `${gymPrefix}/centers/${centerId}-Renamed-Center.webp`;
    expect(copies().map((c) => c.to)).toContain(newKey);
    expect((await urlsOf(centerId)).image_url).toBe(url(newKey));
    expect(deletedKeys()).toContain(`${gymPrefix}/centers/${centerId}-Image-Center.webp`);
  });
});

describe('DELETE /centers/:id/image', () => {
  it("returns 404 for another gym's center and keeps its image", async () => {
    await db.query('UPDATE centers SET image_url = ? WHERE id = ?', [url('x/centers/1-a.webp'), otherCenterId]);
    const res = await remove(`/centers/${otherCenterId}/image`, gymId);
    expect(res.status).toBe(404);
    expect((await urlsOf(otherCenterId)).image_url).not.toBeNull();
  });

  it('clears both references and deletes only the gym\'s own objects', async () => {
    await upload(`/centers/${centerId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await remove(`/centers/${centerId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await urlsOf(centerId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      `${gymPrefix}/centers/${centerId}-Image-Center.webp`,
      `${gymPrefix}/centers/${centerId}-Image-Center-thumbnail.webp`,
    ].sort());
  });

  it('never deletes an object outside the gym centers/ folder', async () => {
    await db.query('UPDATE centers SET image_url = ?, image_thumbnail_url = ? WHERE id = ?',
      ['https://elsewhere.test/a.webp', url('cordel/products/1-a.webp'), centerId]);
    const res = await remove(`/centers/${centerId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });
});
