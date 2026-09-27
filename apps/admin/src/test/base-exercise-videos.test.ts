import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #717 — the video on a Base Exercise card (Cordel → Base Exercises).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like base-exercise-images.test.ts (#716) and
// exercise-video-upload.test.ts (#719 part 2) — it pins the structure down by
// scanning the source: that the player lives on the *expanded* card and nowhere
// else, that the card draws the **poster** rather than the clip, that no
// `<video>` is mounted until it is asked for and nothing autoplays, that the
// format and the size cap are stated, and that the upload goes to the platform
// route rather than a gym one.
//
// #806 moved `Upload Video` / `Remove` into `ExerciseVideoField`, the one control
// both Exercise editing surfaces render, and with it out of the read-only
// expanded card and behind `⋮ → Edit`. Playing stayed: it is a read.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
const GYM_PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'exercises', 'page.tsx');
const FIELD_PATH = join(__dirname, '..', 'components', 'ExerciseVideoField.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const gymPageSrc = stripComments(readFileSync(GYM_PAGE_PATH, 'utf-8'));
const fieldSrc = stripComments(readFileSync(FIELD_PATH, 'utf-8'));

const expandedStart = pageSrc.indexOf('renderExpanded={(row)');
const columnsStart = pageSrc.indexOf('const columns: Column<Exercise>[]');
const readOnlyStart = pageSrc.indexOf('function renderReadOnly(');

describe('Base Exercises videos (#717)', () => {
  it('reads both references the API returns (Q5 — no video_object_key)', () => {
    expect(pageSrc).toMatch(/video_url: string \| null;/);
    expect(pageSrc).toMatch(/video_thumbnail_url: string \| null;/);
    expect(pageSrc).not.toContain('video_object_key');
  });

  it('shows the video on the expanded card only (§4)', () => {
    expect(expandedStart).toBeGreaterThan(-1);
    expect(readOnlyStart).toBeGreaterThan(-1);
    expect(pageSrc.slice(readOnlyStart)).toContain('renderVideoSection(exercise)');
    expect(pageSrc.slice(expandedStart)).toContain('renderReadOnly(row)');

    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('video_url');
    expect(columnsBlock).not.toContain('video_thumbnail_url');
    expect(columnsBlock).not.toContain('Upload Video');
  });

  it('keeps every existing section of the card visible (Q6)', () => {
    const readOnlyBlock = pageSrc.slice(readOnlyStart, columnsStart);
    // The image block, the detail rows and the audit deep link are all still
    // there — this ticket adds a video, it hides nothing, and #806 only moved the
    // upload controls out. The labels are the shared `exercises` namespace's now,
    // because the editor beside them is translated (#806 AC2).
    expect(readOnlyBlock).toContain('renderImageSection(exercise)');
    expect(readOnlyBlock).toContain("label={t('label_description')}");
    expect(readOnlyBlock).toContain("label={t('label_status')}");
    expect(readOnlyBlock).toContain("label={t('col_created_at')}");
    expect(readOnlyBlock).toContain("label={t('detail_modified_at')}");
    expect(readOnlyBlock).toContain('ViewAuditLogButton');
    // Both kinds of media sit under one heading, spelled "Media" (Q6).
    expect(readOnlyBlock).toMatch(/sectionLabelStyle\}>\{t\('section_media'\)\}</);
  });

  it('draws the stored poster, never the clip, for normal rendering (§9)', () => {
    expect(pageSrc).toMatch(/const poster = exercise\.video_thumbnail_url;/);
    // The poster is an <img>; the only `<video>` in the file is the player.
    expect((pageSrc.match(/<video\b/g) ?? [])).toHaveLength(1);
  });

  it('mounts no <video> until the player is asked for, and never autoplays (§8, §9)', () => {
    expect(pageSrc).toMatch(/const playing = playingId === exercise\.id && playable;/);
    expect(pageSrc).toMatch(/\{playing \?/);
    expect(pageSrc).toContain('preload="metadata"');
    expect(pageSrc).toContain('controls');
    expect(pageSrc).not.toContain('autoPlay');
    expect(pageSrc).not.toContain('autoplay');
  });

  it('only hands a drawable reference to the DOM, and plays only an mp4 object', () => {
    expect(pageSrc).toMatch(/SAFE_IMAGE_SRC\.test\(poster\)/);
    expect(pageSrc).toMatch(/PLAYABLE_VIDEO_SRC\.test\(video\)/);
    // A YouTube link is a link, not something to hand to a <video>.
    expect(pageSrc).toMatch(/const PLAYABLE_VIDEO_SRC = \/\^https\?/);
  });

  it('tells the administrator the format and the configured cap (§4)', () => {
    // Stated by the shared control, in the translated string both screens show.
    expect(fieldSrc).toContain("t('video_requirements', { size: exerciseVideoMaxMb() })");
    expect(fieldSrc).toContain('accept="video/mp4"');
  });

  it('prepares the pair in the browser, and sends nothing when it cannot (§5, §6)', () => {
    // The 512×512 poster is the browser's (#719 Q2, inherited) — one helper, in
    // the one control both screens render.
    expect(fieldSrc).toContain("from '@/lib/exerciseVideoUpload'");
    expect(fieldSrc).toMatch(/const prepared = await prepareExerciseVideo\(file\);/);
    expect(fieldSrc).toMatch(/if \(!isPreparedExerciseVideo\(prepared\)\) \{[\s\S]*?return;\s*\n\s*\}/);
    expect(fieldSrc).toContain("t(`video_error_${problem}`");
    expect(pageSrc).not.toContain('prepareExerciseVideo');
  });

  it('uploads and removes through the platform routes, never a gym one', () => {
    expect(pageSrc).toContain("const API_BASE = '/platform/exercises'");
    expect(pageSrc).toMatch(/<ExerciseVideoField\s*\n\s*basePath=\{API_BASE\}/);
    expect(pageSrc).toContain('`${API_BASE}/${created.id}/video`');
    expect(pageSrc).not.toMatch(/`\/exercises\/\$\{/);
  });

  it('confirms before removing the video (§7) — now for both contexts (#806)', () => {
    expect(fieldSrc).toContain("message={t('video_confirm_remove')}");
    expect(fieldSrc).toContain('open={confirmingRemove}');
    // The first click opens the dialog; only its confirm calls the DELETE.
    expect(fieldSrc).toMatch(/onClick=\{\(\) => \(exerciseId == null \? handleRemove\(\) : setConfirmingRemove\(true\)\)\}/);
    expect(fieldSrc).toMatch(/onConfirm=\{\(\) => \{ setConfirmingRemove\(false\); handleRemove\(\); \}\}/);
  });
});

describe('Gym Exercises card — Q6 follow-through', () => {
  it('no longer offers video_url as a directly editable field', () => {
    // #806: the field is offered in `create` mode only, which is the one branch
    // the shared editor takes on its mode.
    const editorSrc = stripComments(readFileSync(
      join(__dirname, '..', 'components', 'exercises', 'ExerciseEditor.tsx'), 'utf-8'));
    expect(editorSrc).toContain("const showVideoUrl = mode === 'create';");
    expect(editorSrc).toMatch(/\{showVideoUrl && \([\s\S]*?video_url/);
    expect(gymPageSrc).toContain('mode="edit"');
    // The edit PUT stops submitting it too, so a video uploaded while the
    // editor was open cannot be repointed by saving the form.
    expect(gymPageSrc).not.toMatch(/video_url: editState\.form\.video_url/);
  });

  it('still manages the video through the media control, and still shows the link it carries', () => {
    expect(gymPageSrc).toContain('ExerciseVideoField');
    expect(gymPageSrc).toMatch(/ex\.video_url && <p/);
  });
});
