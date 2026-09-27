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
    expect(formBlock).toContain('Upload Image');
    expect(formBlock).toContain('openImagePicker(item)');
    expect(formBlock).toContain('item.image_url');

    // The collapsed row is the `columns` array, which must mention neither.
    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('image_url');
    expect(columnsBlock).not.toContain('Upload Image');
  });

  it('keeps the image square and preserves its transparency', () => {
    expect(pageSrc).toContain("objectFit: 'contain'");
    expect(pageSrc).toMatch(/imageFrameStyle: React\.CSSProperties = \{[\s\S]*?width: 160,[\s\S]*?height: 160,/);
    // The checkerboard is what makes a transparent background read as
    // transparent rather than as white.
    expect(pageSrc).toMatch(/backgroundImage:[\s\S]*?linear-gradient/);
  });

  it('tells the administrator the required format', () => {
    expect(pageSrc).toMatch(/Upload a \{IMAGE_SIZE\}×\{IMAGE_SIZE\} PNG image with a transparent background\./);
    expect(pageSrc).toContain('const IMAGE_SIZE = 512;');
    expect(pageSrc).toContain('accept="image/png"');
  });

  it('validates the obvious constraints before uploading, without replacing anything', () => {
    expect(pageSrc).toContain("file.type !== 'image/png'");
    expect(pageSrc).toMatch(/dimensions\.width !== IMAGE_SIZE \|\| dimensions\.height !== IMAGE_SIZE/);
    expect(pageSrc).toContain('readImageDimensions');
    // A failed client check sets the error and returns — nothing is sent.
    expect(pageSrc).toMatch(/setImageError\(\{ id: item\.id, message: problem \}\);\s*\n\s*return;/);
  });

  it('posts raw PNG bytes to the platform route', () => {
    expect(pageSrc).toContain('/api/proxy/platform/nutrition-library/${item.id}/image');
    expect(pageSrc).toContain("'Content-Type': 'image/png'");
    expect(pageSrc).not.toContain('/storage/uploads/nutrition-image');
  });

  it('surfaces an upload error on the card it belongs to', () => {
    expect(pageSrc).toMatch(/imageError\?\.id === item\.id/);
    expect(pageSrc).toContain("setImageError({ id: item.id, message: err.message ?? 'Image upload failed' })");
  });
});
