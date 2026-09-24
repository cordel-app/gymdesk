import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #732 — the Members App section of the **Base Theme** editor (System → Themes).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like theme-members-images.test.ts (#725), whose Custom Theme
// counterpart this mirrors — it pins the structure down by scanning the page
// source and the locale files. The editor component itself is #725's and is
// covered there; what this file asserts is that the Base Theme page reuses it
// rather than growing a second one, and talks to the platform routes.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'system', 'themes', 'page.tsx');
const EDITOR_PATH = join(__dirname, '..', 'components', 'ThemeMembersImagesEditor.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The six slots #732 defines, one per Members section. */
const SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'membership', 'background'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const editorSrc = stripComments(readFileSync(EDITOR_PATH, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Base Themes: Members App images (#732)', () => {
  it('adds a Members App section to the existing editor, not a new screen', () => {
    expect(pageSrc).toMatch(/type SectionKey = [^;]*'members'/);
    expect(pageSrc).toContain("renderSection('members', t('section_members_images')");
    expect(pageSrc).toContain('<ThemeMembersImagesEditor');
    expect(pageSrc).not.toMatch(/MembersImages[A-Za-z]*Modal/);
  });

  it('reuses #725\'s editor component instead of a second implementation', () => {
    expect(pageSrc).toContain("from '@/components/ThemeMembersImagesEditor'");
    // The six slots are named in one place, and it is not this page.
    const declared = editorSrc.match(/export const MEMBER_IMAGE_SLOTS = \[([^\]]+)\]/)?.[1] ?? '';
    expect([...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...SLOTS]);
    expect(pageSrc).not.toMatch(/const [A-Z_]*SLOTS\s*=\s*\[/);
  });

  it('writes the slots of a Base Theme, so they are editable rather than read-only', () => {
    // The gym-side editor passes `readOnly` for a Base Theme (#725); the
    // platform screen is where that theme is actually configured.
    const usage = pageSrc.match(/<ThemeMembersImagesEditor[\s\S]*?\/>/)?.[0] ?? '';
    expect(usage).not.toContain('readOnly');
  });

  it('stages picks and removals until Save, and discards them on Cancel', () => {
    expect(pageSrc).toMatch(/membersImageFiles\[slot\] !== null \|\| membersImageRemovals\[slot\]/);
    expect(pageSrc).toContain('setMembersImageFiles(bySlot(null))');
    expect(pageSrc).toContain('setMembersImageRemovals(bySlot(false))');
    // Cancel collapses the editor, which resets all three draft maps.
    const closeBody = pageSrc.match(/function closeEditor\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(closeBody).toContain('setMembersImagePreviews(bySlot(null))');
  });

  it('uploads and clears through the platform routes, one call per touched slot', () => {
    expect(pageSrc).toContain('`/api/proxy/platform/themes/${themeId}/members-images/${slot}`');
    expect(pageSrc).toContain('`/platform/themes/${id}/members-images/${slot}`');
    // Only inside the Save handler — a pick must not call the API.
    const saveBody = pageSrc.match(/async function handleSave\(id: string\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(saveBody).toContain('for (const slot of MEMBER_IMAGE_SLOTS)');
    expect(saveBody).toContain('members-images');
    const pickBody = pageSrc.match(/function pickMembersImage[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(pickBody).not.toContain('fetch(');
    expect(pickBody).not.toContain('apiFetch');
  });

  it('reads the six URLs off the theme payload rather than fetching them', () => {
    expect(pageSrc).toContain('members_images: MembersImages');
    expect(pageSrc).toContain('theme?.members_images?.[`${slot}_url`]');
    expect(pageSrc).not.toMatch(/apiFetch\([^)]*members-images[^)]*\)\s*;?\s*\/\/?\s*GET/);
  });

  it('never names a storage path — the client only names the slot', () => {
    expect(pageSrc).not.toContain('storage_folder_prefix');
    expect(pageSrc).not.toContain('object_key');
    expect(pageSrc).not.toContain('/Members/');
    expect(pageSrc).not.toContain('cordel/Themes');
  });

  it('labels the section and every slot in en, es and ca', () => {
    const keys = [
      'section_members_images',
      'members_images_hint',
      'members_image_none',
      'members_image_upload',
      'members_image_remove',
      'members_image_error_type',
      'members_image_error_size',
      'members_image_error_upload',
      ...SLOTS.map((slot) => `members_image_${slot}`),
    ];
    for (const code of LOCALE_CODES) {
      const ns = locales[code].themes as Record<string, string>;
      for (const key of keys) {
        expect(typeof ns?.[key], `${code}.themes.${key}`).toBe('string');
        expect(ns[key].trim().length, `${code}.themes.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
