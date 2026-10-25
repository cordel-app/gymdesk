// #2010 stage 2 — importing a Base Professional Service copies its two image
// objects into the gym's own folder under the new service id. Separate file
// because it mocks @aws-sdk/client-s3 and moves CLOUDFLARE_R2_* around.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkClient } from '@clerk/backend';
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

function setStorageConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
const PREFIX = `ps-imgimport-${Date.now()}`;
let gymId: string;
let gymPrefix: string;
let baseWithImage: number;
let baseNoImage: number;
let baseName: string;

const as = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const sent = (type: string) => sendMock.mock.calls.map(([c]) => c).filter((c: any) => c?.__type === type) as any[];

async function insertBase(name: string, withImage: boolean): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, image_url, image_thumbnail_url, created_by) VALUES (NULL, ?, 0, ?, ?, ?)',
    [name, withImage ? url(`cordel/professional_services/base-${PREFIX}.webp`) : null,
      withImage ? url(`cordel/professional_services/base-${PREFIX}-thumbnail.webp`) : null, 'test'],
  );
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('PS Import Img');
  await createTestMembership(gymId, 'admin');
  gymPrefix = `gyms/${gymId}-PSImportImg`;
  await db.query('UPDATE gyms SET storage_folder_prefix = ? WHERE id = ?', [gymPrefix, gymId]);
  baseName = `${PREFIX}-with`;
  baseWithImage = await insertBase(baseName, true);
  baseNoImage = await insertBase(`${PREFIX}-without`, false);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await db.end();
});

beforeEach(async () => {
  setStorageConfigured();
  const client = vi.mocked(createClerkClient).mock.results[0]?.value;
  if (client) vi.mocked(client.users.getUser).mockResolvedValue({ publicMetadata: {}, fullName: 'Test User' } as any);
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  await db.query('DELETE FROM professional_services WHERE gym_id = ?', [gymId]);
});

afterEach(() => { for (const key of R2_ENV_KEYS) delete process.env[key]; });

async function importIds(ids: number[]) {
  return request.post('/professional-services/import').set(as()).send({ base_professional_service_ids: ids });
}
async function copyOf(baseId: number) {
  const { rows } = await db.query(
    'SELECT id, image_url, image_thumbnail_url FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gymId, baseId]);
  return rows[0];
}

describe('POST /professional-services/import — image copy (#2010 stage 2)', () => {
  it('copies both objects into the gym folder under the new id and keeps the Base row untouched', async () => {
    const res = await importIds([baseWithImage]);
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual([baseWithImage]);
    const copy = await copyOf(baseWithImage);
    expect(copy.image_url).toBe(url(`${gymPrefix}/professional_services/${copy.id}-${baseName}.webp`));
    expect(copy.image_thumbnail_url).toBe(url(`${gymPrefix}/professional_services/${copy.id}-${baseName}-thumbnail.webp`));
    expect(sent('copy').map((c) => c.input.Key).sort()).toEqual([
      `${gymPrefix}/professional_services/${copy.id}-${baseName}-thumbnail.webp`,
      `${gymPrefix}/professional_services/${copy.id}-${baseName}.webp`,
    ].sort());
    expect(sent('delete')).toHaveLength(0);
    const { rows } = await db.query('SELECT image_url FROM professional_services WHERE id = ?', [baseWithImage]);
    expect(rows[0].image_url).toBe(url(`cordel/professional_services/base-${PREFIX}.webp`));
  });

  it('imports a service with no image and copies nothing', async () => {
    const res = await importIds([baseNoImage]);
    expect(res.body.imported).toEqual([baseNoImage]);
    const copy = await copyOf(baseNoImage);
    expect(copy.image_url).toBeNull();
    expect(sent('copy')).toHaveLength(0);
  });

  it('a failed copy leaves the service imported with no image and deletes what it wrote', async () => {
    sendMock.mockImplementation(async (command: any) => {
      if (command.__type === 'copy' && String(command.input.Key).endsWith('-thumbnail.webp')) throw new Error('boom');
      return {};
    });
    const res = await importIds([baseWithImage]);
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual([baseWithImage]);
    const copy = await copyOf(baseWithImage);
    expect(copy.image_url).toBeNull();
    expect(copy.image_thumbnail_url).toBeNull();
    expect(sent('delete').map((c) => c.input.Key)).toEqual([`${gymPrefix}/professional_services/${copy.id}-${baseName}.webp`]);
  });

  it('re-running the import is idempotent and copies nothing the second time', async () => {
    await importIds([baseWithImage]);
    sendMock.mockClear();
    const res = await importIds([baseWithImage]);
    expect(res.body.skipped).toEqual([baseWithImage]);
    expect(sent('copy')).toHaveLength(0);
  });
});
