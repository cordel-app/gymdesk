import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #717 — the video on a Base Exercise card (Cordel → Base Exercises).
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like base-exercise-images.test.ts (#716) and
// exercise-video-upload.test.ts (#719 part 2) — it pins the structure down by
// scanning the page source: that the player, `Upload Video` and `Remove` live
// on the *expanded* card and nowhere else, that the card draws the **poster**
// rather than the clip, that no `<video>` is mounted until it is asked for and
// nothing autoplays, that the format and the size cap are stated, and that the
// upload goes to the platform route rather than a gym one.

const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
const GYM_PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'exercises', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const gymPageSrc = stripComments(readFileSync(GYM_PAGE_PATH, 'utf-8'));

const expandedStart = pageSrc.indexOf('renderExpanded={(row)');
const columnsStart = pageSrc.indexOf('const columns: Column<Exercise>[]');

describe('Base Exercises videos (#717)', () => {
  it('reads both references the API returns (Q5 — no video_object_key)', () => {
    expect(pageSrc).toMatch(/video_url: string \| null;/);
    expect(pageSrc).toMatch(/video_thumbnail_url: string \| null;/);
    expect(pageSrc).not.toContain('video_object_key');
  });

  it('shows the video and its buttons on the expanded card only (§4)', () => {
    expect(expandedStart).toBeGreaterThan(-1);
    expect(pageSrc.slice(expandedStart)).toContain('renderVideoSection(row)');

    const columnsBlock = pageSrc.slice(columnsStart, expandedStart);
    expect(columnsBlock).not.toContain('video_url');
    expect(columnsBlock).not.toContain('video_thumbnail_url');
    expect(columnsBlock).not.toContain('Upload Video');
  });

  it('keeps every existing section of the card visible (Q6)', () => {
    const expandedBlock = pageSrc.slice(expandedStart);
    // The image block, the detail rows and the audit deep link are all still
    // there — this ticket adds a video, it hides nothing.
    expect(expandedBlock).toContain('renderImageSection(row)');
    expect(expandedBlock).toContain('label="Description"');
    expect(expandedBlock).toContain('label="Status"');
    expect(expandedBlock).toContain('label="Created At"');
    expect(expandedBlock).toContain('label="Modified At"');
    expect(expandedBlock).toContain('ViewAuditLogButton');
    // Both kinds of media sit under one heading, spelled "Media" (Q6).
    expect(expandedBlock).toMatch(/sectionLabelStyle\}>Media</);
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
    expect(pageSrc).toMatch(/Upload an MP4 video \(H\.264\), up to \{exerciseVideoMaxMb\(\)\} MB/);
    expect(pageSrc).toContain('accept="video/mp4"');
  });

  it('prepares the pair in the browser, and sends nothing when it cannot (§5, §6)', () => {
    // The 512×512 poster is the browser's (#719 Q2, inherited) — the same
    // helper the gym-side control uses, so one implementation captures it.
    expect(pageSrc).toContain("from '@/lib/exerciseVideoUpload'");
    expect(pageSrc).toMatch(/const prepared = await prepareExerciseVideo\(file\);/);
    expect(pageSrc).toMatch(/if \(!isPreparedExerciseVideo\(prepared\)\) \{[\s\S]*?setVideoError/);
    expect(pageSrc).toContain('VIDEO_PROBLEM_MESSAGES');
    expect(pageSrc).toContain('poster_failed');
  });

  it('uploads and removes through the platform routes, never a gym one', () => {
    expect(pageSrc).toMatch(/`\/platform\/exercises\/\$\{exercise\.id\}\/video`,\s*\{\s*method: 'POST'/);
    expect(pageSrc).toMatch(/`\/platform\/exercises\/\$\{exercise\.id\}\/video`, \{ method: 'DELETE' \}/);
    expect(pageSrc).not.toMatch(/`\/exercises\/\$\{exercise\.id\}\/video`/);
  });

  it('confirms before removing the video (§7)', () => {
    expect(pageSrc).toMatch(/removingVideo/);
    expect(pageSrc).toMatch(/open=\{removingVideo !== null\}/);
    expect(pageSrc).toMatch(/Remove the video from/);
  });
});

describe('Gym Exercises card — Q6 follow-through', () => {
  it('no longer offers video_url as a directly editable field', () => {
    expect(gymPageSrc).not.toMatch(/setEditForm\(\{ \.\.\.editForm, video_url:/);
    // The edit PUT stops submitting it too, so a video uploaded while the
    // editor was open cannot be repointed by saving the form.
    expect(gymPageSrc).not.toMatch(/video_url: editForm\.video_url/);
  });

  it('still manages the video through the media control, and still shows the link it carries', () => {
    expect(gymPageSrc).toContain('ExerciseVideoField');
    expect(gymPageSrc).toMatch(/ex\.video_url && <p/);
  });
});
