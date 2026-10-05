// Unit tests for the public R2 origin (CLOUDFLARE_R2_PUBLIC_URL): how stored
// media URLs are built and parsed, how the exercise media sweeps compare them,
// and the one-off rewrite of URLs stored before the variable existed. No DB:
// the rewrite script's queries are asserted against a mocked db.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  CopyObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

vi.mock('../infra/db', () => ({ db: { query: queryMock, end: vi.fn() } }));

const ENDPOINT = 'https://account.r2.cloudflarestorage.com';
const BUCKET = 'test-bucket';
const PUBLIC = 'https://pub-abc123.r2.dev';
const KEY = 'cordel/Nutrition/2-Beef.png';
const LEGACY_URL = `${ENDPOINT}/${BUCKET}/${KEY}`;
const PUBLIC_URL = `${PUBLIC}/${KEY}`;

const ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
  'CLOUDFLARE_R2_PUBLIC_URL',
] as const;

function configure(publicUrl?: string) {
  process.env.CLOUDFLARE_R2_ENDPOINT = ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = BUCKET;
  if (publicUrl !== undefined) process.env.CLOUDFLARE_R2_PUBLIC_URL = publicUrl;
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  queryMock.mockReset();
  vi.resetModules();
});

describe('buildStorageObjectUrl()', () => {
  it('builds on the public origin, without the bucket name, when it is set', async () => {
    configure(PUBLIC);
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl(KEY)).toBe(PUBLIC_URL);
  });

  it('ignores a trailing slash and surrounding whitespace on the public origin', async () => {
    configure(`  ${PUBLIC}/  `);
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl(KEY)).toBe(PUBLIC_URL);
  });

  it('keeps the old endpoint + bucket composition when the public origin is unset', async () => {
    configure();
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl(KEY)).toBe(LEGACY_URL);
  });

  it('treats an empty public origin as unset', async () => {
    configure('   ');
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl(KEY)).toBe(LEGACY_URL);
  });
});

describe('uploadStorageObject()', () => {
  it('returns the public URL of what it stored', async () => {
    configure(PUBLIC);
    const { uploadStorageObject } = await import('../infra/storage');
    await expect(uploadStorageObject(KEY, 'image/png', Buffer.from('x'))).resolves.toBe(PUBLIC_URL);
  });
});

describe('storageKeyFromObjectUrl()', () => {
  it('reads the key from both the public and the legacy form', async () => {
    configure(PUBLIC);
    const { storageKeyFromObjectUrl } = await import('../infra/storage');
    expect(storageKeyFromObjectUrl(PUBLIC_URL)).toBe(KEY);
    expect(storageKeyFromObjectUrl(LEGACY_URL)).toBe(KEY);
  });

  it('never claims a URL this deployment did not build', async () => {
    configure(PUBLIC);
    const { storageKeyFromObjectUrl } = await import('../infra/storage');
    expect(storageKeyFromObjectUrl('https://pub-other.r2.dev/cordel/Nutrition/2-Beef.png')).toBeNull();
    expect(storageKeyFromObjectUrl(`${ENDPOINT}/other-bucket/${KEY}`)).toBeNull();
    expect(storageKeyFromObjectUrl('https://youtube.com/watch?v=abc')).toBeNull();
    expect(storageKeyFromObjectUrl(`${PUBLIC}/`)).toBeNull();
    expect(storageKeyFromObjectUrl(null)).toBeNull();
  });
});

describe('storageObjectUrlForms()', () => {
  it('lists the public form first, then the legacy one', async () => {
    configure(PUBLIC);
    const { storageObjectUrlForms } = await import('../infra/storage');
    expect(storageObjectUrlForms(KEY)).toEqual([PUBLIC_URL, LEGACY_URL]);
  });

  it('lists the legacy form once when there is no public origin', async () => {
    configure();
    const { storageObjectUrlForms } = await import('../infra/storage');
    expect(storageObjectUrlForms(KEY)).toEqual([LEGACY_URL]);
  });
});

describe('exercise media references', () => {
  it('gives both URL forms of one object the same identity', async () => {
    configure(PUBLIC);
    const { mediaIdentity } = await import('../domain/exerciseMediaReferences');
    expect(mediaIdentity(PUBLIC_URL)).toBe(mediaIdentity(LEGACY_URL));
    expect(mediaIdentity('https://youtube.com/watch?v=abc')).toBe('https://youtube.com/watch?v=abc');
  });

  it('matches every URL form of the object in all four media columns', async () => {
    configure(PUBLIC);
    const { mediaReferenceClause } = await import('../domain/exerciseMediaReferences');
    const { clause, params } = mediaReferenceClause(LEGACY_URL);
    expect(clause).toBe(
      '(image_url IN (?, ?) OR image_thumbnail_url IN (?, ?) OR video_url IN (?, ?) OR video_thumbnail_url IN (?, ?))',
    );
    expect(params).toEqual([PUBLIC_URL, LEGACY_URL, PUBLIC_URL, LEGACY_URL, PUBLIC_URL, LEGACY_URL, PUBLIC_URL, LEGACY_URL]);
  });

  it('matches an external URL only as itself', async () => {
    configure(PUBLIC);
    const { mediaReferenceClause } = await import('../domain/exerciseMediaReferences');
    const { params } = mediaReferenceClause('https://youtube.com/watch?v=abc');
    expect(params).toEqual(Array(4).fill('https://youtube.com/watch?v=abc'));
  });
});

describe('rewrite-storage-urls script', () => {
  it('rewrites the legacy prefix to the public one', async () => {
    const { resolvePrefixes } = await import('../scripts/rewrite-storage-urls');
    expect(resolvePrefixes({
      CLOUDFLARE_R2_ENDPOINT: ENDPOINT,
      CLOUDFLARE_R2_BUCKET: BUCKET,
      CLOUDFLARE_R2_PUBLIC_URL: `${PUBLIC}/`,
    })).toEqual({ legacy: `${ENDPOINT}/${BUCKET}/`, current: `${PUBLIC}/` });
  });

  it('refuses to run without a public origin, or when it equals the legacy one', async () => {
    const { resolvePrefixes } = await import('../scripts/rewrite-storage-urls');
    expect(() => resolvePrefixes({ CLOUDFLARE_R2_ENDPOINT: ENDPOINT, CLOUDFLARE_R2_BUCKET: BUCKET }))
      .toThrow(/CLOUDFLARE_R2_PUBLIC_URL must be set/);
    expect(() => resolvePrefixes({ CLOUDFLARE_R2_PUBLIC_URL: PUBLIC }))
      .toThrow(/CLOUDFLARE_R2_ENDPOINT and CLOUDFLARE_R2_BUCKET/);
    expect(() => resolvePrefixes({
      CLOUDFLARE_R2_ENDPOINT: ENDPOINT,
      CLOUDFLARE_R2_BUCKET: BUCKET,
      CLOUDFLARE_R2_PUBLIC_URL: `${ENDPOINT}/${BUCKET}`,
    })).toThrow(/nothing to rewrite/);
  });

  it('counts and rewrites every stored-URL column, keeping the key', async () => {
    const { rewriteStorageUrls, STORED_URL_COLUMNS } = await import('../scripts/rewrite-storage-urls');
    queryMock.mockImplementation(async (sql: string) => (
      sql.startsWith('SELECT') ? { rows: [{ n: 2 }], rowCount: 1, insertId: 0 } : { rows: [], rowCount: 2, insertId: 0 }
    ));
    const prefixes = { legacy: `${ENDPOINT}/${BUCKET}/`, current: `${PUBLIC}/` };
    const results = await rewriteStorageUrls({ dryRun: false }, prefixes, () => {});

    expect(results).toHaveLength(STORED_URL_COLUMNS.length);
    expect(results.every((r) => r.matched === 2 && r.rewritten === 2)).toBe(true);
    const update = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE nutrition_library_items'));
    expect(update?.[0]).toMatch(/SET image_url = CONCAT\(\?, SUBSTRING\(image_url, \?\)\)/);
    expect(update?.[0]).toMatch(/WHERE LEFT\(image_url, \?\) = \?/);
    expect(update?.[1]).toEqual([prefixes.current, prefixes.legacy.length + 1, prefixes.legacy.length, prefixes.legacy]);
  });

  it('writes nothing on a dry run', async () => {
    const { rewriteStorageUrls } = await import('../scripts/rewrite-storage-urls');
    queryMock.mockResolvedValue({ rows: [{ n: 5 }], rowCount: 1, insertId: 0 });
    const results = await rewriteStorageUrls(
      { dryRun: true },
      { legacy: `${ENDPOINT}/${BUCKET}/`, current: `${PUBLIC}/` },
      () => {},
    );
    expect(results.every((r) => r.matched === 5 && r.rewritten === 0)).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
  });
});
