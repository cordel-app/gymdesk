import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #725 — the Members App section of the Custom Themes editor.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like assigned-plan-configuration.test.ts (#635 stage 6) — this
// pins the structure down by scanning the page source, the new editor component
// and the locale files.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'themes', 'page.tsx');
const EDITOR_PATH = join(__dirname, '..', 'components', 'ThemeMembersImagesEditor.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The six slots #725 defines, with the section each one backs. */
const SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'membership', 'background'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const editorSrc = stripComments(readFileSync(EDITOR_PATH, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Custom Themes: Members App images (#725)', () => {
  it('declares exactly the six slots the ticket defines', () => {
    const declared = editorSrc.match(/export const MEMBER_IMAGE_SLOTS = \[([^\]]+)\]/)?.[1] ?? '';
    const parsed = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(parsed).toEqual([...SLOTS]);
  });

  it('adds a Members App section to the existing editor, not a new screen', () => {
    // One more collapsible section alongside Branding / Colors / Typography.
    expect(pageSrc).toMatch(/type SectionKey = [^;]*'members'/);
    expect(pageSrc).toContain("renderSection(t('section_members_images'), 'members'");
    expect(pageSrc).toContain('<ThemeMembersImagesEditor');
    // No modal is introduced for it.
    expect(pageSrc).not.toMatch(/MembersImages[A-Za-z]*Modal/);
  });

  it('renders each slot with a preview and an Upload Image control', () => {
    expect(editorSrc).toContain("t(`members_image_${slot}`)");
    expect(editorSrc).toContain("t('members_image_upload')");
    expect(editorSrc).toContain("t('members_image_remove')");
    expect(editorSrc).toContain('fileInputRef.current?.click()');
    expect(editorSrc).toMatch(/type="file"/);
  });

  it('previews the image the way the Members App renders it: cover, centred', () => {
    expect(editorSrc).toContain('center / cover no-repeat');
  });

  it('offers Remove only for a slot that has an image', () => {
    expect(editorSrc).toMatch(/\{preview && \(\s*<button type="button" onClick=\{\(\) => onRemove\(slot\)\}/);
  });

  it('accepts only the types the server accepts, and the server\'s size cap', () => {
    expect(editorSrc).toContain("export const MEMBER_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'");
    expect(editorSrc).toContain('export const MEMBER_IMAGE_MAX_BYTES = 4 * 1024 * 1024');
    expect(pageSrc).toContain("setEditError(t('members_image_error_type'))");
    expect(pageSrc).toContain("setEditError(t('members_image_error_size'))");
  });

  it('stages picks and removals until Save, and discards them on Cancel', () => {
    // Nothing leaves the browser when a file is picked — the draft is local…
    expect(editorSrc).not.toContain('fetch(');
    expect(editorSrc).not.toContain('apiFetch');
    // …and the row's Cancel is the existing one, which drops the whole draft.
    expect(pageSrc).toMatch(/membersImageFiles\[slot\] !== null \|\| membersImageRemovals\[slot\]/);
    expect(pageSrc).toContain('setMembersImageFiles(bySlot(null))');
    expect(pageSrc).toContain('setMembersImageRemovals(bySlot(false))');
  });

  it('uploads and clears through the theme\'s own routes, one call per touched slot', () => {
    expect(pageSrc).toContain('`/api/proxy/system/themes/${theme.id}/members-images/${slot}`');
    expect(pageSrc).toContain('`/system/themes/${theme.id}/members-images/${slot}`');
    // Only inside the Save handler — a pick must not call the API.
    const saveBody = pageSrc.match(/async function handleSaveAll[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(saveBody).toContain('members-images');
    expect(saveBody).toContain('for (const slot of MEMBER_IMAGE_SLOTS)');
  });

  it('reads the six URLs off the theme payload rather than fetching them', () => {
    expect(pageSrc).toContain('members_images: MembersImages');
    expect(pageSrc).toContain('theme.members_images?.[`${slot}_url`]');
    // No per-slot GET anywhere on the page.
    expect(pageSrc).not.toMatch(/apiFetch\([^)]*members-images[^)]*\)\s*;?\s*\/\/?\s*GET/);
  });

  it('never lets a gym name a storage path — the client only names the slot', () => {
    for (const src of [pageSrc, editorSrc]) {
      expect(src).not.toContain('storage_folder_prefix');
      expect(src).not.toContain('object_key');
      expect(src).not.toContain('/Members/');
    }
  });

  it('leaves a Base Theme read-only', () => {
    expect(pageSrc).toMatch(/<ThemeMembersImagesEditor[\s\S]*?readOnly=\{isBase\}/);
    expect(editorSrc).toMatch(/\{!readOnly && \(/);
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
      const ns = locales[code].gym_themes as Record<string, string>;
      for (const key of keys) {
        expect(typeof ns?.[key], `${code}.gym_themes.${key}`).toBe('string');
        expect(ns[key].trim().length, `${code}.gym_themes.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
