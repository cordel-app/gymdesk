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
  exerciseImageMaxBytes,
  validateGenderImageInput,
  validateGenderVideo,
  videoObjectUrls,
  videoPreviewKeyFor,
  videoPreviewThumbnailUrlFor,
  videoPreviewUrlFor,
  withGenderMediaCompanions,
} from '../domain/exerciseGenderMedia';
import { EXERCISE_GENDER_MEDIA_UPLOAD_PATH } from '../api/exercise-gender-media';
import { mediaReferenceClause } from '../domain/exerciseMediaReferences';

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

describe('validateGenderImageInput', () => {
  it('accepts bytes within the ceiling', () => {
    expect(validateGenderImageInput(Buffer.alloc(1024), 'image')).toBeNull();
  });

  it('rejects a string and an array, which carry a length like bytes', () => {
    expect(validateGenderImageInput('RIFF....WEBP', 'image')).toMatchObject({ file: 'image', rejection: 'not_an_image' });
    expect(validateGenderImageInput([1, 2, 3], 'frame')).toMatchObject({ file: 'frame', rejection: 'not_an_image' });
  });

  it('rejects an oversized picture before decoding it', () => {
    const big = Buffer.alloc(exerciseImageMaxBytes() + 1);
    expect(validateGenderImageInput(big, 'image')).toMatchObject({ file: 'image', rejection: 'too_large' });
  });

  it('reads the ceiling from EXERCISE_IMAGE_MAX_MB, defaulting to 10 and never above 25', () => {
    expect(exerciseImageMaxBytes({} as NodeJS.ProcessEnv)).toBe(10 * 1024 * 1024);
    expect(exerciseImageMaxBytes({ EXERCISE_IMAGE_MAX_MB: '4' } as any)).toBe(4 * 1024 * 1024);
    expect(exerciseImageMaxBytes({ EXERCISE_IMAGE_MAX_MB: '999' } as any)).toBe(25 * 1024 * 1024);
    expect(exerciseImageMaxBytes({ EXERCISE_IMAGE_MAX_MB: 'abc' } as any)).toBe(10 * 1024 * 1024);
  });
});

describe('validateGenderVideo', () => {
  it('names the video when it is not an MP4', () => {
    expect(validateGenderVideo(Buffer.alloc(64))).toMatchObject({ file: 'video', rejection: 'not_an_mp4' });
  });

  it('rejects a non-buffer video', () => {
    expect(validateGenderVideo('video')).toMatchObject({ file: 'video' });
  });
});
