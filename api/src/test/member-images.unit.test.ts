// #1374 — a **Member's profile image**: the key it is stored under, the folder
// markers, the ownership predicate and the upload rules. Pure, so no DB and no
// bucket (`domain/memberImages.ts` is the one place all four are decided).

import { beforeEach, describe, expect, it } from 'vitest';
import {
  MEMBERS_FOLDER,
  MEMBER_IMAGE_INPUT_FORMATS,
  MEMBER_IMAGE_REJECTION_MESSAGES,
  MEMBER_IMAGE_SIZE,
  MEMBER_IMAGE_STORED_MIME,
  MEMBER_IMAGE_THUMBNAIL_SIZE,
  buildMemberImageKey,
  buildMemberImageThumbnailKey,
  isGymOwnedMemberImageUrl,
  memberImageFolderKeys,
  memberImageMaxBytes,
  memberImageUploadRateLimitMax,
  sanitizeMemberImageName,
} from '../domain/memberImages';

const PREFIX = 'gyms/gym_abc-Fitness-Club';

describe('member image keys (#1374 §1, #1449)', () => {
  it('is <prefix>/members/<member_id>-<sanitized name>.webp', () => {
    expect(buildMemberImageKey(PREFIX, 42, 'María José Pérez'))
      .toBe(`${PREFIX}/members/42-Maria-Jose-Perez.webp`);
  });

  it('the thumbnail is the same key with -thumbnail before the extension', () => {
    expect(buildMemberImageThumbnailKey(PREFIX, 42, 'María José Pérez'))
      .toBe(`${PREFIX}/members/42-Maria-Jose-Perez-thumbnail.webp`);
  });

  it('spells the folder as the storage constant, lowercase', () => {
    expect(MEMBERS_FOLDER).toBe('members');
    expect(buildMemberImageKey(PREFIX, 1, 'x')).toContain(`/${MEMBERS_FOLDER}/`);
  });

  it('is deterministic: the same member builds the same key', () => {
    expect(buildMemberImageKey(PREFIX, 7, 'Ana Ruiz')).toBe(buildMemberImageKey(PREFIX, 7, 'Ana Ruiz'));
  });

  it('never takes the uploaded file name: punctuation-only names fall back to "member"', () => {
    expect(sanitizeMemberImageName('!!!')).toBe('member');
    expect(buildMemberImageKey(PREFIX, 9, '...')).toBe(`${PREFIX}/members/9-member.webp`);
  });

  it('caps the name part so the URL fits VARCHAR(1024), without a trailing hyphen', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Name${i}`).join(' ');
    const sanitized = sanitizeMemberImageName(long);
    expect(sanitized.length).toBeLessThanOrEqual(80);
    expect(sanitized.endsWith('-')).toBe(false);
  });

  it('lists the folder markers outermost first', () => {
    expect(memberImageFolderKeys(PREFIX)).toEqual([`${PREFIX}/`, `${PREFIX}/members/`]);
  });
});

describe('ownership (#719 §19, one feature over)', () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.example.com';
  });

  const url = (key: string) => `https://cdn.example.com/${key}`;

  it('answers false for nothing, for a URL that is not ours and for a bare key', () => {
    expect(isGymOwnedMemberImageUrl(null, PREFIX)).toBe(false);
    expect(isGymOwnedMemberImageUrl('https://example.org/photo.png', PREFIX)).toBe(false);
    expect(isGymOwnedMemberImageUrl(url(`${PREFIX}/members/1-a.png`), null)).toBe(false);
    expect(isGymOwnedMemberImageUrl(`${PREFIX}/members/1-a.png`, PREFIX)).toBe(false);
  });

  it("is true only under this gym's members/ branch", () => {
    expect(isGymOwnedMemberImageUrl(url(`${PREFIX}/members/1-Ana.png`), PREFIX)).toBe(true);
    // Another gym whose prefix starts the same way.
    expect(isGymOwnedMemberImageUrl(url(`${PREFIX}Plus/members/1-Ana.png`), PREFIX)).toBe(false);
    // The gym's own object of another feature is not this one's to delete.
    expect(isGymOwnedMemberImageUrl(url(`${PREFIX}/goals/1-Weight.png`), PREFIX)).toBe(false);
    // The platform's.
    expect(isGymOwnedMemberImageUrl(url('cordel/goals/1-Weight.png'), PREFIX)).toBe(false);
  });
});

describe('upload rules (#1449)', () => {
  it('stores 1080 and 256, both WebP, and accepts four input formats', () => {
    expect(MEMBER_IMAGE_SIZE).toBe(1080);
    expect(MEMBER_IMAGE_THUMBNAIL_SIZE).toBe(256);
    expect(MEMBER_IMAGE_STORED_MIME).toBe('image/webp');
    expect([...MEMBER_IMAGE_INPUT_FORMATS]).toEqual(['jpeg', 'png', 'webp', 'gif']);
  });

  it('bounds the upload by MEMBER_IMAGE_MAX_MB: default 10, clamped at 25', () => {
    expect(memberImageMaxBytes({})).toBe(10 * 1024 * 1024);
    expect(memberImageMaxBytes({ MEMBER_IMAGE_MAX_MB: '5' })).toBe(5 * 1024 * 1024);
    expect(memberImageMaxBytes({ MEMBER_IMAGE_MAX_MB: '500' })).toBe(25 * 1024 * 1024);
    expect(memberImageMaxBytes({ MEMBER_IMAGE_MAX_MB: 'abc' })).toBe(10 * 1024 * 1024);
    expect(memberImageMaxBytes({ MEMBER_IMAGE_MAX_MB: '-3' })).toBe(10 * 1024 * 1024);
  });

  it('limits uploads per person: default 30 per window, MEMBER_IMAGE_UPLOAD_RATE_LIMIT_MAX overrides', () => {
    expect(memberImageUploadRateLimitMax({})).toBe(30);
    expect(memberImageUploadRateLimitMax({ MEMBER_IMAGE_UPLOAD_RATE_LIMIT_MAX: '5' })).toBe(5);
    expect(memberImageUploadRateLimitMax({ MEMBER_IMAGE_UPLOAD_RATE_LIMIT_MAX: 'x' })).toBe(30);
  });

  it('has a message for every rejection', () => {
    for (const reason of ['unreadable', 'unsupported_format', 'too_many_pixels'] as const) {
      expect(MEMBER_IMAGE_REJECTION_MESSAGES[reason]).toBeTruthy();
    }
  });
});
