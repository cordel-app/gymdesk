// #3350 stage 4 — a muscle's images are keyed by its persisted slug, never its
// name: an upload writes `cordel/muscles/images/<slug>-<sex>[-thumbnail].webp`,
// a rename moves no object, and an image stored under a pre-#3350 name key keeps
// rendering until it is replaced, which sweeps it. This file mocks
// @aws-sdk/client-s3 and sets the CLOUDFLARE_R2_* env, so it is separate from
// platform-muscle-translations.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'put', input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'get', input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'delete', input })),
  CopyObjectCommand: vi.fn().mockImplementation((input) => ({ __type: 'copy', input })),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({ publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin' }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

const R2_ENV_KEYS = ['CLOUDFLARE_R2_ENDPOINT', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const H = { Authorization: TEST_AUTH_HEADER };
const NAME = 'Test Muscle T3350 Keys';
const PREFIX = 'cordel/muscles/images';

const sent = (type: string) => sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === type);
const putKeys = () => sent('put').map((c: any) => c.input.Key).filter((k: string) => !k.endsWith('/'));
const deletedKeys = () => sent('delete').map((c: any) => c.input.Key);
const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

let muscleId: number;
let slug: string;
let picture: Buffer;

beforeAll(async () => {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
  picture = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
  const created = await request.post('/platform/muscles').set(H).send({ name: NAME });
  expect(created.status).toBe(201);
  muscleId = created.body.id;
  slug = created.body.slug;
});

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

afterAll(async () => {
  await db.query("DELETE FROM muscles WHERE name LIKE 'Test Muscle T3350%'");
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await cleanupTestGyms();
  await db.end();
});

async function imagesOf(id: number) {
  const { rows } = await db.query(
    'SELECT image_male_url, image_male_url_thumbnail, image_female_url, image_female_url_thumbnail FROM muscles WHERE id = ?',
    [id],
  );
  return rows[0];
}

describe('muscle image keys use the slug (#3350 stage 4)', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await request.post(`/platform/muscles/${muscleId}/image/male`).set('Content-Type', 'image/png').send(picture);
    expect(res.status).toBe(401);
  });

  it('uploads under the slug key, never the name', async () => {
    const res = await request.post(`/platform/muscles/${muscleId}/image/male`).set(H).set('Content-Type', 'image/png').send(picture);
    expect(res.status).toBe(200);
    const master = `${PREFIX}/${slug}-male.webp`;
    expect(putKeys()).toEqual([master, `${PREFIX}/${slug}-male-thumbnail.webp`]);
    expect(await imagesOf(muscleId)).toMatchObject({ image_male_url: url(master) });
  });

  it('renames without moving or copying any image object', async () => {
    const before = await imagesOf(muscleId);
    const res = await request.put(`/platform/muscles/${muscleId}`).set(H).send({ name: `${NAME} Renamed` });
    expect(res.status).toBe(200);
    expect(sent('copy')).toHaveLength(0);
    expect(deletedKeys()).toHaveLength(0);
    expect(await imagesOf(muscleId)).toEqual(before);
  });

  it('keeps a pre-#3350 name-keyed image on rename, and sweeps it when it is replaced', async () => {
    const legacy = `${PREFIX}/Test-Muscle-T3350-Keys-female.webp`;
    const legacyThumb = `${PREFIX}/Test-Muscle-T3350-Keys-female-thumbnail.webp`;
    await db.query('UPDATE muscles SET image_female_url = ?, image_female_url_thumbnail = ? WHERE id = ?', [url(legacy), url(legacyThumb), muscleId]);

    const renamed = await request.put(`/platform/muscles/${muscleId}`).set(H).send({ name: `${NAME} Again` });
    expect(renamed.status).toBe(200);
    expect(sent('copy')).toHaveLength(0);
    expect(await imagesOf(muscleId)).toMatchObject({ image_female_url: url(legacy), image_female_url_thumbnail: url(legacyThumb) });

    sendMock.mockClear();
    const res = await request.post(`/platform/muscles/${muscleId}/image/female`).set(H).set('Content-Type', 'image/png').send(picture);
    expect(res.status).toBe(200);
    expect(await imagesOf(muscleId)).toMatchObject({ image_female_url: url(`${PREFIX}/${slug}-female.webp`) });
    expect(deletedKeys().sort()).toEqual([legacy, legacyThumb].sort());
  });
});
