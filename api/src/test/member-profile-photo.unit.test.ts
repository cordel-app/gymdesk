// #1375 — the Member's own profile photo: the structure the ticket fixes, held
// in the API suite because CI runs `npm test` in `api/` only.
//
// 1. Both routers write through the one storage module — no second upload
//    body in `members.ts` or in `me-profile-image.ts`.
// 2. The Members App renders the avatar through one component, in the top bar
//    and on the Profile page alike.
// 3. The Profile page offers no upload while impersonating.
// 4. The Members App's prepared size equals the API's accepted size.
// 5. Nothing native is reached for the picker: a plain file input.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_IMAGE_SIZE } from '../domain/memberImages';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const membersRouter = read('api/src/api/members.ts');
const meImageRouter = read('api/src/api/me-profile-image.ts');
const storage = read('api/src/api/member-image-storage.ts');
const menu = read('apps/member/src/components/MemberUserMenu.tsx');
const profilePage = read('apps/member/src/app/[locale]/profile/page.tsx');
const photoField = read('apps/member/src/components/MemberPhotoField.tsx');
const avatar = read('apps/member/src/components/MemberAvatar.tsx');
const memberUpload = read('apps/member/src/lib/memberImageUpload.ts');
const appTs = read('api/src/app.ts');

describe('one storage module for both image paths (#1375 §3)', () => {
  it('both routers import the upload, the clear and the request judgement from it', () => {
    for (const src of [membersRouter, meImageRouter]) {
      expect(src).toContain("from './member-image-storage'");
      expect(src).toContain('storeMemberImage(');
      expect(src).toContain('clearMemberImage(');
      expect(src).toContain('parseMemberImageRequest(');
    }
  });

  it('neither router uploads, validates or sweeps for itself', () => {
    for (const src of [membersRouter, meImageRouter]) {
      expect(src).not.toContain('uploadStorageObject(');
      expect(src).not.toContain('validateMemberImage(');
      expect(src).not.toContain('deleteStorageObject(');
      expect(src).not.toContain('express.raw(');
    }
    expect(storage).toContain('uploadStorageObject(');
    expect(storage).toContain('validateMemberImage(');
  });

  it('the member path resolves the caller and never reads an id from the request', () => {
    expect(meImageRouter).toContain('resolveMemberId(');
    expect(meImageRouter).not.toContain('req.params');
    expect(meImageRouter).not.toContain('req.body.member_id');
    expect(meImageRouter).not.toContain('req.query');
  });

  it('is guarded by the member role and the Profile page flag, and mounted before /me', () => {
    expect(meImageRouter).toContain("requireRole('member')");
    expect(meImageRouter).toContain("requireFeatureEnabled('member_web.profile')");
    const mount = appTs.indexOf("app.use('/me/profile/image'");
    const me = appTs.indexOf("app.use('/me',");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(me);
  });
});

describe('one avatar rendering in the Members App', () => {
  it('the top bar menu and the Profile page draw the avatar through MemberAvatar', () => {
    expect(menu).toContain('<MemberAvatar');
    expect(menu).not.toContain('<img');
    expect(menu).not.toContain('memberInitials(');
    expect(photoField).toContain('<MemberAvatar');
    expect(photoField).not.toContain('<img');
    expect(profilePage).toContain('<MemberPhotoField');
  });

  it('the avatar falls back to the initials when the photo fails to load', () => {
    expect(avatar).toContain('onError=');
    expect(avatar).toContain('memberInitials(');
    expect(avatar).toContain('memberAvatarSrc(');
  });

  it('offers no control while impersonating', () => {
    expect(profilePage).toContain('canEdit={!isImpersonating}');
    expect(photoField).toContain('{canEdit && (');
  });
});

describe('the browser prepares the one shape the API accepts', () => {
  it('prepares to the API\'s own size', () => {
    const m = memberUpload.match(/export const MEMBER_IMAGE_SIZE = (\d+);/);
    expect(m && Number(m[1])).toBe(MEMBER_IMAGE_SIZE);
  });

  it('uses a plain file input and nothing from the native plugins', () => {
    expect(photoField).toContain('type="file"');
    expect(photoField).not.toContain('nativePlugins');
    expect(memberUpload).not.toContain('@capacitor');
    expect(memberUpload).not.toContain('@capgo');
  });

  it('removal asks first, through the app\'s one dialog shell', () => {
    expect(photoField).toContain('<MemberDialog');
  });
});
