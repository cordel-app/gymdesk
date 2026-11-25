// #3350 stage 3 — a Base Payment Method's image key carries the method's
// persisted slug, never its (English) name, and renaming the method moves
// nothing. Mocks @aws-sdk/client-s3 (professional-service-images.test.ts' shape).

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

const R2_ENV_KEYS = ['CLOUDFLARE_R2_ENDPOINT', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET'] as const;
const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

const RUN = Date.now();
const CODE = `pmkey_${RUN}`;
const SLUG = `pm-key-${RUN}`;
let gymId: string;
let methodId: number;

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
const sent = (type: 'put' | 'delete' | 'copy') => sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === type);
const putKeys = () => sent('put').map((c: any) => c.input.Key as string).filter((k) => !k.endsWith('/'));
const H = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

async function urlsOf(id: number) {
  const { rows } = await db.query<{ image_url: string | null; image_thumbnail_url: string | null }>(
    'SELECT image_url, image_thumbnail_url FROM base_payment_methods WHERE id = ?', [id]);
  return rows[0];
}
async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 90, b: 200 } } }).jpeg().toBuffer();
}
function upload(id: number, body: Buffer) {
  return request.post(`/platform/base-payment-methods/${id}/image`).set(H()).set('Content-Type', 'image/jpeg').send(body);
}

beforeAll(async () => {
  gymId = await createTestGym('PMImageKeysGym');
  await createTestMembership(gymId, 'admin');
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) {
    vi.mocked(client.users.getUser).mockResolvedValue({
      publicMetadata: { platform_role: 'superadmin' }, fullName: 'Test Admin', firstName: 'Test', lastName: 'Admin',
    } as any);
  }
  const { insertId } = await db.query(
    "INSERT INTO base_payment_methods (code, slug, status, created_at, created_by) VALUES (?, ?, 'active', UTC_TIMESTAMP(), 'test')",
    [CODE, SLUG],
  );
  methodId = Number(insertId);
  await db.query(
    "INSERT INTO base_payment_method_translations (base_payment_method_id, locale, name) VALUES (?, 'en', ?)",
    [methodId, 'Totally Different Name'],
  );
});

afterAll(async () => {
  await db.query('DELETE FROM base_payment_method_translations WHERE base_payment_method_id = ?', [methodId]);
  await db.query('DELETE FROM base_payment_methods WHERE id = ?', [methodId]);
  await cleanupTestGyms();
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(() => {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key];
});

describe('Base Payment Method image keys (#3350)', () => {
  it('stores the master and the thumbnail under the slug, not the English name', async () => {
    const res = await upload(methodId, await photo());
    expect(res.status).toBe(200);
    const key = `cordel/payment_method/${methodId}-${SLUG}.webp`;
    const thumb = `cordel/payment_method/${methodId}-${SLUG}-thumbnail.webp`;
    expect(putKeys().sort()).toEqual([key, thumb].sort());
    expect(await urlsOf(methodId)).toEqual({ image_url: url(key), image_thumbnail_url: url(thumb) });
  });

  it('a rename moves nothing and a replacement overwrites the same keys', async () => {
    expect((await upload(methodId, await photo())).status).toBe(200);
    const before = await urlsOf(methodId);
    sendMock.mockClear();
    const res = await request.put(`/platform/base-payment-methods/${methodId}`).set(H())
      .send({ translations: { en: { name: 'Renamed Method' } } });
    expect(res.status).toBe(200);
    expect(sent('copy')).toHaveLength(0);
    expect(sent('delete')).toHaveLength(0);
    expect(await urlsOf(methodId)).toEqual(before);
    expect((await upload(methodId, await photo())).status).toBe(200);
    expect(await urlsOf(methodId)).toEqual(before);
  });
});
