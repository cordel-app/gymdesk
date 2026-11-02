// #2262 — a **Staff's image**: `POST`/`DELETE /staff/:id/image`, the two WebP
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

const FIRST = 'Image';
const LAST = 'Staff';
let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let staffId: number;
let otherStaffId: number;
let noBucketStaffId: number;
let readOnlyStaffId: number;

async function createStaff(gym: string, first: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO staff (gym_id, first_name, last_name, email, profile, hire_date, created_by)
     VALUES (?, ?, 'Staff', ?, 'trainer_performance', '2026-01-01', 'test')`,
    [gym, first, `${first.toLowerCase().replace(/ /g, '')}-${gym}@example.test`]);
  return insertId as number;
}
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM staff WHERE id = ?', [id]);
  return rows[0];
}
function upload(path: string, gym: string, body: Buffer, contentType = 'image/jpeg') {
  return request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).set('Content-Type', contentType).send(body);
}
function remove(path: string, gym: string) {
  return request.delete(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}

beforeAll(async () => {
  gymId = await createTestGym('StaffImagesGym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-StaffImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('StaffImagesOther');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-StaffImagesOther`, otherGymId]);

  noBucketGymId = await createTestGym('StaffImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  readOnlyGymId = await createTestGym('StaffImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-StaffImagesReadOnly`, readOnlyGymId]);

  staffId = await createStaff(gymId, FIRST);
  otherStaffId = await createStaff(otherGymId, 'Other');
  noBucketStaffId = await createStaff(noBucketGymId, 'NoBucket');
  readOnlyStaffId = await createStaff(readOnlyGymId, 'ReadOnly');
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
  await db.query('UPDATE staff SET first_name = ?, last_name = ?, image_url = NULL, image_thumbnail_url = NULL WHERE id = ?', [FIRST, LAST, staffId]);
  await db.query(
    'UPDATE staff SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?)',
    [otherStaffId, noBucketStaffId, readOnlyStaffId],
  );
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /staff/:id/image', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/staff/${staffId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await upload(`/staff/${readOnlyStaffId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect((await urlsOf(readOnlyStaffId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's staff, and writes nothing", async () => {
    const res = await upload(`/staff/${otherStaffId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(otherStaffId)).image_url).toBeNull();
  });

  it('returns 409 when the gym bucket is not initialized, and uploads nothing', async () => {
    const res = await upload(`/staff/${noBucketStaffId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses something that is not a picture, and writes nothing', async () => {
    const res = await upload(`/staff/${staffId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(staffId)).image_url).toBeNull();
  });

  it('stores a 1080 and a 256 WebP under <prefix>/staff/ and persists both URLs', async () => {
    const res = await upload(`/staff/${staffId}/image`, gymId, await photo('jpeg', 800, 600));
    expect(res.status).toBe(200);
    const key = `${gymPrefix}/staff/${staffId}-Image-Staff.webp`;
    const thumbKey = `${gymPrefix}/staff/${staffId}-Image-Staff-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    const master = await sharp(putBody(key)).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    const thumb = await sharp(putBody(thumbKey)).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
    expect(res.body.image_url).toBe(url(key));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));
    expect(await urlsOf(staffId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });

    const list = await request.get('/staff').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(list.body.find((c: any) => c.id === staffId).image_thumbnail_url).toBe(url(thumbKey));
  });

  it('moves the objects when the Staff member is renamed', async () => {
    await upload(`/staff/${staffId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await request.put(`/staff/${staffId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ first_name: 'Renamed' });
    expect(res.status).toBe(200);
    const newKey = `${gymPrefix}/staff/${staffId}-Renamed-Staff.webp`;
    expect(copies().map((c) => c.to)).toContain(newKey);
    expect((await urlsOf(staffId)).image_url).toBe(url(newKey));
    expect(deletedKeys()).toContain(`${gymPrefix}/staff/${staffId}-Image-Staff.webp`);
  });
});

describe('DELETE /staff/:id/image', () => {
  it("returns 404 for another gym's staff and keeps its image", async () => {
    await db.query('UPDATE staff SET image_url = ? WHERE id = ?', [url('x/staff/1-a.webp'), otherStaffId]);
    const res = await remove(`/staff/${otherStaffId}/image`, gymId);
    expect(res.status).toBe(404);
    expect((await urlsOf(otherStaffId)).image_url).not.toBeNull();
  });

  it('clears both references and deletes only the gym\'s own objects', async () => {
    await upload(`/staff/${staffId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await remove(`/staff/${staffId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await urlsOf(staffId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([
      `${gymPrefix}/staff/${staffId}-Image-Staff.webp`,
      `${gymPrefix}/staff/${staffId}-Image-Staff-thumbnail.webp`,
    ].sort());
  });

  it('never deletes an object outside the gym staff/ folder', async () => {
    await db.query('UPDATE staff SET image_url = ?, image_thumbnail_url = ? WHERE id = ?',
      ['https://elsewhere.test/a.webp', url('cordel/products/1-a.webp'), staffId]);
    const res = await remove(`/staff/${staffId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });
});
