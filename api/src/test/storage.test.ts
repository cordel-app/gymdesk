// Unit tests for infra/storage.ts (#417 stage 1) — pure logic + mocked S3 client, no DB.

import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;

// Optional, so not in ENV_KEYS (the required set). Cleared so a developer's own
// public origin can't change the endpoint + bucket composition expected here.
delete process.env.CLOUDFLARE_R2_PUBLIC_URL;

function setConfigured() {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.CLOUDFLARE_R2_PUBLIC_URL;
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
    expect(buildGymFolderPrefix('gym_123', 'Gym Name')).toBe('gyms/gym_123-GymName');
  });

  // #668: the gym root moved from `<bucket>/<gym_id>-<gym_name>/` to
  // `<bucket>/gyms/<gym_id>-<gym_name>/`.
  it('puts the gym root under the gyms/ prefix', async () => {
    const { buildGymFolderPrefix } = await import('../infra/storage');
    expect(buildGymFolderPrefix('d3af0239-c3e0-466a-b9bf-8ea1048fbe09', 'MyGym')).toBe(
      'gyms/d3af0239-c3e0-466a-b9bf-8ea1048fbe09-MyGym',
    );
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

describe('getMissingStorageConfigKeys()', () => {
  it('lists all four env vars when none are set', async () => {
    const { getMissingStorageConfigKeys } = await import('../infra/storage');
    expect(getMissingStorageConfigKeys()).toEqual([...ENV_KEYS]);
  });

  it('lists only the env vars that are unset', async () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    const { getMissingStorageConfigKeys } = await import('../infra/storage');
    expect(getMissingStorageConfigKeys()).toEqual([
      'CLOUDFLARE_R2_ACCESS_KEY_ID',
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    ]);
  });

  it('is empty when all env vars are set', async () => {
    setConfigured();
    const { getMissingStorageConfigKeys } = await import('../infra/storage');
    expect(getMissingStorageConfigKeys()).toEqual([]);
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

  it('creates folder-marker objects for the gym root, parent folders, and leaf folders', async () => {
    setConfigured();
    const { initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket('gym_123-GymName');

    expect(sendMock).toHaveBeenCalledTimes(11);
    const keys = sendMock.mock.calls.map((call) => call[0].input.Key);
    expect(keys).toEqual([
      'gym_123-GymName/',
      'gym_123-GymName/Nutrition/',
      'gym_123-GymName/Nutrition/Images/',
      'gym_123-GymName/Exercises/',
      'gym_123-GymName/Exercises/Images/',
      'gym_123-GymName/Exercises/Videos/',
      'gym_123-GymName/Branding/',
      'gym_123-GymName/Branding/Logo/',
      'gym_123-GymName/Branding/Images/',
      'gym_123-GymName/Members/',
      'gym_123-GymName/Themes/',
    ]);
    for (const call of sendMock.mock.calls) {
      expect(call[0].input.Bucket).toBe('test-bucket');
    }
  });

  // ─── #735: the gym-level Themes/ folder ────────────────────────────────────

  it('creates the gym-level Themes/ folder marker', async () => {
    setConfigured();
    const { buildGymFolderPrefix, initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket(buildGymFolderPrefix('gym_123', 'Gym Name'));

    const keys = sendMock.mock.calls.map((call) => call[0].input.Key);
    expect(keys).toContain('gyms/gym_123-GymName/Themes/');
  });

  // The folder is the same one `THEME_STORAGE_FOLDER` names, so a Custom Theme's
  // own folder is written under the marker initialization creates, not beside it.
  it('uses the same Themes folder a theme folder prefix is built from', async () => {
    setConfigured();
    const { buildGymFolderPrefix, initializeGymBucket } = await import('../infra/storage');
    const { buildThemeFolderPrefix } = await import('../domain/themeMemberImages');
    const prefix = buildGymFolderPrefix('gym_123', 'Gym Name');
    await initializeGymBucket(prefix);

    const themesMarker = sendMock.mock.calls
      .map((call) => call[0].input.Key)
      .find((key: string) => key.endsWith('/Themes/'));
    expect(buildThemeFolderPrefix(prefix, 'theme_9', 'Dark Modern').startsWith(themesMarker)).toBe(true);
  });

  // §"Important Scope": initialization creates the root and nothing below it —
  // a theme's own folder and its Members/ leaf belong to the upload workflow.
  it('creates no theme-specific folders below Themes/', async () => {
    setConfigured();
    const { initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket('gyms/gym_123-GymName');

    const belowThemes = sendMock.mock.calls
      .map((call) => call[0].input.Key)
      .filter((key: string) => key.includes('/Themes/') && key !== 'gyms/gym_123-GymName/Themes/');
    expect(belowThemes).toEqual([]);
  });

  // §"Existing Gym Support" / §"Idempotency": re-running writes the same marker
  // set again — every key ends in `/`, and the body is empty, so an existing
  // Themes/ folder (and anything inside it) is left exactly as it was.
  it('is idempotent: a second run writes the same keys, all empty markers', async () => {
    setConfigured();
    const { initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket('gyms/gym_123-GymName');
    const firstRun = sendMock.mock.calls.map((call) => call[0].input.Key);

    sendMock.mockClear();
    await initializeGymBucket('gyms/gym_123-GymName');
    const secondRun = sendMock.mock.calls.map((call) => call[0].input.Key);

    expect(secondRun).toEqual(firstRun);
    expect(new Set(secondRun).size).toBe(secondRun.length);
    for (const call of sendMock.mock.calls) {
      expect(call[0].input.Key.endsWith('/')).toBe(true);
      expect(call[0].input.Body).toBe('');
    }
  });

  // #668: with the prefix the initialize endpoint actually builds, every marker
  // key — root included — sits under `gyms/`, and the tree below it is unchanged.
  it('writes every marker under gyms/ when given a prefix from buildGymFolderPrefix()', async () => {
    setConfigured();
    const { buildGymFolderPrefix, initializeGymBucket } = await import('../infra/storage');
    await initializeGymBucket(buildGymFolderPrefix('gym_123', 'Gym Name'));

    const keys = sendMock.mock.calls.map((call) => call[0].input.Key);
    expect(keys[0]).toBe('gyms/gym_123-GymName/');
    expect(keys).toContain('gyms/gym_123-GymName/Branding/Logo/');
    for (const key of keys) expect(key.startsWith('gyms/gym_123-GymName/')).toBe(true);
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

  // #668: uploads inherit the gyms/ root from the stored prefix — the folder
  // structure below the gym root is untouched.
  it('uploads under the gyms/ root when the prefix comes from buildGymFolderPrefix()', async () => {
    setConfigured();
    const { buildGymFolderPrefix, uploadGymImage } = await import('../infra/storage');
    await uploadGymImage(buildGymFolderPrefix('gym_123', 'Gym Name'), 'Exercises/Images', 'image/png', Buffer.from('x'));
    expect(sendMock.mock.calls[0][0].input.Key).toMatch(
      /^gyms\/gym_123-GymName\/Exercises\/Images\/[0-9a-f-]{36}\.png$/,
    );
  });

  it('generates a distinct key for every upload (no filename collisions)', async () => {
    setConfigured();
    const { uploadGymImage } = await import('../infra/storage');
    const urlA = await uploadGymImage('gym_123-GymName', 'Exercises/Images', 'image/png', Buffer.from('a'));
    const urlB = await uploadGymImage('gym_123-GymName', 'Exercises/Images', 'image/png', Buffer.from('b'));
    expect(urlA).not.toBe(urlB);
  });
});

// ─── #713: Custom Theme logo helpers ──────────────────────────────────────────

describe('extensionForMime()', () => {
  it('maps every mime type a theme logo may use', async () => {
    const { extensionForMime } = await import('../infra/storage');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/svg+xml')).toBe('svg');
  });

  it('falls back to bin so an unknown type can never be extensionless', async () => {
    const { extensionForMime } = await import('../infra/storage');
    expect(extensionForMime('application/x-nonsense')).toBe('bin');
  });
});

describe('buildThemeLogoKey() (#824)', () => {
  it("puts logo.<ext> in the theme's own folder, not the gym's Branding folder", async () => {
    const { buildGymFolderPrefix } = await import('../infra/storage');
    const { buildThemeLogoKey } = await import('../domain/themeLogo');
    const prefix = buildGymFolderPrefix('123', 'Q-Sport');
    expect(buildThemeLogoKey(prefix, '456', 'Crimson Base', 'image/png'))
      .toBe('gyms/123-Q-Sport/Themes/456-CrimsonBase/Logo/logo.png');
    expect(buildThemeLogoKey(prefix, '456', 'Crimson Base', 'image/svg+xml'))
      .toBe('gyms/123-Q-Sport/Themes/456-CrimsonBase/Logo/logo.svg');
  });

  it('never writes into Branding/, which is obsolete', async () => {
    const { buildThemeLogoKey } = await import('../domain/themeLogo');
    expect(buildThemeLogoKey('gyms/g-Name', 't1', 'Dark', 'image/png')).not.toContain('Branding');
  });

  // The logo and the Members backgrounds are siblings inside one theme folder;
  // two definitions of that folder would give a theme two folders.
  it("hangs off the same theme folder the Members images do", async () => {
    const { buildThemeLogoKey } = await import('../domain/themeLogo');
    const { buildThemeMemberImageKey, buildThemeFolderPrefix } = await import('../domain/themeMemberImages');
    const folder = buildThemeFolderPrefix('gyms/g-Name', 't1', 'Dark Modern');
    expect(buildThemeLogoKey('gyms/g-Name', 't1', 'Dark Modern', 'image/png')).toBe(`${folder}/Logo/logo.png`);
    expect(buildThemeMemberImageKey('gyms/g-Name', 't1', 'Dark Modern', 'training')).toBe(`${folder}/Members/training.png`);
  });

  it('only the extension varies between types — which is why a replacement must delete the old key', async () => {
    const { buildThemeLogoKey } = await import('../domain/themeLogo');
    const png = buildThemeLogoKey('gyms/g-Name', 't1', 'Dark', 'image/png');
    const jpg = buildThemeLogoKey('gyms/g-Name', 't1', 'Dark', 'image/jpeg');
    expect(png).not.toBe(jpg);
    expect(png.replace(/\.png$/, '')).toBe(jpg.replace(/\.jpg$/, ''));
  });
});

describe('themeLogoFolderKeys() (#824)', () => {
  it("creates the theme folder and its Logo leaf, outermost first", async () => {
    const { themeLogoFolderKeys } = await import('../domain/themeLogo');
    expect(themeLogoFolderKeys('gyms/123-QSport', '456', 'Crimson Base')).toEqual([
      'gyms/123-QSport/Themes/456-CrimsonBase/',
      'gyms/123-QSport/Themes/456-CrimsonBase/Logo/',
    ]);
  });

  // §"The Themes folder must already exist before the user can upload a logo":
  // the gym-level root belongs to Gym Bucket Initialization (#735), and the
  // upload control is disabled until it is there (#823).
  it('never creates the gym-level Themes/ root, nor Branding/', async () => {
    const { themeLogoFolderKeys } = await import('../domain/themeLogo');
    const keys = themeLogoFolderKeys('gyms/123-QSport', '456', 'Crimson');
    expect(keys).not.toContain('gyms/123-QSport/Themes/');
    expect(keys.some((k) => k.includes('Branding'))).toBe(false);
  });

  it('every key is a folder marker, so it can only ever overwrite another marker', async () => {
    const { themeLogoFolderKeys } = await import('../domain/themeLogo');
    for (const key of themeLogoFolderKeys('gyms/123-QSport', '456', 'Crimson')) {
      expect(key.endsWith('/')).toBe(true);
    }
  });
});

describe('buildStorageObjectUrl()', () => {
  it('composes endpoint + bucket + key', async () => {
    setConfigured();
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl('gyms/g-Name/Branding/Logo/logo.png'))
      .toBe('https://example.r2.cloudflarestorage.com/test-bucket/gyms/g-Name/Branding/Logo/logo.png');
  });

  it('returns null for a missing key, and when the deployment has no R2 configured', async () => {
    const { buildStorageObjectUrl } = await import('../infra/storage');
    expect(buildStorageObjectUrl('gyms/g-Name/Branding/Logo/logo.png')).toBeNull();
    setConfigured();
    expect(buildStorageObjectUrl(null)).toBeNull();
    expect(buildStorageObjectUrl(undefined)).toBeNull();
  });
});

describe('deleteStorageObject()', () => {
  it('sends a delete for exactly that key', async () => {
    setConfigured();
    const { deleteStorageObject } = await import('../infra/storage');
    await deleteStorageObject('gyms/g-Name/Branding/Logo/logo.png');
    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'gyms/g-Name/Branding/Logo/logo.png',
    });
  });

  it('wraps a failure in a StorageOperationError naming the operation and key', async () => {
    setConfigured();
    sendMock.mockRejectedValueOnce(new Error('R2 down'));
    const { deleteStorageObject, StorageOperationError } = await import('../infra/storage');
    await expect(deleteStorageObject('gyms/g-Name/x.png')).rejects.toBeInstanceOf(StorageOperationError);
  });
});

describe('getStorageObject()', () => {
  it('returns the bytes and the stored content type', async () => {
    setConfigured();
    sendMock.mockResolvedValueOnce({
      ContentType: 'image/png',
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const { getStorageObject } = await import('../infra/storage');
    const object = await getStorageObject('gyms/g-Name/Branding/Logo/logo.png');
    expect(object.contentType).toBe('image/png');
    expect(object.body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('wraps a bodyless response as a storage failure rather than returning empty bytes', async () => {
    setConfigured();
    sendMock.mockResolvedValueOnce({ ContentType: 'image/png', Body: undefined });
    const { getStorageObject, StorageOperationError } = await import('../infra/storage');
    await expect(getStorageObject('gyms/g-Name/x.png')).rejects.toBeInstanceOf(StorageOperationError);
  });
});

describe('themeLogoUrl()', () => {
  it('stamps the URL with logo_updated_at, since the object key never changes', async () => {
    setConfigured();
    const { themeLogoUrl } = await import('../domain/themeLogo');
    const url = themeLogoUrl({
      logo_object_key: 'gyms/g-Name/Branding/Logo/logo.png',
      logo_updated_at: new Date('2026-09-24T10:00:00Z'),
    });
    expect(url).toBe(
      'https://example.r2.cloudflarestorage.com/test-bucket/gyms/g-Name/Branding/Logo/logo.png'
      + `?v=${new Date('2026-09-24T10:00:00Z').getTime()}`,
    );
  });

  it('omits the stamp when there is no timestamp', async () => {
    setConfigured();
    const { themeLogoUrl } = await import('../domain/themeLogo');
    expect(themeLogoUrl({ logo_object_key: 'gyms/g-Name/Branding/Logo/logo.png', logo_updated_at: null }))
      .toBe('https://example.r2.cloudflarestorage.com/test-bucket/gyms/g-Name/Branding/Logo/logo.png');
  });

  it('is null for a blob-backed or logo-less theme', async () => {
    setConfigured();
    const { themeLogoUrl } = await import('../domain/themeLogo');
    expect(themeLogoUrl({ logo_object_key: null, logo_updated_at: new Date() })).toBeNull();
    expect(themeLogoUrl({})).toBeNull();
  });
});
