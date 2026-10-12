import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_GENDERS,
  EXERCISE_IMAGE_INPUT_TYPES,
  GENDER_MEDIA_KEYS,
  VIDEO_FRAME_MAX_SIDE,
  exerciseGenderImageMaxMb,
  genderMediaKey,
  genderMediaMaster,
  genderMediaPath,
  genderMediaThumbnail,
  isPreparedGenderMedia,
  prepareGenderImage,
  prepareGenderVideo,
  uploadStagedGenderMedia,
  type StagedGenderMedia,
} from '../lib/exerciseGenderMedia';

// #1420 stage 3 — the four independent media controls of an exercise. The pure
// module is exercised directly; the DOM-bound parts (video frame capture, the
// controls themselves) have no component-test infra in this repo, so they are
// pinned by scanning the source like the rest of the exercise suite.

const SRC = join(__dirname, '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...parts: string[]) => strip(readFileSync(join(SRC, ...parts), 'utf-8'));

const libSrc = read('lib', 'exerciseGenderMedia.ts');
const fieldSrc = read('components', 'exercises', 'ExerciseGenderMediaField.tsx');
const sectionSrc = read('components', 'exercises', 'ExerciseGenderMedia.tsx');
const previewSrc = read('components', 'exercises', 'ExerciseMediaPreview.tsx');

const file = (bytes: BlobPart, name: string, type: string) => new File([bytes], name, { type });

describe('keys and routes', () => {
  it('declares exactly four independent controls', () => {
    expect(GENDER_MEDIA_KEYS).toEqual(['image_male', 'image_female', 'video_male', 'video_female']);
    expect(EXERCISE_GENDERS).toEqual(['male', 'female']);
    expect(genderMediaKey('video', 'female')).toBe('video_female');
  });

  it('posts to <basePath>/<id>/<kind>/<gender>', () => {
    expect(genderMediaPath('/exercises', 7, 'image', 'male')).toBe('/exercises/7/image/male');
    expect(genderMediaPath('/platform/exercises', 7, 'video', 'female')).toBe('/platform/exercises/7/video/female');
  });

  it('reads each control from its own master and derived companion', () => {
    const values = {
      image_male_url: 'https://cdn/a-male.webp',
      image_male_thumbnail_url: 'https://cdn/a-male-thumbnail.webp',
      video_female_url: 'https://cdn/a-female.mp4',
      video_female_preview_thumbnail_url: 'https://cdn/a-female-thumbnail.webp',
    };
    expect(genderMediaMaster(values, 'image_male')).toBe('https://cdn/a-male.webp');
    expect(genderMediaThumbnail(values, 'image_male')).toBe('https://cdn/a-male-thumbnail.webp');
    expect(genderMediaMaster(values, 'video_female')).toBe('https://cdn/a-female.mp4');
    expect(genderMediaThumbnail(values, 'video_female')).toBe('https://cdn/a-female-thumbnail.webp');
    // Independent: nothing falls back to the other gender or kind.
    expect(genderMediaMaster(values, 'image_female')).toBeNull();
    expect(genderMediaThumbnail(values, 'video_male')).toBeNull();
    expect(genderMediaMaster(null, 'image_male')).toBeNull();
  });
});

describe('prepareGenderImage', () => {
  it('sends the picked picture as it is, with a data: preview', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const prepared = await prepareGenderImage(file(bytes, 'a.jpg', 'image/jpeg'));
    expect(isPreparedGenderMedia(prepared)).toBe(true);
    if (!isPreparedGenderMedia(prepared)) return;
    expect(prepared.kind).toBe('image');
    expect(Buffer.from((prepared.body as { image: string }).image, 'base64')).toEqual(Buffer.from(bytes));
    expect(prepared.preview.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('accepts exactly the formats the server decodes', async () => {
    expect([...EXERCISE_IMAGE_INPUT_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(await prepareGenderImage(file(new Uint8Array([1]), 'a.tiff', 'image/tiff'))).toBe('not_an_image');
    expect(await prepareGenderImage(file(new Uint8Array([1]), 'a.svg', 'image/svg+xml'))).toBe('not_an_image');
  });

  it('refuses an empty file and one over the ceiling before reading it', async () => {
    expect(await prepareGenderImage(file(new Uint8Array(0), 'a.png', 'image/png'))).toBe('unreadable');
    const big = file(new Uint8Array(exerciseGenderImageMaxMb() * 1024 * 1024 + 1), 'a.png', 'image/png');
    expect(await prepareGenderImage(big)).toBe('too_large');
  });
});

describe('prepareGenderVideo', () => {
  it('refuses anything that is not an MP4 before decoding it', async () => {
    expect(await prepareGenderVideo(file(new Uint8Array([1]), 'a.mov', 'video/quicktime'))).toBe('not_an_mp4');
  });
});

describe('uploadStagedGenderMedia', () => {
  const picks: StagedGenderMedia = {
    image_male: { kind: 'image', body: { image: 'AAAA' }, preview: 'data:image/png;base64,AAAA' },
    video_female: { kind: 'video', body: { video: 'BBBB', frame: 'CCCC' }, preview: 'data:image/png;base64,CCCC' },
  };

  it('posts each staged pick to its own route, in a fixed order, one at a time', async () => {
    const calls: [string, unknown][] = [];
    const failures = await uploadStagedGenderMedia(async (path, body) => { calls.push([path, body]); }, '/exercises', 9, picks);
    expect(failures).toEqual([]);
    expect(calls).toEqual([
      ['/exercises/9/image/male', { image: 'AAAA' }],
      ['/exercises/9/video/female', { video: 'BBBB', frame: 'CCCC' }],
    ]);
  });

  it('reports a failure without stopping the others', async () => {
    const failures = await uploadStagedGenderMedia(
      async (path) => { if (path.includes('/image/')) throw new Error('boom'); },
      '/platform/exercises',
      3,
      picks,
    );
    expect(failures).toEqual([{ key: 'image_male', message: 'boom' }]);
  });

  it('posts nothing when nothing was staged', async () => {
    let called = false;
    await uploadStagedGenderMedia(async () => { called = true; }, '/exercises', 1, {});
    expect(called).toBe(false);
  });
});

describe('the video frame (source)', () => {
  it('is drawn whole, never cover-cropped, and downscaled to a ceiling', () => {
    expect(VIDEO_FRAME_MAX_SIDE).toBe(1920);
    expect(libSrc).toContain('ctx.drawImage(video, 0, 0, width, height)');
    expect(libSrc).not.toContain('Math.min(video.videoWidth, video.videoHeight)');
  });

  it('fails the whole upload when no frame can be captured', () => {
    expect(libSrc).toMatch(/const frame = await captureVideoFrame\(file\);\s*\n\s*if \(!frame\) return/);
  });
});

describe('the controls (source)', () => {
  it('act on the server straight away when bound and stage when not', () => {
    expect(fieldSrc).toContain("method: 'POST'");
    expect(fieldSrc).toContain("method: 'DELETE'");
    expect(fieldSrc).toContain('if (exerciseId == null) {');
    expect(fieldSrc).toContain('onStaged?.(prepared)');
  });

  it('sends nothing when preparation failed, so existing media survives', () => {
    expect(fieldSrc).toMatch(/if \(!isPreparedGenderMedia\(prepared\)\) \{[\s\S]*?return;/);
  });

  it('draws a data: preview for a staged pick, never an object URL', () => {
    expect(fieldSrc).toContain('prepared.preview');
    expect(fieldSrc).not.toContain('createObjectURL');
    expect(fieldSrc).toContain('SAFE_IMAGE_SRC.test(preview)');
  });

  it('resolves no media of its own: no other-gender, Base Exercise or legacy fallback', () => {
    expect(fieldSrc).not.toContain('image_url');
    expect(fieldSrc).not.toContain('video_url');
    expect(fieldSrc).not.toContain('effective_');
  });

  it('the section renders a column per gender with an image and a video control each', () => {
    expect(sectionSrc).toContain('EXERCISE_GENDERS.map');
    expect(sectionSrc).toContain('EXERCISE_MEDIA_KINDS.map');
    expect(sectionSrc).toContain('<ExerciseGenderMediaField');
  });

  it('the read-only preview draws the same four, thumbnails and posters only', () => {
    expect(previewSrc).toContain('EXERCISE_GENDERS.map');
    expect(previewSrc).toContain("genderMediaKey('image', gender)");
    expect(previewSrc).toContain("genderMediaKey('video', gender)");
    expect(previewSrc).not.toContain('<input');
    expect(previewSrc).not.toContain('onChange');
  });
});

describe('locales', () => {
  const keys = [
    'gender_male', 'gender_female', 'gender_media_image_requirements', 'gender_media_video_requirements',
    'gender_media_upload', 'gender_media_replace', 'gender_media_input_label', 'gender_media_confirm_remove',
    'gender_media_error_not_an_image', 'gender_media_error_not_an_mp4', 'gender_media_error_too_large',
    'gender_media_error_unreadable', 'gender_media_error_frame_failed', 'gender_media_error_upload_failed',
    'gender_media_error_remove_failed', 'gender_media_created_upload_failed',
  ];
  for (const code of ['en', 'es', 'ca']) {
    it(`${code} carries every gender media label`, () => {
      const messages = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${code}.json`), 'utf-8'));
      for (const key of keys) expect(messages.exercises[key], `${code}.exercises.${key}`).toBeTruthy();
    });
  }
});
