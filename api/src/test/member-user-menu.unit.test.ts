import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  familyMemberPreviewSrc, familySectionMembers, signInPath, userMenuItemPath, userMenuItems,
} from '../../../apps/member/src/lib/memberUserMenu';

// #1282 — the Members App avatar is a menu (email, Profile, Log out) and Log out
// asks first. In the API suite for #1009's reason: CI runs `npm test` in `api/`
// only. `lib/memberUserMenu.ts` has no imports, so it is importable here.

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');

function source(...parts: string[]): string {
  return readFileSync(join(MEMBER, ...parts), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const menu = source('src', 'components', 'MemberUserMenu.tsx');
const logout = source('src', 'lib', 'memberLogout.ts');
const dialog = source('src', 'components', 'LogoutConfirmDialog.tsx');
const adminBar = source('src', 'components', 'AdminBar.tsx');
const topBar = source('src', 'components', 'TopBar.tsx');
const familyPage = source('src', 'app', '[locale]', 'family', 'page.tsx');

describe('#1282 what the menu offers', () => {
  it('offers Profile, then Family, then Log out (#3156)', () => {
    expect(userMenuItems()).toEqual(['profile', 'family', 'logout']);
  });

  it('Profile and Family each open their own page (#3156 stage 2)', () => {
    expect(userMenuItemPath('profile', 'es')).toBe('/es/profile');
    expect(userMenuItemPath('family', 'ca')).toBe('/ca/family');
  });

  it('while impersonating, Log out returns to Support mode and keeps the superadmin signed in', () => {
    expect(dialog).toContain('reportImpersonationStopped(apiFetch, session)');
    expect(dialog).toContain('stopImpersonation()');
    // The impersonation branch returns before the sign-out.
    const branch = dialog.indexOf('stopImpersonation()');
    const ret = dialog.indexOf('return;', branch);
    const signOut = dialog.indexOf('logoutMember(apiFetch');
    expect(ret).toBeGreaterThan(branch);
    expect(signOut).toBeGreaterThan(ret);
  });

  it('puts Log out in the Support bar, which has no avatar', () => {
    expect(adminBar).toContain('<LogoutConfirmDialog');
    expect(adminBar).toContain("tNav('logout')");
  });

  it('lands on the sign-in page of the member\'s locale', () => {
    expect(signInPath('ca')).toBe('/ca/sign-in');
    expect(signInPath('en')).toBe('/en/sign-in');
  });
});

describe('#1282 the top bar and the menu', () => {
  it('renders the avatar through the menu, on every page including Profile', () => {
    expect(topBar).toContain('<MemberUserMenu');
    expect(topBar).not.toContain('isProfile');
    expect(topBar).not.toContain("router.push(`${homePath}/profile`)");
  });

  it('shows the entries with menu semantics and no longer the email (#3156)', () => {
    expect(menu).not.toContain('member.email');
    expect(menu).toContain("t(`nav.${i}`)");
    expect(menu).toContain('userMenuItemPath(i, locale)');
    expect(menu).toContain("t('nav.logout')");
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain("e.key === 'Escape'");
  });

  it('asks for confirmation in the app\'s dialog before signing out', () => {
    expect(menu).toContain('<LogoutConfirmDialog');
    expect(menu).not.toContain('logoutMember(');
    expect(dialog).toContain('<MemberDialog');
    // The only caller of the logout is the confirm button's handler.
    expect(dialog.match(/logoutMember\(/g)).toHaveLength(1);
    expect(dialog).toMatch(/async function confirmLogout\(\)[\s\S]*logoutMember\(/);
    expect(dialog).toContain('onClick={confirmLogout}');
  });

  it('spells no colour of its own', () => {
    expect(menu).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(menu.replace(/rgba\(0,0,0,0\.18\)/, '')).not.toMatch(/rgba?\(/);
    expect(dialog).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('#3156 the Family section', () => {
  it('keeps the API order and drops unreadable rows', () => {
    const members = familySectionMembers({ members: [
      { member_id: 2, name: 'Zoe', is_owner: true, image_url: null, image_thumbnail_url: null },
      { member_id: 1, name: 'Anna', is_owner: false, image_url: 'x.webp', image_thumbnail_url: 'x-t.webp' },
      { name: 'no id' },
      null,
    ] });
    expect(members.map((m) => m.member_id)).toEqual([2, 1]);
  });

  it('lists nobody for an unreadable answer, so the section is absent', () => {
    expect(familySectionMembers(null)).toEqual([]);
    expect(familySectionMembers({})).toEqual([]);
    expect(familySectionMembers({ members: 'x' })).toEqual([]);
  });

  it('enlarges the 1080 × 1080 master, never the thumbnail, and nothing without a photo', () => {
    expect(familyMemberPreviewSrc({ image_url: 'https://cdn/m.webp' })).toBe('https://cdn/m.webp');
    expect(familyMemberPreviewSrc({ image_url: null })).toBeNull();
    expect(familyMemberPreviewSrc({ image_url: '  ' })).toBeNull();
  });

  it('lists the members on the Family page, never as menu options (#3156 stage 2)', () => {
    expect(menu).not.toContain("apiFetch('/me/family')");
    expect(menu).not.toContain('<ImagePreviewButton');
    expect(familyPage).toContain("apiFetch('/me/family')");
    expect(familyPage).toContain('familySectionMembers(body)');
    expect(familyPage).toContain('<ImagePreviewButton');
    expect(familyPage).toContain("t('nav.family_owner')");
  });
});

describe('#1282 the logout sequence', () => {
  it('removes the push token before the session ends, then lands on sign-in', () => {
    const unregister = logout.indexOf('unregisterPushToken(apiFetch)');
    const signOut = logout.indexOf('signOut(');
    expect(unregister).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(unregister);
    expect(logout).toContain('signInPath(locale)');
  });
});

describe('#1282 the labels exist in every locale', () => {
  for (const locale of ['en', 'es', 'ca']) {
    it(`${locale} has the menu keys`, () => {
      const nav = JSON.parse(readFileSync(join(MEMBER, 'locales', 'base', `${locale}.json`), 'utf-8')).nav;
      for (const key of ['user_menu', 'logout', 'logout_confirm_title', 'logout_confirm_body', 'logout_cancel', 'family', 'family_owner']) {
        expect(typeof nav[key]).toBe('string');
        expect(nav[key].length).toBeGreaterThan(0);
      }
      const family = JSON.parse(readFileSync(join(MEMBER, 'locales', 'base', `${locale}.json`), 'utf-8')).family;
      for (const key of ['title', 'loading', 'empty']) expect(typeof family[key]).toBe('string');
    });
  }
});
