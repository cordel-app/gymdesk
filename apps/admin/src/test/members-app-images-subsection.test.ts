import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1038 — the Members App images are a subsection *of* Members App.
//
// They were a top-level Theme section of their own, labelled "Members App" in
// all three languages — the same label the Members App settings section carries
// (#833), so the editor showed two sections with one name. This moves the
// images inside that section as its `Images` subsection and adds the seventh
// slot, `personal_goals`, for My Goals.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like theme-members-images.test.ts (#725) beside it — the
// structure is pinned by scanning the two page sources, the two editors and the
// locale files.

const GYM_PAGE = join(__dirname, '..', 'app', '[locale]', 'themes', 'page.tsx');
const BASE_PAGE = join(__dirname, '..', 'app', '[locale]', 'system', 'themes', 'page.tsx');
const MEMBERS_APP_EDITOR = join(__dirname, '..', 'components', 'ThemeMembersAppEditor.tsx');
const IMAGES_EDITOR = join(__dirname, '..', 'components', 'ThemeMembersImagesEditor.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['gym_themes', 'themes'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const gymPageSrc = stripComments(readFileSync(GYM_PAGE, 'utf-8'));
const basePageSrc = stripComments(readFileSync(BASE_PAGE, 'utf-8'));
const membersAppSrc = stripComments(readFileSync(MEMBERS_APP_EDITOR, 'utf-8'));
const imagesEditorSrc = stripComments(readFileSync(IMAGES_EDITOR, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Members App → Images (#1038)', () => {
  it('is one subsection of Members App on both Theme screens', () => {
    for (const src of [gymPageSrc, basePageSrc]) {
      // The images editor is rendered as the Members App editor's `images`.
      expect(src).toMatch(/<ThemeMembersAppEditor[\s\S]*?images=\{\([\s\S]*?<ThemeMembersImagesEditor/);
      // …and exactly once, so there is no second copy left behind beside it.
      expect(src.match(/<ThemeMembersImagesEditor/g)).toHaveLength(1);
    }
  });

  it('leaves no top-level Members images section behind', () => {
    for (const src of [gymPageSrc, basePageSrc]) {
      expect(src).not.toContain('section_members_images');
      expect(src).not.toMatch(/renderSection\([^)]*'members'[^_]/);
      // The section key is gone from the union too, so a stale `openSections`
      // entry cannot be toggled by anything.
      expect(src).not.toMatch(/type SectionKey = [^;]*'members'\s*\|/);
    }
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        expect((locales[code][ns] as Record<string, unknown>).section_members_images).toBeUndefined();
      }
    }
  });

  it('wears the same collapsible header as the settings groups, declared once', () => {
    // One chrome declaration for every subsection of this section: the Images
    // subsection is that control, not a second accordion look beside it.
    expect(membersAppSrc).toMatch(/function renderSubsection\(sectionKey: string, body: React\.ReactNode\)/);
    expect(membersAppSrc.match(/aria-expanded=\{open\}/g)).toHaveLength(1);
    expect(membersAppSrc).toContain('renderSubsection(MEMBERS_APP_IMAGES_SECTION, images)');
    expect(membersAppSrc).toContain('renderSubsection(sectionKey, (');
    // Its key is named in one place and resolves in the page's own namespace.
    expect(membersAppSrc).toContain("export const MEMBERS_APP_IMAGES_SECTION = 'group_members_images';");
  });

  it('puts Images before the settings groups', () => {
    const images = membersAppSrc.indexOf('renderSubsection(MEMBERS_APP_IMAGES_SECTION');
    const groups = membersAppSrc.indexOf('MEMBERS_APP_SECTIONS.map(');
    expect(images).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(images);
  });

  it('renders no Images subsection at all when the page passes none', () => {
    // The Base Themes screen withholds it for a theme that does not exist yet
    // (there is no id to upload an image to), and an absent subsection is not
    // an empty one.
    expect(membersAppSrc).toContain('{images !== undefined && renderSubsection(');
    expect(basePageSrc).toMatch(/!isNew && renderSection\('members_app'/);
  });

  it('keeps the Members App editor ignorant of uploads', () => {
    // It takes a node, not a slot list: the page still owns the draft, the
    // previews and the two calls on Save (#725's lifecycle, unchanged).
    expect(membersAppSrc).not.toContain('MEMBER_IMAGE_SLOTS');
    expect(membersAppSrc).not.toContain('apiFetch');
    expect(membersAppSrc).not.toContain('members-images');
    expect(membersAppSrc).not.toContain('object_key');
  });
});

describe('the My Goals slot (#1038)', () => {
  it('sits between My Membership and the general background', () => {
    const declared = imagesEditorSrc.match(/export const MEMBER_IMAGE_SLOTS = \[([^\]]+)\]/)?.[1] ?? '';
    const parsed = [...declared.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // #1158's `next_bookings` sits beside the My Bookings tile it must never share an object with.
    expect(parsed).toEqual(['training', 'nutrition', 'calendar', 'bookings', 'next_bookings', 'membership', 'personal_goals', 'background']);
  });

  it('is labelled in en, es and ca, in both namespaces', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        const section = locales[code][ns] as Record<string, string>;
        for (const key of ['group_members_images', 'members_image_personal_goals', 'members_image_next_bookings']) {
          expect(typeof section?.[key], `${code}.${ns}.${key}`).toBe('string');
          expect(section[key].trim().length, `${code}.${ns}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('names the slot nowhere but the one declaration', () => {
    // The storage file name is `personal_goals.png` and the key is built from
    // the slot, so a page spelling the slot itself would be a second place that
    // decides where the object lives.
    for (const src of [gymPageSrc, basePageSrc]) {
      expect(src).not.toContain('personal_goals');
      expect(src).not.toContain('next_bookings');
    }
  });
});
