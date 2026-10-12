import { describe, expect, it } from 'vitest';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  EXERCISE_IMAGE_THUMBNAIL_SIZE,
  blobToBase64,
  isPreparedExerciseImage,
  isSafeImageSrc,
} from '../lib/exerciseImageUpload';

// The pure helpers of the legacy exercise image module. Its upload control was
// replaced by the four gender-specific controls (#1420 stage 3), which are
// covered by exercise-gender-media.test.ts; what remains here is what other
// surfaces still import: the safe-source guard and the base64 encoder.

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
