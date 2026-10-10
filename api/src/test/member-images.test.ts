// #1374 — a **Member's profile image**: `POST`/`DELETE /members/:id/image`, the
// key the object lands under, what the gym may and may not delete, and the
// rename migration in `PUT /members/:id`.
//
// Separate from members.test.ts because this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around (personal-goal-images.test.ts' shape).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { encodePngRgba } from '../domain/pngImage';
import { MEMBER_IMAGE_MAX_BYTES, MEMBER_IMAGE_SIZE } from '../domain/memberImages';

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

/** A valid upload: PNG, exactly 512×512. */
function validPng(): Buffer {
  return encodePngRgba(MEMBER_IMAGE_SIZE, MEMBER_IMAGE_SIZE, Buffer.alloc(MEMBER_IMAGE_SIZE * MEMBER_IMAGE_SIZE * 4, 0x40));
}

/** A PNG whose IHDR claims `width × height`, colour type 2 (no alpha). */
function opaquePng(width: number, height = width): Buffer {
  const png = Buffer.from(encodePngRgba(1, 1, Buffer.alloc(4, 0x40)));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[25] = 2;
  return png;
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function mockAsNonSuperadmin() {
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue({ publicMetadata: {}, fullName: 'Test User' } as any);
}

function sentCommands(type: 'put' | 'delete' | 'copy') {
  return sendMock.mock.calls.map(([command]) => command).filter((c: any) => c?.__type === type);
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

const MEMBER_NAME = 'Test Image María Pérez';
const SANITIZED = 'Test-Image-Maria-Perez';
const PREFIX_SUFFIX = 'MemberImagesGym';

let gymId: string;
let gymPrefix: string;
let otherGymId: string;
let otherGymPrefix: string;
let noBucketGymId: string;
let readOnlyGymId: string;
let memberId: number;
let otherGymMemberId: number;
let noBucketMemberId: number;
let readOnlyMemberId: number;

async function createMember(gym: string, name: string, email: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, name, email],
  );
  return insertId as number;
}

async function imageUrlOf(id: number): Promise<string | null> {
  const { rows } = await db.query<{ image_url: string | null }>('SELECT image_url FROM members WHERE id = ?', [id]);
  return rows[0]?.image_url ?? null;
}

function upload(path: string, gym: string | null, body: Buffer, contentType = 'image/png') {
  const req = request.post(path).set('Authorization', TEST_AUTH_HEADER).set('Content-Type', contentType);
  if (gym) req.set('x-gym-id', gym);
  return req.send(body);
}
function remove(path: string, gym: string) {
  return request.delete(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send();
}
function rename(id: number, gym: string, name: string) {
  return request.put(`/members/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send({ name });
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

beforeAll(async () => {
  gymId = await createTestGym(PREFIX_SUFFIX);
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-${PREFIX_SUFFIX}`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);

  otherGymId = await createTestGym('MemberImagesOther');
  await createTestMembership(otherGymId, 'admin');
  otherGymPrefix = `gyms/${otherGymId}-MemberImagesOther`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [otherGymPrefix, otherGymId]);

  // Deliberately left with no `storage_folder_prefix`: an upload there is the 409.
  noBucketGymId = await createTestGym('MemberImagesNoBucket');
  await createTestMembership(noBucketGymId, 'admin');

  // nutritionist is R_ASSIGNED on MEMBERS, so every write is a 403.
  readOnlyGymId = await createTestGym('MemberImagesReadOnly');
  await createTestMembership(readOnlyGymId, 'nutritionist');
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [`gyms/${readOnlyGymId}-MemberImagesReadOnly`, readOnlyGymId]);

  memberId = await createMember(gymId, MEMBER_NAME, `member-images-${gymId}@test.local`);
  otherGymMemberId = await createMember(otherGymId, 'Test Image Other Gym', `member-images-${otherGymId}@test.local`);
  noBucketMemberId = await createMember(noBucketGymId, 'Test Image No Bucket', `member-images-${noBucketGymId}@test.local`);
  readOnlyMemberId = await createMember(readOnlyGymId, 'Test Image Read Only', `member-images-${readOnlyGymId}@test.local`);
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
  await db.query('UPDATE members SET image_url = NULL, name = ?, deleted_at = NULL WHERE id = ?', [MEMBER_NAME, memberId]);
  await db.query('UPDATE members SET image_url = NULL WHERE id IN (?, ?, ?)', [otherGymMemberId, noBucketMemberId, readOnlyMemberId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and ownership ──────────────────────────────────────────────────────

describe('POST /members/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/members/${memberId}/image`).set('Content-Type', 'image/png').send(validPng());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a role without write on MEMBERS', async () => {
    const res = await upload(`/members/${readOnlyMemberId}/image`, readOnlyGymId, validPng());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(readOnlyMemberId)).toBeNull();
  });

  it("returns 404 for another gym's member, and writes nothing", async () => {
    const res = await upload(`/members/${otherGymMemberId}/image`, gymId, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(otherGymMemberId)).toBeNull();
  });

  it('returns 404 for a soft-deleted member', async () => {
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/members/${noBucketMemberId}/image`, noBucketGymId, validPng());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 503 when the deployment has no Cloudflare configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(503);
    expect(res.body.missingConfig?.length).toBeGreaterThan(0);
  });
});

// ─── Validation (the file, never the request) ────────────────────────────────

describe('POST /members/:id/image — validation', () => {
  it('refuses a non-PNG content type', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, validPng(), 'image/jpeg');
    expect(res.status).toBe(415);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses bytes that are not a PNG, whatever the header claimed', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_a_png');
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses anything that is not exactly 512×512', async () => {
    for (const [w, h] of [[511, 512], [513, 513], [512, 300]]) {
      sendMock.mockReset();
      sendMock.mockResolvedValue({});
      const res = await upload(`/members/${memberId}/image`, gymId, opaquePng(w, h));
      expect(res.status, `${w}×${h}`).toBe(400);
      expect(res.body.reason).toBe('wrong_dimensions');
      expect(putKeys()).toHaveLength(0);
    }
  });

  it('accepts an opaque 512×512 PNG — a photograph has no alpha channel', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, opaquePng(512));
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(1);
  });

  it('refuses an empty body and an oversized one', async () => {
    expect((await upload(`/members/${memberId}/image`, gymId, Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.concat([validPng(), Buffer.alloc(MEMBER_IMAGE_MAX_BYTES)]);
    expect((await upload(`/members/${memberId}/image`, gymId, big)).status).toBe(413);
    expect(putKeys()).toHaveLength(0);
  });

  it('leaves an existing image untouched when the upload is refused', async () => {
    const existing = url(`${gymPrefix}/members/${memberId}-${SANITIZED}.png`);
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [existing, memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, JPEG_BYTES);
    expect(res.status).toBe(400);
    expect(await imageUrlOf(memberId)).toBe(existing);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('POST /members/:id/image', () => {
  it('stores the object at <gym prefix>/members/<id>-<Name>.png and persists the URL', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(200);

    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    expect(putKeys()).toEqual([key]);
    expect(sentCommands('put').at(-1).input).toMatchObject({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/png' });
    expect(key.startsWith(`${gymPrefix}/`)).toBe(true);
    expect(key).not.toContain('cordel/');

    expect(await imageUrlOf(memberId)).toBe(url(key));
    // The response is the row as GET /:id shapes it.
    expect(res.body.image_url).toBe(url(key));
    expect(res.body).toHaveProperty('is_new_member');
    expect(res.body).toHaveProperty('access_rights');
  });

  it('writes the folder markers between the bucket root and members/', async () => {
    await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(markerKeys()).toEqual([`${gymPrefix}/`, `${gymPrefix}/members/`]);
  });

  it('answers 502 and writes nothing to the row when the upload fails', async () => {
    sendMock.mockRejectedValue(new Error('R2 is down'));
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(502);
    expect(await imageUrlOf(memberId)).toBeNull();
  });

  it('overwrites its own object on a replace, with nothing to sweep', async () => {
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(key), memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([key]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('sweeps the old object only when the key actually moved, and only after the upload', async () => {
    const stale = `${gymPrefix}/members/${memberId}-An-Older-Name.png`;
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(stale), memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, validPng());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([stale]);
    const order = sendMock.mock.calls.map(([c]: any) => c.__type);
    expect(order.indexOf('delete')).toBeGreaterThan(order.lastIndexOf('put'));
    expect(await imageUrlOf(memberId)).toBe(url(`${gymPrefix}/members/${memberId}-${SANITIZED}.png`));
  });

  it("never deletes another gym's object, another feature's, or an external URL", async () => {
    for (const foreign of [
      url(`${otherGymPrefix}/members/${memberId}-${SANITIZED}.png`),
      url(`${gymPrefix}/goals/${memberId}-${SANITIZED}.png`),
      'https://example.org/somebody-elses.png',
    ]) {
      sendMock.mockReset();
      sendMock.mockResolvedValue({});
      await db.query('UPDATE members SET image_url = ? WHERE id = ?', [foreign, memberId]);
      const res = await upload(`/members/${memberId}/image`, gymId, validPng());
      expect(res.status).toBe(200);
      expect(deletedKeys(), foreign).toHaveLength(0);
    }
  });

  it('is reported by GET /members and GET /members/:id', async () => {
    await upload(`/members/${memberId}/image`, gymId, validPng());
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    const one = await request.get(`/members/${memberId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(one.body.image_url).toBe(url(key));
    const list = await request.get('/members').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(list.body.find((m: any) => m.id === memberId)?.image_url).toBe(url(key));
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /members/:id/image', () => {
  it("clears the reference and deletes the gym's own object", async () => {
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(key), memberId]);
    const res = await remove(`/members/${memberId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(deletedKeys()).toEqual([key]);
  });

  it('clears the reference but deletes nothing that is not the gym\'s own', async () => {
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', ['https://example.org/x.png', memberId]);
    const res = await remove(`/members/${memberId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(deletedKeys()).toHaveLength(0);
  });

  it('is a 200 with no image to remove, and needs no bucket', async () => {
    expect((await remove(`/members/${memberId}/image`, gymId)).status).toBe(200);
    expect((await remove(`/members/${noBucketMemberId}/image`, noBucketGymId)).status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
  });

  it("returns 404 for another gym's member and 403 for a read-only role", async () => {
    expect((await remove(`/members/${otherGymMemberId}/image`, gymId)).status).toBe(404);
    expect((await remove(`/members/${readOnlyMemberId}/image`, readOnlyGymId)).status).toBe(403);
  });
});

// ─── Rename (#1374 §5) ───────────────────────────────────────────────────────

describe('PUT /members/:id — a rename moves the image', () => {
  const oldKey = () => `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
  const newKey = () => `${gymPrefix}/members/${memberId}-Test-Image-Renamed.png`;

  it('copies to the new key, re-points the row, then deletes the old object — in that order', async () => {
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(oldKey()), memberId]);
    const res = await rename(memberId, gymId, 'Test Image Renamed');
    expect(res.status).toBe(200);
    expect(copies()).toEqual([{ from: `${R2_BUCKET}/${oldKey().split('/').map(encodeURIComponent).join('/')}`, to: newKey() }]);
    expect(deletedKeys()).toEqual([oldKey()]);
    const order = sendMock.mock.calls.map(([c]: any) => c.__type);
    expect(order.indexOf('copy')).toBeLessThan(order.indexOf('delete'));
    expect(await imageUrlOf(memberId)).toBe(url(newKey()));
    expect(res.body.image_url).toBe(url(newKey()));
  });

  it('keeps the old URL, and the old object, when the copy fails', async () => {
    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(oldKey()), memberId]);
    sendMock.mockRejectedValue(new Error('copy refused'));
    const res = await rename(memberId, gymId, 'Test Image Renamed');
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBe(url(oldKey()));
    expect(res.body.name).toBe('Test Image Renamed');
  });

  it('moves nothing when the name did not change, there is no image, or the image is not ours', async () => {
    await rename(memberId, gymId, MEMBER_NAME);
    expect(copies()).toHaveLength(0);

    await db.query('UPDATE members SET image_url = ? WHERE id = ?', [url(oldKey()), memberId]);
    await rename(memberId, gymId, MEMBER_NAME);
    expect(copies()).toHaveLength(0);

    await db.query('UPDATE members SET image_url = ? WHERE id = ?', ['https://example.org/x.png', memberId]);
    await rename(memberId, gymId, 'Test Image Renamed');
    expect(copies()).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBe('https://example.org/x.png');
  });
});
