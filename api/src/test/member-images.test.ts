// #1374/#1449 — a **Member's profile image**: `POST`/`DELETE /members/:id/image`,
// the two WebP objects the server makes from one uploaded original, what the gym
// may and may not delete, and the rename migration in `PUT /members/:id`.
//
// Separate from members.test.ts because this file mocks @aws-sdk/client-s3 and
// moves the CLOUDFLARE_R2_* env around (personal-goal-images.test.ts' shape).

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
async function thumbUrlOf(id: number): Promise<string | null> {
  const { rows } = await db.query<{ image_thumbnail_url: string | null }>(
    'SELECT image_thumbnail_url FROM members WHERE id = ?', [id]);
  return rows[0]?.image_thumbnail_url ?? null;
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
  await db.query('UPDATE members SET image_url = NULL, image_thumbnail_url = NULL, name = ?, deleted_at = NULL WHERE id = ?', [MEMBER_NAME, memberId]);
  await db.query('UPDATE members SET image_url = NULL, image_thumbnail_url = NULL WHERE id IN (?, ?, ?)', [otherGymMemberId, noBucketMemberId, readOnlyMemberId]);
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

// ─── Auth and ownership ──────────────────────────────────────────────────────

describe('POST /members/:id/image — auth and ownership', () => {
  it('returns 401 without auth, and uploads nothing', async () => {
    const res = await request.post(`/members/${memberId}/image`).set('Content-Type', 'image/jpeg').send(await photo());
    expect(res.status).toBe(401);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 403 for a role without write on MEMBERS', async () => {
    const res = await upload(`/members/${readOnlyMemberId}/image`, readOnlyGymId, await photo());
    expect(res.status).toBe(403);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(readOnlyMemberId)).toBeNull();
  });

  it("returns 404 for another gym's member, and writes nothing", async () => {
    const res = await upload(`/members/${otherGymMemberId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
    expect(await imageUrlOf(otherGymMemberId)).toBeNull();
  });

  it('returns 404 for a soft-deleted member', async () => {
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(404);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 409 for a gym whose bucket was never initialized', async () => {
    const res = await upload(`/members/${noBucketMemberId}/image`, noBucketGymId, await photo());
    expect(res.status).toBe(409);
    expect(putKeys()).toHaveLength(0);
  });

  it('returns 503 when the deployment has no Cloudflare configuration', async () => {
    for (const key of R2_ENV_KEYS) delete process.env[key];
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(503);
    expect(res.body.missingConfig?.length).toBeGreaterThan(0);
  });
});

// ─── Validation (the file, never the request) ────────────────────────────────

describe('POST /members/:id/image — validation', () => {
  it('refuses a content type that is not an image', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, await photo(), 'application/pdf');
    expect(res.status).toBe(415);
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses bytes that are not a picture, whatever the header claimed', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unreadable');
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses a format the server does not decode (a TIFF), judged from the bytes', async () => {
    const tiff = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } }).tiff().toBuffer();
    const res = await upload(`/members/${memberId}/image`, gymId, tiff, 'image/jpeg');
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unsupported_format');
    expect(putKeys()).toHaveLength(0);
  });

  it('refuses an empty body and an oversized one', async () => {
    expect((await upload(`/members/${memberId}/image`, gymId, Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.concat([await photo(), Buffer.alloc(memberImageMaxBytes())]);
    expect((await upload(`/members/${memberId}/image`, gymId, big)).status).toBe(413);
    expect(putKeys()).toHaveLength(0);
  });

  it('leaves an existing image untouched when the upload is refused', async () => {
    const existing = url(`${gymPrefix}/members/${memberId}-${SANITIZED}.webp`);
    const existingThumb = url(`${gymPrefix}/members/${memberId}-${SANITIZED}-thumbnail.webp`);
    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [existing, existingThumb, memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, NOT_AN_IMAGE);
    expect(res.status).toBe(400);
    expect(await imageUrlOf(memberId)).toBe(existing);
    expect(await thumbUrlOf(memberId)).toBe(existingThumb);
    expect(deletedKeys()).toHaveLength(0);
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('POST /members/:id/image', () => {
  const key = () => `${gymPrefix}/members/${memberId}-${SANITIZED}.webp`;
  const thumbKey = () => `${gymPrefix}/members/${memberId}-${SANITIZED}-thumbnail.webp`;

  it('makes a 1080×1080 and a 256×256 WebP from one original, and persists both URLs', async () => {
    const res = await upload(`/members/${memberId}/image`, gymId, await photo('jpeg', 1600, 900));
    expect(res.status).toBe(200);

    expect(putKeys()).toEqual([key(), thumbKey()]);
    for (const k of [key(), thumbKey()]) {
      expect(sentCommands('put').find((c: any) => c.input.Key === k).input).toMatchObject({
        Bucket: R2_BUCKET, ContentType: 'image/webp',
      });
      expect(k.startsWith(`${gymPrefix}/`)).toBe(true);
      expect(k).not.toContain('cordel/');
    }
    const master = await sharp(putBody(key())).metadata();
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    const thumb = await sharp(putBody(thumbKey())).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);

    expect(await imageUrlOf(memberId)).toBe(url(key()));
    expect(await thumbUrlOf(memberId)).toBe(url(thumbKey()));
    // The response is the row as GET /:id shapes it.
    expect(res.body.image_url).toBe(url(key()));
    expect(res.body.image_thumbnail_url).toBe(url(thumbKey()));
    expect(res.body).toHaveProperty('is_new_member');
    expect(res.body).toHaveProperty('access_rights');
  });

  it.each(['png', 'webp', 'gif'] as const)('accepts a %s original', async (format) => {
    const res = await upload(`/members/${memberId}/image`, gymId, await photo(format, 300, 500), `image/${format}`);
    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(2);
  });

  it('applies the EXIF orientation before cropping, and keeps no metadata', async () => {
    // 400×200 stored sideways with orientation 6 → upright it is 200×400.
    const exif = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#223344' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const res = await upload(`/members/${memberId}/image`, gymId, exif);
    expect(res.status).toBe(200);
    const stored = await sharp(putBody(key())).metadata();
    expect([stored.width, stored.height]).toEqual([1080, 1080]);
    expect(stored.exif).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
  });

  it('writes the folder markers between the bucket root and members/', async () => {
    await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(markerKeys()).toEqual([`${gymPrefix}/`, `${gymPrefix}/members/`]);
  });

  it('answers 502 and writes neither column when an upload fails', async () => {
    sendMock.mockRejectedValue(new Error('R2 is down'));
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(502);
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(await thumbUrlOf(memberId)).toBeNull();
  });

  it('writes neither column when only the thumbnail upload fails', async () => {
    let puts = 0;
    sendMock.mockImplementation(async (command: any) => {
      if (command.__type === 'put' && !String(command.input.Key).endsWith('/')) {
        puts += 1;
        if (puts === 2) throw new Error('thumbnail refused');
      }
      return {};
    });
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(502);
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(await thumbUrlOf(memberId)).toBeNull();
  });

  it('overwrites its own objects on a replace, with nothing to sweep', async () => {
    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key()), url(thumbKey()), memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(200);
    expect(putKeys()).toEqual([key(), thumbKey()]);
    expect(deletedKeys()).toHaveLength(0);
  });

  it('sweeps the old objects only when the keys moved (a pre-#1449 PNG), after the uploads', async () => {
    const stale = `${gymPrefix}/members/${memberId}-${SANITIZED}.png`;
    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = NULL WHERE id = ?', [url(stale), memberId]);
    const res = await upload(`/members/${memberId}/image`, gymId, await photo());
    expect(res.status).toBe(200);
    expect(deletedKeys()).toEqual([stale]);
    const order = sendMock.mock.calls.map(([c]: any) => c.__type);
    expect(order.indexOf('delete')).toBeGreaterThan(order.lastIndexOf('put'));
    expect(await imageUrlOf(memberId)).toBe(url(key()));
    expect(await thumbUrlOf(memberId)).toBe(url(thumbKey()));
  });

  it("never deletes another gym's object, another feature's, or an external URL", async () => {
    for (const foreign of [
      url(`${otherGymPrefix}/members/${memberId}-${SANITIZED}.webp`),
      url(`${gymPrefix}/goals/${memberId}-${SANITIZED}.png`),
      'https://example.org/somebody-elses.png',
    ]) {
      sendMock.mockReset();
      sendMock.mockResolvedValue({});
      await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [foreign, foreign, memberId]);
      const res = await upload(`/members/${memberId}/image`, gymId, await photo());
      expect(res.status).toBe(200);
      expect(deletedKeys(), foreign).toHaveLength(0);
    }
  });

  it('is reported by GET /members and GET /members/:id', async () => {
    await upload(`/members/${memberId}/image`, gymId, await photo());
    const one = await request.get(`/members/${memberId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(one.body.image_url).toBe(url(key()));
    expect(one.body.image_thumbnail_url).toBe(url(thumbKey()));
    const list = await request.get('/members').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const row = list.body.find((m: any) => m.id === memberId);
    expect(row?.image_url).toBe(url(key()));
    expect(row?.image_thumbnail_url).toBe(url(thumbKey()));
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /members/:id/image', () => {
  it("clears both references and deletes the gym's own objects", async () => {
    const key = `${gymPrefix}/members/${memberId}-${SANITIZED}.webp`;
    const thumbKey = `${gymPrefix}/members/${memberId}-${SANITIZED}-thumbnail.webp`;
    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ?', [url(key), url(thumbKey), memberId]);
    const res = await remove(`/members/${memberId}/image`, gymId);
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
    expect(res.body.image_thumbnail_url).toBeNull();
    expect(await imageUrlOf(memberId)).toBeNull();
    expect(await thumbUrlOf(memberId)).toBeNull();
    expect(deletedKeys().sort()).toEqual([key, thumbKey].sort());
  });

  it('clears the references but deletes nothing that is not the gym\'s own', async () => {
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

describe('PUT /members/:id — a rename moves both images', () => {
  const oldKey = () => `${gymPrefix}/members/${memberId}-${SANITIZED}.webp`;
  const oldThumb = () => `${gymPrefix}/members/${memberId}-${SANITIZED}-thumbnail.webp`;
  const newKey = () => `${gymPrefix}/members/${memberId}-Test-Image-Renamed.webp`;
  const newThumb = () => `${gymPrefix}/members/${memberId}-Test-Image-Renamed-thumbnail.webp`;
  const source = (key: string) => `${R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

  async function seed() {
    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = ? WHERE id = ?',
      [url(oldKey()), url(oldThumb()), memberId]);
  }

  it('copies both to the new keys, re-points the row, then deletes the old objects — in that order', async () => {
    await seed();
    const res = await rename(memberId, gymId, 'Test Image Renamed');
    expect(res.status).toBe(200);
    expect(copies()).toEqual([
      { from: source(oldKey()), to: newKey() },
      { from: source(oldThumb()), to: newThumb() },
    ]);
    expect(deletedKeys().sort()).toEqual([oldKey(), oldThumb()].sort());
    const order = sendMock.mock.calls.map(([c]: any) => c.__type);
    expect(order.lastIndexOf('copy')).toBeLessThan(order.indexOf('delete'));
    expect(await imageUrlOf(memberId)).toBe(url(newKey()));
    expect(await thumbUrlOf(memberId)).toBe(url(newThumb()));
    expect(res.body.image_url).toBe(url(newKey()));
    expect(res.body.image_thumbnail_url).toBe(url(newThumb()));
  });

  it('keeps the old pair, and the old objects, when the copy fails', async () => {
    await seed();
    sendMock.mockRejectedValue(new Error('copy refused'));
    const res = await rename(memberId, gymId, 'Test Image Renamed');
    expect(res.status).toBe(200);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBe(url(oldKey()));
    expect(await thumbUrlOf(memberId)).toBe(url(oldThumb()));
    expect(res.body.name).toBe('Test Image Renamed');
  });

  it('keeps BOTH old URLs and removes the new master when only the thumbnail copy fails', async () => {
    await seed();
    sendMock.mockImplementation(async (command: any) => {
      if (command.__type === 'copy' && command.input.Key === newThumb()) throw new Error('thumb copy refused');
      return {};
    });
    const res = await rename(memberId, gymId, 'Test Image Renamed');
    expect(res.status).toBe(200);
    expect(await imageUrlOf(memberId)).toBe(url(oldKey()));
    expect(await thumbUrlOf(memberId)).toBe(url(oldThumb()));
    expect(deletedKeys()).toEqual([newKey()]);
  });

  it('moves nothing when the name did not change, there is no image, or the image is not ours', async () => {
    await rename(memberId, gymId, MEMBER_NAME);
    expect(copies()).toHaveLength(0);

    await seed();
    await rename(memberId, gymId, MEMBER_NAME);
    expect(copies()).toHaveLength(0);

    await db.query('UPDATE members SET image_url = ?, image_thumbnail_url = NULL WHERE id = ?', ['https://example.org/x.png', memberId]);
    await rename(memberId, gymId, 'Test Image Renamed');
    expect(copies()).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imageUrlOf(memberId)).toBe('https://example.org/x.png');
  });
});
