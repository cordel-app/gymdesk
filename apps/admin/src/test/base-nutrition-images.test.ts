import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #715 — the image on a Base Nutrition Library food card (Cordel → Base
// Nutrition Library).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like base-theme-members-images.test.ts (#732) — it pins the
// structure down by scanning the page source: that the required format is stated
// to the administrator, that the client checks what a browser can check, and that
// the upload goes to the platform route rather than a gym one.
//
// #799 moved *where* the button lives: the expanded card became strictly
// read-only, so uploading is reached through `⋮ → Edit` and the expanded card
// shows the image alone. The collapsed row still mentions neither. The rest of
// #715 is unchanged, and `nutrition-library-read-only-expansion.test.ts` is what
// pins the new split.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PROFILE_PATH = join(__dirname, '..', 'components', 'nutritionLibrary', 'nutritionItemProfile.ts');

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const profileSrc = stripComments(readFileSync(PROFILE_PATH, 'utf-8'));

describe('Base Nutrition Library images (#715)', () => {
  it('reads the image reference the API returns', () => {
    // Since #799 the row's shape is declared once, in the shared profile module,
    // and both libraries import it rather than restating the columns.
    expect(pageSrc).toContain("from '@/components/nutritionLibrary/nutritionItemProfile'");
    expect(profileSrc).toMatch(/image_url: string \| null;/);
    expect(pageSrc).toContain('item.image_url');
  });

  it('keeps the Upload Image button in the Edit form, and off the collapsed row', () => {
    // The form is `renderInlineForm`, which ends where `const columns` begins.
    const formStart = pageSrc.indexOf('function renderInlineForm(');
    const columnsStart = pageSrc.indexOf('const columns: Column<LibraryItem>[]');
    const expandedStart = pageSrc.indexOf('renderExpanded={(item)');
    expect(formStart).toBeGreaterThan(-1);
    expect(columnsStart).toBeGreaterThan(formStart);
    expect(expandedStart).toBeGreaterThan(columnsStart);

    const formBlock = pageSrc.slice(formStart, columnsStart);
    expect(formBlock).toContain("t('upload_image')");
    expect(formBlock).toContain('openImagePicker(item)');
    expect(formBlock).toContain('item.image_url');

    // The collapsed row is the `columns` array, which must mention neither.
    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('image_url');
    expect(columnsBlock).not.toContain('upload_image');
  });

  it('keeps the image square and preserves its transparency', () => {
    expect(pageSrc).toContain("objectFit: 'contain'");
    expect(pageSrc).toMatch(/imageFrameStyle: React\.CSSProperties = \{[\s\S]*?width: 160,[\s\S]*?height: 160,/);
    // The checkerboard is what makes a transparent background read as
    // transparent rather than as white.
    expect(pageSrc).toMatch(/backgroundImage:[\s\S]*?linear-gradient/);
  });

  it('shows the preview first with Upload Image directly below it', () => {
    const formStart = pageSrc.indexOf('function renderInlineForm(');
    const block = pageSrc.slice(formStart);
    const frame = block.indexOf('<div style={imageFrameStyle}>');
    const button = block.indexOf("openImagePicker(item)");
    expect(frame).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(frame);
    // A column, not a row: the button sits under the preview rather than beside it.
    expect(block.slice(0, frame).split('\n').slice(-3).join('\n')).toContain("flexDirection: 'column'");
    expect(pageSrc).toContain('primaryBtnSmall()');
  });

  it('tells the administrator what is accepted and that the server converts it', () => {
    expect(pageSrc).toContain("t('image_hint')");
    expect(pageSrc).toContain('const IMAGE_TYPES');
  });

  it('checks only what a browser can see, and resizes or encodes nothing (#1562)', () => {
    expect(pageSrc).toContain('IMAGE_TYPES.includes(file.type)');
    expect(pageSrc).toContain('file.size > IMAGE_MAX_BYTES');
    expect(pageSrc).not.toContain('readImageDimensions');
    expect(pageSrc).not.toContain('canvas');
    // A failed client check sets the error and returns — nothing is sent.
    expect(pageSrc).toMatch(/setImageError\(\{ id: item\.id, message: problem \}\);\s*\n\s*return;/);
  });

  it('posts the picked file as it is to the platform route', () => {
    expect(pageSrc).toContain('/api/proxy/platform/nutrition-library/${item.id}/image');
    expect(pageSrc).toContain("'Content-Type': file.type");
    expect(pageSrc).not.toContain('/storage/uploads/nutrition-image');
  });

  it('surfaces an upload error on the card it belongs to', () => {
    expect(pageSrc).toMatch(/imageError\?\.id === item\.id/);
    expect(pageSrc).toContain("setImageError({ id: item.id, message: err.message ?? t('image_upload_failed') })");
  });
});
