import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #716 — the image on a Base Exercise card (Cordel → Base Exercises).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like base-nutrition-images.test.ts (#715) and
// exercise-image-upload.test.ts (#719) — it pins the structure down by scanning
// the page source: that the image, `Upload Image` and the zoom live on the
// *expanded* card and nowhere else, that the card draws the thumbnail rather
// than the master, that the required format is stated, and that the upload goes
// to the platform route rather than a gym one.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

const expandedStart = pageSrc.indexOf('renderExpanded={(row)');
const columnsStart = pageSrc.indexOf('const columns: Column<Exercise>[]');

describe('Base Exercises images (#716)', () => {
  it('reads both references the API returns', () => {
    expect(pageSrc).toMatch(/image_url: string \| null;/);
    expect(pageSrc).toMatch(/image_thumbnail_url: string \| null;/);
  });

  it('shows the image, its buttons and the zoom on the expanded card only (§9)', () => {
    expect(expandedStart).toBeGreaterThan(-1);
    const expandedBlock = pageSrc.slice(expandedStart);
    expect(expandedBlock).toContain('renderImageSection(row)');

    // The collapsed row is the `columns` array, which must mention none of it.
    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('image_url');
    expect(columnsBlock).not.toContain('image_thumbnail_url');
    expect(columnsBlock).not.toContain('Upload Image');
    expect(columnsBlock).not.toContain('View full size');
  });

  it('draws the thumbnail, never the master, for normal rendering (§4)', () => {
    expect(pageSrc).toMatch(/const thumbnail = exercise\.image_thumbnail_url \?\? exercise\.image_url;/);
    // The only `<img src>` on the page is the thumbnail's.
    const imgSources = [...pageSrc.matchAll(/src=\{`?\$?\{?([^}`]+)/g)].map((m) => m[1]);
    expect(imgSources).toEqual(['thumbnail']);
    expect(pageSrc).toContain('loading="lazy"');
  });

  it('loads the 2048×2048 master only when the full size is opened (§10)', () => {
    expect(pageSrc).toMatch(/href=\{`\$\{master\}\?v=\$\{version\}`\}/);
    expect(pageSrc).toContain('target="_blank"');
    expect(pageSrc).toContain('View full size');
  });

  it('only hands a drawable reference to the DOM', () => {
    expect(pageSrc).toMatch(/SAFE_IMAGE_SRC\.test\(thumbnail\)/);
    expect(pageSrc).toMatch(/SAFE_IMAGE_SRC\.test\(master\)/);
  });

  it('keeps the image square and preserves its transparency', () => {
    expect(pageSrc).toContain("objectFit: 'contain'");
    expect(pageSrc).toMatch(/imageFrameStyle[\s\S]*?width: 160,[\s\S]*?height: 160,/);
    // The checkerboard is what makes a transparent background read as
    // transparent rather than as white.
    expect(pageSrc).toMatch(/backgroundImage:[\s\S]*?linear-gradient/);
  });

  it('tells the administrator the required format (§11)', () => {
    expect(pageSrc).toMatch(
      /Upload a \{EXERCISE_IMAGE_MASTER_SIZE\}×\{EXERCISE_IMAGE_MASTER_SIZE\} PNG image with a transparent/,
    );
    expect(pageSrc).toContain('accept="image/png"');
  });

  it('prepares the pair in the browser, and sends nothing when it cannot (§12)', () => {
    // The 512×512 thumbnail is the browser's (#719 Q2) — the same helper the
    // gym-side control uses, so the two cannot drift.
    expect(pageSrc).toContain("from '@/lib/exerciseImageUpload'");
    expect(pageSrc).toContain('prepareExerciseImage(file)');
    expect(pageSrc).toMatch(/if \(!isPreparedExerciseImage\(prepared\)\) \{[\s\S]*?return;\s*\n\s*\}/);
    expect(pageSrc).toContain('thumbnail_failed');
  });

  it('uploads and removes through the platform routes only (§15)', () => {
    expect(pageSrc).toContain('`/platform/exercises/${exercise.id}/image`');
    expect(pageSrc).toMatch(/method: 'POST',\s*\n\s*body: JSON\.stringify\(prepared\)/);
    expect(pageSrc).toMatch(/\{ method: 'DELETE' \}/);
    expect(pageSrc).not.toContain('/storage/uploads/exercise-image');
    expect(pageSrc).not.toMatch(/`\/exercises\/\$\{/);
  });

  it('surfaces an upload error on the card it belongs to, without touching the image', () => {
    expect(pageSrc).toMatch(/imageError\?\.id === exercise\.id/);
    expect(pageSrc).toContain("message: err.message ?? 'Image upload failed'");
  });

  it('edits inline rather than in a modal (#716 Q4)', () => {
    expect(pageSrc).toContain('renderInlineForm');
    expect(pageSrc).not.toContain('CrudModal');
    // The only dialog left is the delete confirmation.
    expect(pageSrc).toContain('ConfirmDialog');
  });

  it('offers View Audit Log from the Details view (#675)', () => {
    expect(pageSrc).toMatch(/ViewAuditLogButton entityType="exercise" entityId=\{row\.id\} scope="platform"/);
  });
});
