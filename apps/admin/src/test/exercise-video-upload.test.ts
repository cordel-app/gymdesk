import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_VIDEO_DEFAULT_MAX_MB,
  EXERCISE_VIDEO_POSTER_SIZE,
  exerciseVideoMaxMb,
  isPreparedExerciseVideo,
  posterTimestamp,
} from '../lib/exerciseVideoUpload';

// #719 part 2 — the Video control on a Gym Exercise: an MP4 uploaded together
// with the 512 × 512 poster the *browser* captures from it (the answer on #719
// Q2), and the ownership-aware replace/remove behind it.
//
// The pure helpers run here directly. Everything that needs a DOM (`<video>`,
// `<canvas>`) and the rendering itself have no component-test infra in this repo
// (docs/architecture.md's TL;DR), so — like exercise-image-upload.test.ts
// (part 1) — those are pinned down by scanning the source.

const SRC = join(__dirname, '..');
const LIB = join(SRC, 'lib', 'exerciseVideoUpload.ts');
const COMPONENT = join(SRC, 'components', 'ExerciseVideoField.tsx');
const PAGE = join(SRC, 'app', '[locale]', 'exercises', 'page.tsx');
const DETAIL_MODAL = join(SRC, 'app', '[locale]', 'exercises', 'ExerciseDetailModal.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const libSrc = read(LIB);
const componentSrc = read(COMPONENT);
const pageSrc = read(PAGE);
const detailSrc = read(DETAIL_MODAL);

const originalMaxMb = process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB;

afterEach(() => {
  if (originalMaxMb === undefined) delete process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB;
  else process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB = originalMaxMb;
});

describe('exerciseVideoUpload — limits', () => {
  it('captures the poster at the size the server stores', () => {
    expect(EXERCISE_VIDEO_POSTER_SIZE).toBe(512);
  });

  it('defaults to the API’s own ceiling, and follows the configured one', () => {
    delete process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB;
    expect(exerciseVideoMaxMb()).toBe(EXERCISE_VIDEO_DEFAULT_MAX_MB);
    process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB = '20';
    expect(exerciseVideoMaxMb()).toBe(20);
    process.env.NEXT_PUBLIC_EXERCISE_VIDEO_MAX_MB = 'plenty';
    expect(exerciseVideoMaxMb()).toBe(EXERCISE_VIDEO_DEFAULT_MAX_MB);
  });
});

describe('posterTimestamp', () => {
  it('skips the often-black first frame of a clip', () => {
    expect(posterTimestamp(30)).toBe(1);
    expect(posterTimestamp(8)).toBe(1);
  });

  it('takes the midpoint of a very short clip', () => {
    expect(posterTimestamp(0.8)).toBeCloseTo(0.4);
  });

  it('falls back to frame zero when the duration is unknown', () => {
    expect(posterTimestamp(NaN)).toBe(0);
    expect(posterTimestamp(Infinity)).toBe(0);
    expect(posterTimestamp(0)).toBe(0);
  });
});

describe('isPreparedExerciseVideo', () => {
  it('separates the pair from a problem', () => {
    expect(isPreparedExerciseVideo({ video: 'a', poster: 'b' })).toBe(true);
    expect(isPreparedExerciseVideo('poster_failed')).toBe(false);
    expect(isPreparedExerciseVideo('not_an_mp4')).toBe(false);
  });
});

describe('prepareExerciseVideo (source)', () => {
  it('checks the format and the size before decoding anything', () => {
    expect(libSrc).toMatch(/return 'not_an_mp4'/);
    expect(libSrc).toMatch(/exerciseVideoMaxMb\(\)[\s\S]*?return 'too_large'/);
  });

  it('fails the whole upload when the poster cannot be captured (#719 Q2)', () => {
    expect(libSrc).toMatch(/const poster = await captureVideoPoster\(file\);/);
    const returnsPair = libSrc.indexOf('return { video, poster: posterBase64 }');
    expect(returnsPair).toBeGreaterThan(libSrc.indexOf("return 'poster_failed'"));
  });

  it('cover-crops the frame rather than distorting it', () => {
    expect(libSrc).toContain('Math.min(video.videoWidth, video.videoHeight)');
    expect(libSrc).toContain('ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size)');
    expect(libSrc).toContain("canvas.toBlob(resolve, 'image/png')");
  });

  it('never leaves the decode hanging, and revokes the object URL it minted', () => {
    expect(libSrc).toContain('DECODE_TIMEOUT_MS');
    expect(libSrc).toContain('URL.revokeObjectURL(url)');
  });

  it('re-uses the image module’s encoder rather than a second copy', () => {
    expect(libSrc).toContain("import { blobToBase64 } from './exerciseImageUpload'");
  });
});

describe('ExerciseVideoField', () => {
  it('uploads the pair to the exercise’s own endpoint', () => {
    expect(componentSrc).toMatch(/\/exercises\/\$\{exerciseId\}\/video`, \{\s*\n\s*method: 'POST'/);
    expect(componentSrc).toMatch(/\/exercises\/\$\{exerciseId\}\/video`, \{ method: 'DELETE' \}/);
  });

  it('sends nothing when preparation failed, so existing media survives (§9)', () => {
    const guard = componentSrc.indexOf('if (!isPreparedExerciseVideo(prepared))');
    const post = componentSrc.indexOf("method: 'POST'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
    expect(componentSrc).toMatch(/if \(!isPreparedExerciseVideo\(prepared\)\) \{[\s\S]*?return;/);
  });

  it('draws the poster and never mounts a <video> (§17)', () => {
    expect(componentSrc).toContain('const preview = stagedPoster ?? posterUrl ?? null');
    expect(componentSrc).toContain('loading="lazy"');
    expect(componentSrc).not.toContain('<video');
  });

  it('hands the frame only a reference the scheme guard passed', () => {
    expect(componentSrc).toContain('const drawable = preview != null && SAFE_IMAGE_SRC.test(preview)');
    expect(componentSrc).toMatch(/\{drawable \? \([\s\S]*?<img src=\{preview!\}/);
  });

  it('previews a staged pick as its own captured poster, not the picked file', () => {
    expect(componentSrc).toContain('setStagedPoster(`data:image/png;base64,${prepared.poster}`)');
    expect(componentSrc).not.toContain('createObjectURL');
  });

  it('offers Remove for a video that has no stored poster', () => {
    expect(componentSrc).toContain('const hasVideo = staged || videoUrl != null || posterUrl != null');
  });

  it('resolves no media of its own — no Base Exercise fallback (§13)', () => {
    expect(componentSrc).not.toMatch(/cordel|base_exercise|cloned_from_id/);
  });

  it('states the required format to the user (§21)', () => {
    expect(componentSrc).toContain("t('video_requirements'");
    expect(componentSrc).toContain('accept="video/mp4"');
  });

  it('has an uploading, a removing and an error state (§21)', () => {
    for (const key of ['video_uploading', 'video_removing', 'video_replace', 'video_remove', 'video_none']) {
      expect(componentSrc).toContain(`t('${key}')`);
    }
    expect(componentSrc).toContain('setError');
  });
});

describe('Exercises page', () => {
  it('manages the video through the dedicated control', () => {
    expect(pageSrc).toContain('<ExerciseVideoField');
    expect(pageSrc).toContain('posterUrl={ex.video_thumbnail_url}');
  });

  it('stages the video while an exercise is being created and uploads it after', () => {
    expect(pageSrc).toContain('onStaged={setStagedVideo}');
    expect(pageSrc).toMatch(/if \(stagedVideo\) \{[\s\S]*?\/exercises\/\$\{created\.id\}\/video/);
  });

  it('reads both references from the API and draws the poster, never the MP4', () => {
    expect(pageSrc).toContain('video_url: string | null; video_thumbnail_url: string | null;');
    expect(pageSrc).toContain('src={ex.video_thumbnail_url}');
    expect(detailSrc).toContain('src={detail.video_thumbnail_url}');
  });
});

describe('locales', () => {
  const keys = [
    'label_video', 'video_none', 'video_no_poster', 'video_requirements', 'video_upload',
    'video_replace', 'video_remove', 'video_uploading', 'video_removing',
    'video_error_not_an_mp4', 'video_error_too_large', 'video_error_unreadable',
    'video_error_poster_failed', 'video_error_upload_failed', 'video_error_remove_failed',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code} carries every exercise video label`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of keys) {
        expect(messages.exercises[key], `${code}.exercises.${key}`).toBeTruthy();
      }
    });
  }
});
