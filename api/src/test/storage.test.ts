// Unit tests for infra/storage.ts (#417 stage 1) — pure logic + mocked S3 client, no DB.

import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;

function setConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  sendMock.mockClear();
  vi.resetModules();
});

describe('sanitizeGymFolderName()', () => {
  it('strips spaces', async () => {
    const { sanitizeGymFolderName } = await import('../infra/storage');
    expect(sanitizeGymFolderName('Central Gym')).toBe('CentralGym');
  });

  it('strips path separators and special characters', async () => {
    const { sanitizeGymFolderName } = await import('../infra/storage');
    expect(sanitizeGymFolderName('Gym/Name\\With:Special*Chars?')).toBe('GymNameWithSpecialChars');
  });

  it('keeps hyphens and underscores', async () => {
    const { sanitizeGymFolderName } = await import('../infra/storage');
    expect(sanitizeGymFolderName('Gym-Name_2')).toBe('Gym-Name_2');
  });
});

describe('buildGymFolderPrefix()', () => {
  it('joins gym id and sanitized name with a hyphen, no spaces', async () => {
    const { buildGymFolderPrefix } = await import('../infra/storage');
    expect(buildGymFolderPrefix('gym_123', 'Gym Name')).toBe('gym_123-GymName');
  });
});

describe('isStorageConfigured()', () => {
  it('is false when no env vars are set', async () => {
    const { isStorageConfigured } = await import('../infra/storage');
    expect(isStorageConfigured()).toBe(false);
  });

  it('is false when only some env vars are set', async () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    const { isStorageConfigured } = await import('../infra/storage');
    expect(isStorageConfigured()).toBe(false);
  });

  it('is true when all env vars are set', async () => {
    setConfigured();
    const { isStorageConfigured } = await import('../infra/storage');
    expect(isStorageConfigured()).toBe(true);
  });
});

describe('initializeGymBucket()', () => {
  it('throws without touching the network when not configured', async () => {
    const { initializeGymBucket } = await import('../infra/storage');
    await expect(initializeGymBucket('gym_123-Gym')).rejects.toThrow(
      'Cloudflare R2 storage is not configured for this deployment',
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('creates one folder-marker object per standard folder', async () => {
    setConfigured();
    const { initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket('gym_123-GymName');

    expect(sendMock).toHaveBeenCalledTimes(6);
    const keys = sendMock.mock.calls.map((call) => call[0].input.Key);
    expect(keys).toEqual([
      'gym_123-GymName/Nutrition/Images/',
      'gym_123-GymName/Exercises/Images/',
      'gym_123-GymName/Exercises/Videos/',
      'gym_123-GymName/Branding/Logo/',
      'gym_123-GymName/Branding/Images/',
      'gym_123-GymName/Members/',
    ]);
    for (const call of sendMock.mock.calls) {
      expect(call[0].input.Bucket).toBe('test-bucket');
    }
  });
});

describe('uploadGymImage()', () => {
  it('throws without touching the network when not configured', async () => {
    const { uploadGymImage } = await import('../infra/storage');
    await expect(uploadGymImage('gym_123-Gym', 'Exercises/Images', 'image/png', Buffer.from('x'))).rejects.toThrow(
      'Cloudflare R2 storage is not configured for this deployment',
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('uploads into <prefix>/<folder>/ with a generated filename and returns the endpoint+bucket+key URL', async () => {
    setConfigured();
    const { uploadGymImage } = await import('../infra/storage');
    const body = Buffer.from('fake-image-bytes');
    const url = await uploadGymImage('gym_123-GymName', 'Exercises/Images', 'image/png', body);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0][0].input;
    expect(input.Bucket).toBe('test-bucket');
    expect(input.Body).toBe(body);
    expect(input.ContentType).toBe('image/png');
    expect(input.Key).toMatch(/^gym_123-GymName\/Exercises\/Images\/[0-9a-f-]{36}\.png$/);
    expect(url).toBe(`https://example.r2.cloudflarestorage.com/test-bucket/${input.Key}`);
  });

  it('maps mime types to the expected file extension', async () => {
    setConfigured();
    const { uploadGymImage } = await import('../infra/storage');
    const cases: Array<[string, string]> = [
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['image/gif', 'gif'],
    ];
    for (const [mime, ext] of cases) {
      const url = await uploadGymImage('gym_123-GymName', 'Exercises/Images', mime, Buffer.from('x'));
      expect(url.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it('generates a distinct key for every upload (no filename collisions)', async () => {
    setConfigured();
    const { uploadGymImage } = await import('../infra/storage');
    const urlA = await uploadGymImage('gym_123-GymName', 'Exercises/Images', 'image/png', Buffer.from('a'));
    const urlB = await uploadGymImage('gym_123-GymName', 'Exercises/Images', 'image/png', Buffer.from('b'));
    expect(urlA).not.toBe(urlB);
  });
});
