// #1514 — a **Membership Plan's image**: `POST`/`DELETE /membership-plans/:id/image`,
// the two WebP objects the server makes from one uploaded original, what the gym
// may and may not delete, and the rename migration in `PUT /membership-plans/:id`.
//
// Separate from membership-plans.test.ts because this file mocks
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


const PLAN_NAME = 'Gold Plan 2026';
const SANITIZED = 'Gold-Plan-2026';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let planId: number;
let otherGymPlanId: number;
let noBucketPlanId: number;
let readOnlyPlanId: number;

async function createPlan(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'public')",
    [gym, name],
  );
  return insertId as number;
}
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM membership_plans WHERE id = ?', [id]);
  return rows[0];
}
function upload(path: string, gym: string | null, body: Buffer, contentType = 'image/jpeg') {
  const req = request.post(path).set('Authorization', TEST_AUTH_HEADER).set('Content-Type', contentType);
  if (gym) req.set('x-gym-id', gym);
  return req.send(body);
}
function remove(path: string, gym: string) {
  return request.delete(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}
function rename(id: number, gym: string, name: string) {
  return request.put(`/membership-plans/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send({ name });
}
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

beforeAll(async () => {
  gymId = await createTestGym('PlanImagesGym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-PlanImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('PlanImagesOther');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-PlanImagesOther`, otherGymId]);

  noBucketGymId = await createTestGym('PlanImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  // front_desk is not an admin, so requireRole('admin') answers 403.
  readOnlyGymId = await createTestGym('PlanImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-PlanImagesReadOnly`, readOnlyGymId]);

  planId = await createPlan(gymId, PLAN_NAME);
  otherGymPlanId = await createPlan(otherGymId, 'Other Gym Plan');
  noBucketPlanId = await createPlan(noBucketGymId, 'No Bucket Plan');
  readOnlyPlanId = await createPlan(readOnlyGymId, 'Read Only Plan');
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
  await db.query('UPDATE membership_plans SET image_url = NULL, image_thumbnail_url = NULL, name = ?, deleted_at = NULL WHERE id = ?', [PLAN_NAME, planId]);
  await db.query('UPDATE membership_plans SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?)', [otherGymPlanId, noBucketPlanId, readOnlyPlanId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /membership-plans/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/membership-plans/${planId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await upload(`/membership-plans/${readOnlyPlanId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(readOnlyPlanId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's plan, and writes nothing", async () => {
    const res = await upload(`/membership-plans/${otherGymPlanId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(otherGymPlanId)).image_url).toBeNull();
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/membership-plans/${noBucketPlanId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('POST /membership-plans/:id/image — validation', () => {
  it('refuses a non-image content type and bytes that are not a picture', async () => {
    expect((await upload(`/membership-plans/${planId}/image`, gymId, await photo(), 'application/pdf')).status).toBe(415);
    const res = await upload(`/membership-plans/${planId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses an oversized body', async () => {
    const big = Buffer.concat([await photo(), Buffer.alloc(memberImageMaxBytes())]);
    expect((await upload(`/membership-plans/${planId}/image`, gymId, big)).status).toBe(413);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('POST /membership-plans/:id/image — storing', () => {
  it('stores a 1080 and a 256 WebP under plans/ and points the row at both', async () => {
    const res = await upload(`/membership-plans/${planId}/image`, gymId, await photo('png', 900, 500), 'image/png');
    expect(res.status).toBe(200);
    const key = `${gymPrefix}/plans/${planId}-${SANITIZED}.webp`;
    const thumbKey = `${gymPrefix}/plans/${planId}-${SANITIZED}-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumbKey].sort());
    const master = await sharp(putBody(key)).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    const thumb = await sharp(putBody(thumbKey)).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
    expect(await urlsOf(planId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumbKey) });
    expect(res.body.image_url).toBe(url(key));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey));
    expect(deletedKeys()).toHaveLength(0);
  });

  it('changes nothing else about the plan', async () => {
    const before = await request.get(`/membership-plans/${planId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    await upload(`/membership-plans/${planId}/image`, gymId, await photo(), 'image/jpeg');
    const after = await request.get(`/membership-plans/${planId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const strip = ({ image_url, image_thumbnail_url, modified_at, modified_by, ...rest }: any) => rest;
    expect(strip(after.body)).toEqual(strip(before.body));
  });
});

describe('DELETE /membership-plans/:id/image', () => {
  it('clears both references and deletes the gym-owned objects', async () => {
    const key = `${gymPrefix}/plans/${planId}-${SANITIZED}.webp`;
    const thumbKey = `${gymPrefix}/plans/${planId}-${SANITIZED}-thumbnail.webp`;
    await db.query('UPDATE membership_plans SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key), url(thumbKey), planId]);
    const res = await remove(`/membership-plans/${planId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await urlsOf(planId)).toEqual({ image_url: null, image_thumbnail_url: null });
    expect(deletedKeys().sort()).toEqual([key, thumbKey].sort());
  });

  it('never deletes an object outside the gym\'s plans/ folder', async () => {
    await db.query('UPDATE membership_plans SET image_url = ? WHERE id = ?', [url(`gyms/${otherGymId}-PlanImagesOther/plans/9-x.webp`), planId]);
    const res = await remove(`/membership-plans/${planId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it("returns 404 for another gym's plan", async () => {
    expect((await remove(`/membership-plans/${otherGymPlanId}/image`, gymId)).status).toBe(404);
  });
});

describe('PUT /membership-plans/:id — rename', () => {
  it('moves the image onto the keys the new name builds', async () => {
    const key = `${gymPrefix}/plans/${planId}-${SANITIZED}.webp`;
    const thumbKey = `${gymPrefix}/plans/${planId}-${SANITIZED}-thumbnail.webp`;
    await db.query('UPDATE membership_plans SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key), url(thumbKey), planId]);
    const res = await rename(planId, gymId, 'Silver Plan');
    expect(res.status).toBe(200);
    const newKey = `${gymPrefix}/plans/${planId}-Silver-Plan.webp`;
    const newThumb = `${gymPrefix}/plans/${planId}-Silver-Plan-thumbnail.webp`;
    expect(await urlsOf(planId)).toEqual({ image_url: url(newKey), image_thumbnail_url: url(newThumb) });
    expect(res.body.image_url).toBe(url(newKey));
    expect(sentCommands('copy')).toHaveLength(2);
    expect(deletedKeys().sort()).toEqual([key, thumbKey].sort());
  });
});
