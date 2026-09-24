import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  EXERCISE_IMAGE_THUMBNAIL_SIZE,
  blobToBase64,
  isPreparedExerciseImage,
  isSafeImageSrc,
} from '../lib/exerciseImageUpload';

// #719 part 1 — the Image control on a Gym Exercise: a 2048×2048 PNG master
// uploaded together with the 512×512 thumbnail the *browser* draws from it (the
// answer on #719 Q2), and the ownership-aware replace/remove behind it.
//
// `blobToBase64` and the guard are pure and run here directly. Everything that
// needs a DOM (`Image`, `<canvas>`) and the rendering itself have no
// component-test infra in this repo (docs/architecture.md's TL;DR), so — like
// exercise-media-thumbnails.test.ts (#720) and base-nutrition-images.test.ts
// (#715) — those are pinned down by scanning the source.

const SRC = join(__dirname, '..');
const LIB = join(SRC, 'lib', 'exerciseImageUpload.ts');
const COMPONENT = join(SRC, 'components', 'ExerciseImageField.tsx');
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

describe('exerciseImageUpload — sizes', () => {
  it('states the two sizes #719 §5 fixes', () => {
    expect(EXERCISE_IMAGE_MASTER_SIZE).toBe(2048);
    expect(EXERCISE_IMAGE_THUMBNAIL_SIZE).toBe(512);
  });
});

describe('blobToBase64', () => {
  it('encodes bytes exactly, so the master is never re-encoded', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const encoded = await blobToBase64(new Blob([bytes]));
    expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('survives a payload larger than one String.fromCharCode chunk', async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).fill(0xab);
    const encoded = await blobToBase64(new Blob([bytes]));
    expect(Buffer.from(encoded, 'base64').length).toBe(bytes.length);
  });
});

describe('isPreparedExerciseImage', () => {
  it('separates the pair from a problem', () => {
    expect(isPreparedExerciseImage({ image: 'a', thumbnail: 'b' })).toBe(true);
    expect(isPreparedExerciseImage('thumbnail_failed')).toBe(false);
    expect(isPreparedExerciseImage('wrong_size')).toBe(false);
  });
});

describe('isSafeImageSrc', () => {
  it('draws the browser’s own staged preview and a stored image URL', () => {
    expect(isSafeImageSrc('blob:http://localhost:8081/2f0b-4e1a')).toBe(true);
    expect(isSafeImageSrc('https://cdn.example.com/gyms/1-Fit/Exercises/Images/7-Squat-thumbnail.png')).toBe(true);
    expect(isSafeImageSrc('http://cdn.example.com/7-Squat.png')).toBe(true);
    expect(isSafeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeImageSrc('HTTPS://CDN.EXAMPLE.COM/a.png')).toBe(true);
  });

  it('refuses a reference that is not an image URL, whatever a PUT stored', () => {
    for (const url of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      '//evil.example.com/a.png',
      'not a url at all',
    ]) {
      expect(isSafeImageSrc(url)).toBe(false);
    }
  });

  it('treats a missing reference as nothing to draw', () => {
    expect(isSafeImageSrc(null)).toBe(false);
    expect(isSafeImageSrc(undefined)).toBe(false);
    expect(isSafeImageSrc('')).toBe(false);
  });
});

describe('prepareExerciseImage (source)', () => {
  it('checks the format and the 2048×2048 master before doing any work', () => {
    expect(libSrc).toMatch(/return 'not_a_png'/);
    expect(libSrc).toMatch(/EXERCISE_IMAGE_MASTER_SIZE[\s\S]*?return 'wrong_size'/);
  });

  it('fails the whole upload when the thumbnail cannot be produced (#719 Q2)', () => {
    expect(libSrc).toMatch(/const thumbnail = await makeThumbnail\(file\);\s*\n\s*if \(!thumbnail\) return 'thumbnail_failed';/);
    // The pair is only built after the thumbnail exists, so there is no path
    // that uploads a master on its own.
    const returnsPair = libSrc.indexOf('return { image, thumbnail: thumb }');
    expect(returnsPair).toBeGreaterThan(libSrc.indexOf("return 'thumbnail_failed'"));
  });

  it('draws the thumbnail on a transparent canvas, undistorted', () => {
    expect(libSrc).toContain("getContext('2d', { alpha: true })");
    expect(libSrc).toContain('ctx.drawImage(image, 0, 0, size, size)');
    // A fill would make the background opaque, which the server rejects.
    expect(libSrc).not.toContain('fillRect');
    expect(libSrc).toContain("canvas.toBlob(resolve, 'image/png')");
  });
});

describe('ExerciseImageField', () => {
  it('uploads the pair to the exercise’s own endpoint', () => {
    expect(componentSrc).toMatch(/\/exercises\/\$\{exerciseId\}\/image`, \{\s*\n\s*method: 'POST'/);
    expect(componentSrc).toMatch(/\/exercises\/\$\{exerciseId\}\/image`, \{ method: 'DELETE' \}/);
    // Not the generic #417 upload route, which stores a single image with no
    // thumbnail and no ownership rules.
    expect(componentSrc).not.toContain('/storage/uploads/exercise-image');
  });

  it('sends nothing when preparation failed, so existing media survives (§8)', () => {
    const guard = componentSrc.indexOf('if (!isPreparedExerciseImage(prepared))');
    const post = componentSrc.indexOf("method: 'POST'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
    expect(componentSrc).toMatch(/if \(!isPreparedExerciseImage\(prepared\)\) \{[\s\S]*?return;/);
  });

  it('draws the thumbnail, never the 2048 master, and lazy-loads it (§17)', () => {
    expect(componentSrc).toContain('thumbnailUrl ?? imageUrl');
    expect(componentSrc).toContain("loading=\"lazy\"");
    expect(componentSrc).toContain("objectFit: 'contain'");
  });

  it('hands the frame only a reference the scheme guard passed', () => {
    expect(componentSrc).toContain('const drawable = preview != null && SAFE_IMAGE_SRC.test(preview)');
    expect(componentSrc).toMatch(/\{drawable \? \([\s\S]*?<img src=\{preview!\}/);
    // The reference still drives Replace/Remove: an undrawable one is not an
    // absent one.
    expect(componentSrc).toContain('const hasImage = preview != null');
  });

  it('resolves no media of its own — no Base Exercise fallback (§13)', () => {
    expect(componentSrc).not.toMatch(/cordel|base_exercise|cloned_from_id/);
  });

  it('states the required format to the user (§21)', () => {
    expect(componentSrc).toContain("t('image_requirements'");
    expect(componentSrc).toContain('accept="image/png"');
  });

  it('has an uploading, a removing and an error state (§21)', () => {
    for (const key of ['image_uploading', 'image_removing', 'image_replace', 'image_remove', 'image_none']) {
      expect(componentSrc).toContain(`t('${key}')`);
    }
    expect(componentSrc).toContain('setError');
  });
});

describe('Exercises page', () => {
  it('manages the image through the dedicated control, not the form', () => {
    expect(pageSrc).toContain('<ExerciseImageField');
    expect(pageSrc).toContain('exerciseId={ex.id}');
    // The image is no longer a field of the edit/add payloads: a PUT must not
    // be able to undo an upload or re-apply a removed image.
    expect(pageSrc).not.toMatch(/image_url: (editForm|addForm)\./);
    expect(pageSrc).not.toContain('ImageUploadField');
  });

  it('stages the image while an exercise is being created and uploads it after', () => {
    expect(pageSrc).toContain('onStaged={setStagedImage}');
    expect(pageSrc).toMatch(/if \(stagedImage\) \{[\s\S]*?\/exercises\/\$\{created\.id\}\/image/);
  });

  it('reads both references from the API and prefers the thumbnail in the list', () => {
    expect(pageSrc).toContain('image_url: string | null; image_thumbnail_url: string | null;');
    expect(pageSrc).toContain('ex.image_thumbnail_url ?? ex.image_url');
    expect(detailSrc).toContain('detail.image_thumbnail_url ?? detail.image_url');
  });
});

describe('locales', () => {
  const keys = [
    'label_image', 'image_none', 'image_requirements', 'image_upload', 'image_replace',
    'image_remove', 'image_uploading', 'image_removing', 'image_not_configured',
    'image_not_initialized', 'image_error_not_a_png', 'image_error_unreadable',
    'image_error_wrong_size', 'image_error_thumbnail_failed', 'image_error_upload_failed',
    'image_error_remove_failed',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code} carries every exercise image label`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of keys) {
        expect(messages.exercises[key], `${code}.exercises.${key}`).toBeTruthy();
      }
      // The retired "Image URL" label went with the free-text field it named.
      expect(messages.exercises.label_image_url).toBeUndefined();
    });
  }
});
