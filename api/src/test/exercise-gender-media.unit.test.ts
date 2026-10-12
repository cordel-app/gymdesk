import { describe, expect, it } from 'vitest';
import {
  EXERCISE_GENDER_MEDIA_COLUMNS,
  baseExerciseGenderFolderKeys,
  buildBaseExerciseGenderImageKey,
  buildBaseExerciseGenderVideoKey,
  buildGymExerciseGenderImageKey,
  buildGymExerciseGenderVideoKey,
  gymExerciseGenderFolderKeys,
  imageObjectUrls,
  imageThumbnailUrlFor,
  isGymOwnedGenderMediaUrl,
  isPlatformOwnedGenderMediaUrl,
  parseExerciseGender,
  thumbnailKeyFor,
  validateGenderImagePair,
  validateGenderVideoTriple,
  videoObjectUrls,
  videoPreviewKeyFor,
  videoPreviewThumbnailUrlFor,
  videoPreviewUrlFor,
  withGenderMediaCompanions,
} from '../domain/exerciseGenderMedia';
import { EXERCISE_GENDER_MEDIA_UPLOAD_PATH } from '../api/exercise-gender-media';
import { mediaReferenceClause } from '../domain/exerciseMediaReferences';

/** A minimal RIFF/WEBP container with a VP8X header of the given size. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('exercise gender media keys (#1420)', () => {
  it('builds the documented gym keys, gender suffix on every file', () => {
    const image = buildGymExerciseGenderImageKey('gyms/1-Fit', 7, 'Barbell Press', 'female');
    expect(image).toBe('gyms/1-Fit/exercises/images/7-Barbell-Press-female.webp');
    expect(thumbnailKeyFor(image)).toBe('gyms/1-Fit/exercises/images/7-Barbell-Press-female-thumbnail.webp');
    const video = buildGymExerciseGenderVideoKey('gyms/1-Fit', 7, 'Barbell Press', 'male');
    expect(video).toBe('gyms/1-Fit/exercises/videos/7-Barbell-Press-male.mp4');
    expect(videoPreviewKeyFor(video)).toBe('gyms/1-Fit/exercises/videos/7-Barbell-Press-male.webp');
    expect(thumbnailKeyFor(videoPreviewKeyFor(video))).toBe('gyms/1-Fit/exercises/videos/7-Barbell-Press-male-thumbnail.webp');
  });

  it('builds the platform keys under cordel/exercises', () => {
    expect(buildBaseExerciseGenderImageKey(3, 'Squat', 'male')).toBe('cordel/exercises/images/3-Squat-male.webp');
    expect(buildBaseExerciseGenderVideoKey(3, 'Squat', 'female')).toBe('cordel/exercises/videos/3-Squat-female.mp4');
  });

  it('keeps a video preview under videos/, never under images/', () => {
    const key = videoPreviewKeyFor(buildGymExerciseGenderVideoKey('gyms/1-Fit', 7, 'Squat', 'male'));
    expect(key).toContain('/exercises/videos/');
    expect(key).not.toContain('/exercises/images/');
  });

  it('derives companions from the master URL and preserves a query string', () => {
    expect(imageThumbnailUrlFor('https://cdn.test/a/1-X-male.webp')).toBe('https://cdn.test/a/1-X-male-thumbnail.webp');
    expect(imageThumbnailUrlFor('https://cdn.test/a/1-X-male.webp?v=2')).toBe('https://cdn.test/a/1-X-male-thumbnail.webp?v=2');
    expect(imageThumbnailUrlFor('https://cdn.test/a/legacy.png')).toBeNull();
    expect(imageThumbnailUrlFor(null)).toBeNull();
    expect(videoPreviewUrlFor('https://cdn.test/v/1-X-female.mp4')).toBe('https://cdn.test/v/1-X-female.webp');
    expect(videoPreviewThumbnailUrlFor('https://cdn.test/v/1-X-female.mp4')).toBe('https://cdn.test/v/1-X-female-thumbnail.webp');
    expect(videoPreviewUrlFor('https://www.youtube.com/watch?v=abc')).toBeNull();
  });

  it('lists the objects behind a master', () => {
    expect(imageObjectUrls('https://cdn.test/a/1-X-male.webp')).toEqual([
      'https://cdn.test/a/1-X-male.webp',
      'https://cdn.test/a/1-X-male-thumbnail.webp',
    ]);
    expect(videoObjectUrls('https://cdn.test/v/1-X-male.mp4')).toEqual([
      'https://cdn.test/v/1-X-male.mp4',
      'https://cdn.test/v/1-X-male.webp',
      'https://cdn.test/v/1-X-male-thumbnail.webp',
    ]);
    expect(imageObjectUrls(null)).toEqual([]);
    expect(videoObjectUrls(null)).toEqual([]);
  });

  it('reports null companions for a row with no media', () => {
    const row = withGenderMediaCompanions({
      image_male_url: null, image_female_url: null, video_male_url: null, video_female_url: null,
    });
    expect(row.image_male_thumbnail_url).toBeNull();
    expect(row.video_female_preview_url).toBeNull();
  });

  it('declares the four columns and the folder markers', () => {
    expect(EXERCISE_GENDER_MEDIA_COLUMNS).toEqual({
      male: { image: 'image_male_url', video: 'video_male_url' },
      female: { image: 'image_female_url', video: 'video_female_url' },
    });
    expect(gymExerciseGenderFolderKeys('gyms/1-Fit', 'video')).toEqual(['gyms/1-Fit/', 'gyms/1-Fit/exercises/', 'gyms/1-Fit/exercises/videos/']);
    expect(baseExerciseGenderFolderKeys('image')).toEqual(['cordel/', 'cordel/exercises/', 'cordel/exercises/images/']);
  });

  it('accepts only male and female', () => {
    expect(parseExerciseGender('male')).toBe('male');
    expect(parseExerciseGender('female')).toBe('female');
    expect(parseExerciseGender('other')).toBeNull();
    expect(parseExerciseGender(undefined)).toBeNull();
  });

  it('matches the upload paths of both routers', () => {
    expect(EXERCISE_GENDER_MEDIA_UPLOAD_PATH.test('/exercises/5/image/male')).toBe(true);
    expect(EXERCISE_GENDER_MEDIA_UPLOAD_PATH.test('/platform/exercises/5/video/female')).toBe(true);
    expect(EXERCISE_GENDER_MEDIA_UPLOAD_PATH.test('/exercises/5/image')).toBe(false);
  });

  it('counts the new columns as media references', () => {
    const { clause } = mediaReferenceClause('https://external.test/x.webp');
    for (const column of ['image_male_url', 'image_female_url', 'video_male_url', 'video_female_url']) {
      expect(clause).toContain(column);
    }
  });
});

describe('exercise gender media ownership', () => {
  it('lets a gym delete only under its own prefix', () => {
    expect(isGymOwnedGenderMediaUrl('https://external.test/x.webp', 'gyms/1-Fit')).toBe(false);
    expect(isGymOwnedGenderMediaUrl(null, 'gyms/1-Fit')).toBe(false);
    expect(isGymOwnedGenderMediaUrl('https://external.test/x.webp', null)).toBe(false);
  });

  it('never treats an external link as the platform’s', () => {
    expect(isPlatformOwnedGenderMediaUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isPlatformOwnedGenderMediaUrl(null)).toBe(false);
  });
});

describe('validateGenderImagePair', () => {
  it('accepts a 1080 master and a 256 thumbnail', () => {
    expect(validateGenderImagePair(webp(1080, 1080), webp(256, 256))).toBeNull();
  });

  it('rejects a master of the wrong size', () => {
    expect(validateGenderImagePair(webp(1000, 1080), webp(256, 256))).toMatchObject({ file: 'image', rejection: 'wrong_size' });
  });

  it('rejects a thumbnail of the wrong size', () => {
    expect(validateGenderImagePair(webp(1080, 1080), webp(512, 512))).toMatchObject({ file: 'thumbnail', rejection: 'wrong_size' });
  });

  it('rejects a PNG, a string and an array', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    expect(validateGenderImagePair(png, webp(256, 256))).toMatchObject({ file: 'image', rejection: 'not_webp' });
    expect(validateGenderImagePair('RIFF....WEBP', webp(256, 256))).toMatchObject({ rejection: 'not_webp' });
    expect(validateGenderImagePair([1, 2, 3], webp(256, 256))).toMatchObject({ rejection: 'not_webp' });
  });

  it('rejects an oversized master before reading it', () => {
    const big = Buffer.alloc(9 * 1024 * 1024);
    expect(validateGenderImagePair(big, webp(256, 256))).toMatchObject({ file: 'image', rejection: 'too_large' });
  });
});

describe('validateGenderVideoTriple', () => {
  it('names the video first when it is not an MP4', () => {
    expect(validateGenderVideoTriple(Buffer.alloc(64), webp(1080, 1080), webp(256, 256))).toMatchObject({
      file: 'video',
      rejection: 'not_an_mp4',
    });
  });

  it('rejects a non-buffer video', () => {
    expect(validateGenderVideoTriple('video', webp(1080, 1080), webp(256, 256))).toMatchObject({ file: 'video' });
  });
});
