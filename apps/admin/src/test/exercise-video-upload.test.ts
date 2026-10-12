import { afterEach, describe, expect, it } from 'vitest';
import {
  EXERCISE_VIDEO_DEFAULT_MAX_MB,
  EXERCISE_VIDEO_POSTER_SIZE,
  exerciseVideoMaxMb,
  isPreparedExerciseVideo,
  posterTimestamp,
} from '../lib/exerciseVideoUpload';

// The pure helpers of the legacy exercise video module. Its upload control was
// replaced by the four gender-specific controls (#1420 stage 3), covered by
// exercise-gender-media.test.ts; what remains is what they still import: the
// size ceiling and the frame timestamp.

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
