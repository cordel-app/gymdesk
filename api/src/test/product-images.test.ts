// #1715 — a **Product's image**: `POST`/`DELETE /products/:id/image`,
// the two WebP objects the server makes from one uploaded original, what the gym
// may and may not delete, and Duplicate inheriting the references.
//
// Separate from products.test.ts because this file mocks
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



const PRODUCT_NAME = 'Locker Rental';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let productId: number;
let otherGymProductId: number;
let noBucketProductId: number;
let readOnlyProductId: number;

async function createProduct(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO products (gym_id, name, type, status, enrollment_status, is_system) VALUES (?, ?, 'other', 'active', 'public', 0)",
    [gym, name],
  );
  return insertId as number;
}
async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM products WHERE id = ?', [id]);
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
function duplicate(id: number, gym: string) {
  return request.post(`/products/${id}/duplicate`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}

beforeAll(async () => {
  gymId = await createTestGym('ProductImagesGym');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-ProductImagesGym`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('ProductImagesOther');
  await createTestMembership(otherGymId, 'admin');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${otherGymId}-ProductImagesOther`, otherGymId]);

  noBucketGymId = await createTestGym('ProductImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  readOnlyGymId = await createTestGym('ProductImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-ProductImagesReadOnly`, readOnlyGymId]);

  productId = await createProduct(gymId, PRODUCT_NAME);
  otherGymProductId = await createProduct(otherGymId, 'Other Gym Product');
  noBucketProductId = await createProduct(noBucketGymId, 'No Bucket Product');
  readOnlyProductId = await createProduct(readOnlyGymId, 'Read Only Product');
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
  await db.query('DELETE FROM products WHERE gym_id = ? AND id <> ?', [gymId, productId]);
  await db.query('UPDATE products SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?, ?)', [productId, otherGymProductId, noBucketProductId, readOnlyProductId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('POST /products/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/products/${productId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await upload(`/products/${readOnlyProductId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect((await urlsOf(readOnlyProductId)).image_url).toBeNull();
  });

  it("returns 404 for another gym's product, and writes nothing", async () => {
    const res = await upload(`/products/${otherGymProductId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/products/${noBucketProductId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });
});

describe('product image upload, replacement and inheritance', () => {
  const masterKey = () => `${gymPrefix}/products/${productId}-Locker-Rental.webp`;
  const thumbKey = () => `${gymPrefix}/products/${productId}-Locker-Rental-thumbnail.webp`;

  it('stores a 1080 WebP master and a 256 WebP thumbnail and points the row at both', async () => {
    const res = await upload(`/products/${productId}/image`, gymId, await photo('png', 900, 400), 'image/png');
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([masterKey(), thumbKey()]);
    const master = await sharp(putBody(masterKey())).metadata();
    const thumb = await sharp(putBody(thumbKey())).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
    expect(await urlsOf(productId)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
    expect(res.body.image_url).toBe(url(masterKey()));
  });

  it('keeps the existing image when the replacement is not a picture', async () => {
    await upload(`/products/${productId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await upload(`/products/${productId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(putKeys()).toHaveLength(0);
    expect((await urlsOf(productId)).image_url).toBe(url(masterKey()));
  });

  it('Duplicate inherits both URLs and copies, uploads and processes nothing', async () => {
    await upload(`/products/${productId}/image`, gymId, await photo());
    sendMock.mockClear();
    const res = await duplicate(productId, gymId);
    expect(res.status).toBe(201);
    expect(sendMock).not.toHaveBeenCalled();
    expect(res.body.image_url).toBe(url(masterKey()));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey()));
    expect(await urlsOf(res.body.id)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
  });

  it('Duplicate of a product with no image inherits none', async () => {
    const res = await duplicate(productId, gymId);
    expect(res.status).toBe(201);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
  });

  it("replacing the source's image never overwrites or deletes what a copy still shows", async () => {
    await upload(`/products/${productId}/image`, gymId, await photo());
    const copy = await duplicate(productId, gymId);
    sendMock.mockClear();

    const res = await upload(`/products/${productId}/image`, gymId, await photo('png'), 'image/png');
    expect(res.status).toBe(200);
    expect(putKeys()).not.toContain(masterKey());
    expect(putKeys()).not.toContain(thumbKey());
    expect(deletedKeys()).toEqual([]);
    expect(res.body.image_url).not.toBe(url(masterKey()));
    expect(await urlsOf(copy.body.id)).toEqual({ image_url: url(masterKey()), image_thumbnail_url: url(thumbKey()) });
  });

  it('removing an image deletes its objects unless a copy still references them', async () => {
    await upload(`/products/${productId}/image`, gymId, await photo());
    const copy = await duplicate(productId, gymId);
    sendMock.mockClear();

    expect((await remove(`/products/${productId}/image`, gymId)).status).toBe(200);
    expect(deletedKeys()).toEqual([]);
    expect((await urlsOf(productId)).image_url).toBeNull();

    sendMock.mockClear();
    expect((await remove(`/products/${copy.body.id}/image`, gymId)).status).toBe(200);
    expect(deletedKeys().sort()).toEqual([masterKey(), thumbKey()].sort());
  });
});
