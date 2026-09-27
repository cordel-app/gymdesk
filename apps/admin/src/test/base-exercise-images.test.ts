import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #716 — the image on a Base Exercise card (Cordel → Base Exercises).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like base-nutrition-images.test.ts (#715) and
// exercise-image-upload.test.ts (#719) — it pins the structure down by scanning
// the source: that the image and the zoom live on the *expanded* card and
// nowhere else, that the card draws the thumbnail rather than the master, that
// the required format is stated, and that the upload goes to the platform route
// rather than a gym one.
//
// #806 moved the *upload control* into `ExerciseImageField`, the one control both
// Exercise editing surfaces render, and with it out of the read-only expanded
// card and behind `⋮ → Edit`. So the assertions below split: what the card shows
// is still this page's, what an upload does is the shared control's.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
const FIELD_PATH = join(__dirname, '..', 'components', 'ExerciseImageField.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const fieldSrc = stripComments(readFileSync(FIELD_PATH, 'utf-8'));

const expandedStart = pageSrc.indexOf('renderExpanded={(row)');
const columnsStart = pageSrc.indexOf('const columns: Column<Exercise>[]');
/** The read-only body of an expanded card. */
const readOnlyStart = pageSrc.indexOf('function renderReadOnly(');

describe('Base Exercises images (#716)', () => {
  it('reads both references the API returns', () => {
    expect(pageSrc).toMatch(/image_url: string \| null;/);
    expect(pageSrc).toMatch(/image_thumbnail_url: string \| null;/);
  });

  it('shows the image and the zoom on the expanded card only (§9)', () => {
    expect(expandedStart).toBeGreaterThan(-1);
    expect(readOnlyStart).toBeGreaterThan(-1);
    expect(pageSrc.slice(readOnlyStart)).toContain('renderImageSection(exercise)');
    expect(pageSrc.slice(expandedStart)).toContain('renderReadOnly(row)');

    // The collapsed row is the `columns` array, which must mention none of it.
    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('image_url');
    expect(columnsBlock).not.toContain('image_thumbnail_url');
    expect(columnsBlock).not.toContain('View full size');
  });

  it('keeps every write out of that card — the editor owns them (#806 §11)', () => {
    const readOnlyBlock = pageSrc.slice(readOnlyStart, pageSrc.indexOf('const columns: Column<Exercise>[]'));
    for (const affordance of ['<input', '<button', 'onChange', 'onClick={() => openInlineEdit']) {
      expect(readOnlyBlock, affordance).not.toContain(affordance);
    }
    // No file picker is left on the page at all: it belongs to the shared control.
    expect(pageSrc).not.toContain('accept="image/png"');
    expect(pageSrc).not.toContain('prepareExerciseImage');
    // The editor is where the upload control is rendered, behind ⋮ → Edit.
    expect(pageSrc).toContain('<ExerciseImageField');
    expect(pageSrc).toMatch(/media=\{renderEditorMedia\(row\)\}/);
  });

  it('draws the thumbnail, never the master, for normal rendering (§4)', () => {
    expect(pageSrc).toMatch(/const thumbnail = exercise\.image_thumbnail_url \?\? exercise\.image_url;/);
    // The image block draws the thumbnail and nothing else; the other two
    // `src`s on the page are #717's video block (its poster, and the clip
    // itself once the player is asked for). The master is drawn by neither.
    const srcs = [...pageSrc.matchAll(/src=\{`?\$?\{?([^}`]+)/g)].map((m) => m[1]);
    expect(srcs).toEqual(['thumbnail', 'video', 'poster']);
    expect(srcs).not.toContain('master');
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
    // Stated by the shared control, in the translated string both screens show.
    expect(fieldSrc).toContain("t('image_requirements', { size: EXERCISE_IMAGE_MASTER_SIZE })");
    expect(fieldSrc).toContain('accept="image/png"');
  });

  it('prepares the pair in the browser, and sends nothing when it cannot (§12)', () => {
    // The 512×512 thumbnail is the browser's (#719 Q2) — one helper, in the one
    // control both screens render, so the two cannot drift.
    expect(fieldSrc).toContain("from '@/lib/exerciseImageUpload'");
    expect(fieldSrc).toContain('prepareExerciseImage(file)');
    expect(fieldSrc).toMatch(/if \(!isPreparedExerciseImage\(prepared\)\) \{[\s\S]*?return;\s*\n\s*\}/);
  });

  it('uploads and removes through the platform routes only (§15)', () => {
    // The route root is this page's to supply (#806 §6); the control takes it.
    expect(pageSrc).toContain("const API_BASE = '/platform/exercises'");
    expect(pageSrc).toMatch(/<ExerciseImageField\s*\n\s*basePath=\{API_BASE\}/);
    // And the creation card's staged upload goes to the same root.
    expect(pageSrc).toContain('`${API_BASE}/${created.id}/image`');
    expect(pageSrc).not.toContain('/storage/uploads/exercise-image');
    expect(pageSrc).not.toMatch(/`\/exercises\/\$\{/);
  });

  it("does not gate a platform upload on a gym's bucket (#806)", () => {
    // A Base Exercise's objects live in `cordel/Exercises/…`, which no gym's
    // storage settings reach.
    expect(pageSrc).toMatch(/requiresGymStorage=\{false\}/);
    expect(fieldSrc).toContain('requiresGymStorage = true');
  });

  it('surfaces an upload error on the control it belongs to, without touching the image', () => {
    expect(fieldSrc).toContain("setError(err.message ?? t('image_error_upload_failed'))");
    expect(fieldSrc).toMatch(/\{error && <p/);
  });

  it('asks before removing the image (#717 §7, generalised by #806)', () => {
    expect(fieldSrc).toContain("message={t('image_confirm_remove')}");
    expect(fieldSrc).toContain('open={confirmingRemove}');
  });

  it('edits inline rather than in a modal (#716 Q4, #806 §9)', () => {
    expect(pageSrc).toContain('<ExerciseEditor');
    expect(pageSrc).toContain('mode="edit"');
    expect(pageSrc).not.toContain('CrudModal');
    // The only dialog left on the page is the delete confirmation.
    expect(pageSrc).toContain('ConfirmDialog');
  });

  it('offers View Audit Log from the Details view (#675)', () => {
    expect(pageSrc).toMatch(/ViewAuditLogButton entityType="exercise" entityId=\{exercise\.id\} scope="platform"/);
  });
});
