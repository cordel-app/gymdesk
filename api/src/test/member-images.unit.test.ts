// #1374 — a **Member's profile image**: the key it is stored under, the folder
// markers, the ownership predicate and the upload rules. Pure, so no DB and no
// bucket (`domain/memberImages.ts` is the one place all four are decided).

import { beforeEach, describe, expect, it } from 'vitest';
import { encodePngRgba } from '../domain/pngImage';
import {
  MEMBERS_FOLDER,
  MEMBER_IMAGE_SIZE,
  buildMemberImageKey,
  isGymOwnedMemberImageUrl,
  memberImageFolderKeys,
  sanitizeMemberImageName,
  validateMemberImage,
} from '../domain/memberImages';

const PREFIX = 'gyms/gym_abc-Fitness-Club';

describe('member image key (#1374 §1)', () => {
  it('is <prefix>/members/<member_id>-<sanitized name>.png', () => {
    expect(buildMemberImageKey(PREFIX, 42, 'María José Pérez'))
      .toBe(`${PREFIX}/members/42-Maria-Jose-Perez.png`);
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
    expect(buildMemberImageKey(PREFIX, 9, '...')).toBe(`${PREFIX}/members/9-member.png`);
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

describe('upload rules (#1374 §3)', () => {
  function png(width: number, height = width, colorType = 6): Buffer {
    const buf = Buffer.from(encodePngRgba(1, 1, Buffer.alloc(4, 0x40)));
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[25] = colorType;
    return buf;
  }

  it('accepts exactly 512×512, with or without an alpha channel', () => {
    expect(validateMemberImage(encodePngRgba(MEMBER_IMAGE_SIZE, MEMBER_IMAGE_SIZE, Buffer.alloc(MEMBER_IMAGE_SIZE * MEMBER_IMAGE_SIZE * 4)))).toBeNull();
    expect(validateMemberImage(png(512, 512, 2))).toBeNull();
  });

  it('refuses any other size — smaller, larger or non-square', () => {
    expect(validateMemberImage(png(511, 512))).toBe('wrong_dimensions');
    expect(validateMemberImage(png(513))).toBe('wrong_dimensions');
    expect(validateMemberImage(png(256))).toBe('wrong_dimensions');
    expect(validateMemberImage(png(512, 768))).toBe('wrong_dimensions');
  });

  it('refuses anything that is not a PNG, from the bytes', () => {
    expect(validateMemberImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('not_a_png');
    expect(validateMemberImage('not bytes')).toBe('not_a_png');
    expect(validateMemberImage(Buffer.alloc(0))).toBe('not_a_png');
  });
});
