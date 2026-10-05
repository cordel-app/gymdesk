// #725 unit tests: where a Custom Theme's Members App images are stored, what
// the API says about them, and what the server accepts. Pure functions only —
// no database, no HTTP (CLAUDE.md). The routes that use them are covered by
// `theme-members-images.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_MIME_TYPES,
  MEMBER_IMAGE_SLOTS,
  buildThemeFolderPrefix,
  buildThemeMemberImageKey,
  bytesMatchImageMime,
  emptyMemberImageUrls,
  isMemberImageSlot,
  memberImageUrls,
  themeMemberFolderKeys,
} from '../domain/themeMemberImages';
import { PLATFORM_STORAGE_ROOT, buildGymFolderPrefix, sanitizeStorageFolderName } from '../infra/storage';

const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const originalEndpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
const originalBucket = process.env.CLOUDFLARE_R2_BUCKET;

const GYM_ID = '11111111-1111-1111-1111-111111111111';
const THEME_ID = '22222222-2222-2222-2222-222222222222';

beforeAll(() => {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
});

afterAll(() => {
  if (originalEndpoint === undefined) delete process.env.CLOUDFLARE_R2_ENDPOINT;
  else process.env.CLOUDFLARE_R2_ENDPOINT = originalEndpoint;
  if (originalBucket === undefined) delete process.env.CLOUDFLARE_R2_BUCKET;
  else process.env.CLOUDFLARE_R2_BUCKET = originalBucket;
});

describe('Members image slots (#725, #1038)', () => {
  it('has exactly the slots the two tickets define', () => {
    expect([...MEMBER_IMAGE_SLOTS]).toEqual([
      // #725's six, in its own order…
      'training', 'nutrition', 'calendar', 'bookings', 'background', 'membership',
      // …and #1038's seventh, for the My Goals section.
      'personal_goals',
    ]);
  });

  it('accepts only those as a slot', () => {
    for (const slot of MEMBER_IMAGE_SLOTS) expect(isMemberImageSlot(slot)).toBe(true);
    for (const value of ['logo', 'Training', '', '../background', 'goals', 'personal-goals', null, 7]) {
      expect(isMemberImageSlot(value)).toBe(false);
    }
  });

  /**
   * CLAUDE.md's "two places" rule for this list, as a gate rather than a note:
   * a slot added to `MEMBER_IMAGE_SLOTS` alone uploads the object to R2 and
   * *then* fails the insert against `chk_theme_member_images_slot`, leaving an
   * orphan and a 500. Migration 219 is the CHECK's current definition, so the
   * two are compared directly — and the slot names are compared as a **set**,
   * because the order in a CHECK is irrelevant while the order in the list is
   * the UI's business.
   */
  it('is mirrored by the CHECK in migration 219', () => {
    const migration = readFileSync(
      join(__dirname, '..', 'infra', 'migrations', '219_theme_member_images_personal_goals_slot.js'),
      'utf-8',
    );
    const declared = migration.match(/const SLOTS = \[([^\]]+)\]/)?.[1] ?? '';
    const slots = [...declared.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(slots.length).toBeGreaterThan(0);
    expect([...slots].sort()).toEqual([...MEMBER_IMAGE_SLOTS].sort());
  });

  /**
   * The slot name *is* the object's file name, and the ticket asks for
   * `personal_goals.png` by name. R2 has no directories, so a key already
   * stored on a row is the only way back to its object: re-spelling the slot
   * would strand every image uploaded under the old name (#829's reasoning for
   * the folder names, applied to a file name).
   */
  it('stores My Goals as `personal_goals.png`', () => {
    expect(buildThemeMemberImageKey('cordel', THEME_ID, 'Dark Modern', 'personal_goals'))
      .toBe(`cordel/themes/${THEME_ID}-DarkModern/members_app/personal_goals.png`);
  });
});

describe('object keys (#725 §Objective, §Customer Theme Ownership)', () => {
  const folderPrefix = buildGymFolderPrefix(GYM_ID, 'Acme Fitness');

  it('nests the theme folder under the gym folder and `themes/`', () => {
    expect(buildThemeFolderPrefix(folderPrefix, THEME_ID, 'Dark Modern'))
      .toBe(`gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-DarkModern`);
  });

  it('uses the fixed filename per slot, always `.png`', () => {
    for (const slot of MEMBER_IMAGE_SLOTS) {
      expect(buildThemeMemberImageKey(folderPrefix, THEME_ID, 'Dark Modern', slot))
        .toBe(`gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-DarkModern/members_app/${slot}.png`);
    }
  });

  it('never lets a theme name introduce a path separator', () => {
    const key = buildThemeMemberImageKey(folderPrefix, THEME_ID, '../../other gym/evil', 'training');
    expect(key).toBe(`gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-othergymevil/members_app/training.png`);
    // gyms / <gym> / themes / <theme> / members_app / training.png — the depth the
    // key always has, so a name can never climb out of its own folder.
    expect(key.split('/')).toHaveLength(6);
    expect(sanitizeStorageFolderName('../../other gym/evil')).toBe('othergymevil');
  });

  it('gives two themes of one gym separate folders', () => {
    const a = buildThemeMemberImageKey(folderPrefix, '10', 'Dark Modern', 'training');
    const b = buildThemeMemberImageKey(folderPrefix, '11', 'Dark Modern', 'training');
    expect(a).not.toBe(b);
  });

  it('is deterministic — the same inputs always give the same key', () => {
    expect(buildThemeMemberImageKey(folderPrefix, THEME_ID, 'Dark Modern', 'bookings'))
      .toBe(buildThemeMemberImageKey(folderPrefix, THEME_ID, 'Dark Modern', 'bookings'));
  });

  it('lists the whole folder hierarchy outermost first', () => {
    expect(themeMemberFolderKeys(folderPrefix, THEME_ID, 'Dark Modern')).toEqual([
      `gyms/${GYM_ID}-AcmeFitness/`,
      `gyms/${GYM_ID}-AcmeFitness/themes/`,
      `gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-DarkModern/`,
      `gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-DarkModern/members_app/`,
    ]);
  });

  it('only ever writes folder markers — every hierarchy key ends in `/`', () => {
    for (const key of themeMemberFolderKeys(folderPrefix, THEME_ID, 'Dark Modern')) {
      expect(key.endsWith('/')).toBe(true);
    }
  });
});

// ─── Base Themes (#732) ──────────────────────────────────────────────────────

describe('platform object keys (#732)', () => {
  it('puts a Base Theme under `cordel/themes/`, with the same slot filenames', () => {
    for (const slot of MEMBER_IMAGE_SLOTS) {
      expect(buildThemeMemberImageKey(PLATFORM_STORAGE_ROOT, THEME_ID, 'Dark Modern', slot))
        .toBe(`cordel/themes/${THEME_ID}-DarkModern/members_app/${slot}.png`);
    }
  });

  it('never uses a gym storage prefix', () => {
    const key = buildThemeMemberImageKey(PLATFORM_STORAGE_ROOT, THEME_ID, 'Dark Modern', 'training');
    expect(key.startsWith('cordel/')).toBe(true);
    expect(key).not.toContain('gyms/');
    // `cordel/` and `gyms/` are siblings, so a platform key and a gym key for
    // the same theme id can never collide.
    expect(key).not.toBe(buildThemeMemberImageKey(buildGymFolderPrefix(GYM_ID, 'Acme Fitness'), THEME_ID, 'Dark Modern', 'training'));
  });

  it('sanitizes a Base Theme name the same way, so it cannot climb out of its folder', () => {
    const key = buildThemeMemberImageKey(PLATFORM_STORAGE_ROOT, THEME_ID, '../../gyms/evil', 'training');
    expect(key).toBe(`cordel/themes/${THEME_ID}-gymsevil/members_app/training.png`);
    // cordel / themes / <theme> / members_app / training.png
    expect(key.split('/')).toHaveLength(5);
  });

  it('lists the platform hierarchy outermost first, markers only', () => {
    const keys = themeMemberFolderKeys(PLATFORM_STORAGE_ROOT, THEME_ID, 'Dark Modern');
    expect(keys).toEqual([
      'cordel/',
      'cordel/themes/',
      `cordel/themes/${THEME_ID}-DarkModern/`,
      `cordel/themes/${THEME_ID}-DarkModern/members_app/`,
    ]);
    for (const key of keys) expect(key.endsWith('/')).toBe(true);
  });
});

describe('the API shape (#725 §Database / Storage References)', () => {
  it('returns one field per slot, null for an unconfigured slot', () => {
    expect(emptyMemberImageUrls()).toEqual({
      training_url: null,
      nutrition_url: null,
      calendar_url: null,
      bookings_url: null,
      background_url: null,
      membership_url: null,
      personal_goals_url: null,
    });
  });

  it('resolves a stored key to its R2 URL with a cache-busting stamp', () => {
    const modified = new Date('2026-09-24T10:00:00Z');
    const urls = memberImageUrls([
      { slot: 'training', object_key: 'gyms/g/themes/t/members_app/training.png', modified_at: modified },
    ]);
    expect(urls.training_url).toBe(`${R2_ENDPOINT}/${R2_BUCKET}/gyms/g/themes/t/members_app/training.png?v=${modified.getTime()}`);
    expect(urls.nutrition_url).toBeNull();
  });

  it('leaves every other slot untouched when one is configured', () => {
    const urls = memberImageUrls([{ slot: 'bookings', object_key: 'k', modified_at: null }]);
    expect(urls.bookings_url).toContain('/k');
    expect([urls.training_url, urls.nutrition_url, urls.calendar_url, urls.background_url, urls.membership_url, urls.personal_goals_url])
      .toEqual([null, null, null, null, null, null]);
  });

  it('resolves the My Goals slot like any other (#1038)', () => {
    const urls = memberImageUrls([
      { slot: 'personal_goals', object_key: 'cordel/themes/t/members_app/personal_goals.png', modified_at: null },
    ]);
    expect(urls.personal_goals_url).toContain('/members_app/personal_goals.png');
    expect(urls.membership_url).toBeNull();
  });

  it('ignores a row whose slot is not one of them', () => {
    expect(memberImageUrls([{ slot: 'logo', object_key: 'k', modified_at: null }])).toEqual(emptyMemberImageUrls());
  });
});

describe('server-side upload validation (#725 §Tests → Upload)', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

  it('accepts PNG, JPEG and WebP bytes for their own type', () => {
    expect([...MEMBER_IMAGE_MIME_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(bytesMatchImageMime('image/png', PNG)).toBe(true);
    expect(bytesMatchImageMime('image/jpeg', JPEG)).toBe(true);
    expect(bytesMatchImageMime('image/webp', WEBP)).toBe(true);
  });

  it('rejects bytes that are not the declared type', () => {
    expect(bytesMatchImageMime('image/png', JPEG)).toBe(false);
    expect(bytesMatchImageMime('image/jpeg', PNG)).toBe(false);
    expect(bytesMatchImageMime('image/webp', PNG)).toBe(false);
  });

  it('rejects a non-image renamed to an image type', () => {
    expect(bytesMatchImageMime('image/png', Buffer.from('<html>not an image</html>'))).toBe(false);
    expect(bytesMatchImageMime('image/webp', Buffer.from('RIFFxxxxAVI '))).toBe(false);
  });

  it('rejects a truncated file whose header cannot be read', () => {
    expect(bytesMatchImageMime('image/png', PNG.subarray(0, 4))).toBe(false);
    expect(bytesMatchImageMime('image/webp', Buffer.from('RIFF'))).toBe(false);
    expect(bytesMatchImageMime('image/png', Buffer.alloc(0))).toBe(false);
  });

  it('rejects a body that is a string or an array rather than bytes', () => {
    // A parser can leave either in `req.body`, and both carry a `length` and
    // numeric indices — so without the guard they would read as a half-valid
    // signature instead of being refused.
    const asPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(bytesMatchImageMime('image/png', asPng as unknown as Buffer)).toBe(false);
    expect(bytesMatchImageMime('image/jpeg', [0xff, 0xd8, 0xff] as unknown as Buffer)).toBe(false);
    expect(bytesMatchImageMime('image/webp', 'RIFF0000WEBP' as unknown as Buffer)).toBe(false);
    expect(bytesMatchImageMime('image/png', {} as unknown as Buffer)).toBe(false);
    expect(bytesMatchImageMime('image/png', null as unknown as Buffer)).toBe(false);
  });

  it('rejects a MIME type outside the allow-list, whatever the bytes', () => {
    expect(bytesMatchImageMime('image/svg+xml', PNG)).toBe(false);
    expect(bytesMatchImageMime('application/octet-stream', PNG)).toBe(false);
  });

  it('caps an upload at 4 MB', () => {
    expect(MEMBER_IMAGE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
});
