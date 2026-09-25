// #719 part 2, the pure half: where a Gym Exercise's video and poster live, what
// the MP4 parser reads out of a file, and which uploads are refused.
//
// A unit test (no DB, no HTTP, no bucket) because every rule under test is a
// pure function — `domain/mp4Video.ts` and `domain/exerciseVideos.ts`. The
// routes that apply them are covered by gym-exercise-videos.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import {
  EXERCISE_VIDEO_DEFAULT_MAX_MB,
  EXERCISE_VIDEO_MAX_MB_CEILING,
  EXERCISE_VIDEO_POSTER_SIZE,
  EXERCISE_VIDEOS_FOLDER,
  buildGymExerciseVideoKey,
  buildGymExerciseVideoPosterKey,
  exerciseVideoMaxBytes,
  gymExerciseVideoFolderKeys,
  validateExerciseVideo,
  validateExerciseVideoPair,
  validateExerciseVideoPoster,
} from '../domain/exerciseVideos';
import { isMp4Brand, readMp4Metadata, videoCodecNames } from '../domain/mp4Video';
import { encodePngRgba } from '../domain/pngImage';
import { buildMp4, ftypBox } from './mp4-fixtures';

const PREFIX = 'gyms/abc-Fit';

function png(width: number, height = width): Buffer {
  return encodePngRgba(width, height, Buffer.alloc(width * height * 4, 0x30));
}

const originalMaxMb = process.env.EXERCISE_VIDEO_MAX_MB;

afterEach(() => {
  if (originalMaxMb === undefined) delete process.env.EXERCISE_VIDEO_MAX_MB;
  else process.env.EXERCISE_VIDEO_MAX_MB = originalMaxMb;
});

// ─── Object keys (#719 §7, §18) ───────────────────────────────────────────────

describe('gym exercise video keys', () => {
  it('puts the video under the gym’s own Exercises/Videos folder', () => {
    expect(buildGymExerciseVideoKey(PREFIX, 12, 'Barbell Press'))
      .toBe(`${PREFIX}/${EXERCISE_VIDEOS_FOLDER}/12-Barbell-Press.mp4`);
  });

  it('names the poster after the video it belongs to', () => {
    expect(buildGymExerciseVideoPosterKey(PREFIX, 12, 'Barbell Press'))
      .toBe(`${PREFIX}/${EXERCISE_VIDEOS_FOLDER}/12-Barbell-Press-thumbnail.png`);
  });

  it('never builds a platform key from a gym prefix (§18)', () => {
    for (const key of [
      buildGymExerciseVideoKey(PREFIX, 1, 'Squat'),
      buildGymExerciseVideoPosterKey(PREFIX, 1, 'Squat'),
    ]) {
      expect(key.startsWith(`${PREFIX}/`)).toBe(true);
      expect(key.startsWith('cordel/')).toBe(false);
    }
  });

  it('sanitizes the name deterministically, the way the image keys do', () => {
    expect(buildGymExerciseVideoKey(PREFIX, 3, 'Cable Row, Seated'))
      .toBe(`${PREFIX}/${EXERCISE_VIDEOS_FOLDER}/3-Cable-Row-Seated.mp4`);
    expect(buildGymExerciseVideoKey(PREFIX, 3, 'Cable Row, Seated'))
      .toBe(buildGymExerciseVideoKey(PREFIX, 3, 'Cable Row, Seated'));
  });

  it('caps the name so neither URL can outgrow its column', () => {
    const key = buildGymExerciseVideoPosterKey(PREFIX, 9, 'A'.repeat(300));
    expect(key.length).toBeLessThan(200);
  });

  it('writes every folder marker from the gym root down, outermost first', () => {
    expect(gymExerciseVideoFolderKeys(PREFIX)).toEqual([
      `${PREFIX}/`,
      `${PREFIX}/Exercises/`,
      `${PREFIX}/${EXERCISE_VIDEOS_FOLDER}/`,
    ]);
  });
});

// ─── MP4 parsing (#719 §7) ────────────────────────────────────────────────────

describe('readMp4Metadata', () => {
  it('reads the brands, the movie box and the video sample entries', () => {
    const metadata = readMp4Metadata(buildMp4({ codecs: ['avc1'] }))!;
    expect(metadata.majorBrand).toBe('isom');
    expect(metadata.compatibleBrands).toContain('mp42');
    expect(metadata.hasMovieBox).toBe(true);
    expect(metadata.videoSampleEntries).toEqual(['avc1']);
    expect(videoCodecNames(metadata)).toEqual(['H.264']);
    expect(isMp4Brand(metadata)).toBe(true);
  });

  it('sees a video track that sits behind a large mdat', () => {
    const metadata = readMp4Metadata(buildMp4({ mdatBytes: 64 * 1024 }))!;
    expect(metadata.hasMovieBox).toBe(true);
    expect(metadata.videoSampleEntries).toEqual(['avc1']);
  });

  it('separates audio-only from video', () => {
    const metadata = readMp4Metadata(buildMp4({ codecs: ['mp4a'] }))!;
    expect(metadata.sampleEntries).toEqual(['mp4a']);
    expect(metadata.videoSampleEntries).toEqual([]);
  });

  it('returns null for bytes that are not an ISO base media file', () => {
    expect(readMp4Metadata(Buffer.from('not a video at all, really'))).toBeNull();
    expect(readMp4Metadata(png(8))).toBeNull();
  });

  it('refuses a string or an array rather than reading its “bytes”', () => {
    expect(readMp4Metadata('ftypisom' as unknown)).toBeNull();
    expect(readMp4Metadata([0x00, 0x00, 0x00, 0x18] as unknown)).toBeNull();
  });

  it('ends the walk on a malformed box size instead of throwing', () => {
    const truncated = buildMp4();
    // Claim the `moov` box is far larger than the file.
    const broken = Buffer.from(truncated);
    broken.writeUInt32BE(0xffff_ff00, broken.indexOf(Buffer.from('moov', 'latin1')) - 4);
    expect(() => readMp4Metadata(broken)).not.toThrow();
  });

  it('does not treat a QuickTime file as MP4', () => {
    const metadata = readMp4Metadata(buildMp4({ majorBrand: 'qt  ', compatibleBrands: ['qt  '] }))!;
    expect(isMp4Brand(metadata)).toBe(false);
  });

  it('accepts a file whose major brand is exotic but lists isom as compatible', () => {
    const metadata = readMp4Metadata(buildMp4({ majorBrand: 'XAVC', compatibleBrands: ['isom'] }))!;
    expect(isMp4Brand(metadata)).toBe(true);
  });
});

// ─── Video validation (#719 §7, §9) ───────────────────────────────────────────

describe('validateExerciseVideo', () => {
  it('accepts an H.264 MP4', () => {
    expect(validateExerciseVideo(buildMp4())).toBeNull();
  });

  it('accepts another codec a browser can play — §7 prefers H.264, it does not require it', () => {
    expect(validateExerciseVideo(buildMp4({ codecs: ['hvc1'] }))).toBeNull();
    expect(videoCodecNames(readMp4Metadata(buildMp4({ codecs: ['hvc1'] }))!)).toEqual(['HEVC']);
  });

  it('rejects a renamed .mov, whatever the request claimed', () => {
    expect(validateExerciseVideo(buildMp4({ majorBrand: 'qt  ', compatibleBrands: ['qt  '] })))
      .toMatchObject({ kind: 'video', rejection: 'not_an_mp4' });
  });

  it('rejects a PNG with an .mp4 name', () => {
    expect(validateExerciseVideo(png(16))).toMatchObject({ rejection: 'not_an_mp4' });
  });

  it('rejects a file with no movie header', () => {
    expect(validateExerciseVideo(buildMp4({ withMovieBox: false })))
      .toMatchObject({ rejection: 'not_an_mp4' });
  });

  it('rejects an audio-only file', () => {
    expect(validateExerciseVideo(buildMp4({ codecs: ['mp4a'] })))
      .toMatchObject({ rejection: 'no_video_track' });
  });

  it('rejects an ftyp with nothing after it', () => {
    expect(validateExerciseVideo(ftypBox('isom', ['isom']))).toMatchObject({ rejection: 'not_an_mp4' });
  });

  it('rejects a file past the configured ceiling', () => {
    process.env.EXERCISE_VIDEO_MAX_MB = '1';
    const big = buildMp4({ mdatBytes: 2 * 1024 * 1024 });
    expect(validateExerciseVideo(big)).toMatchObject({ kind: 'video', rejection: 'too_large' });
    process.env.EXERCISE_VIDEO_MAX_MB = '50';
    expect(validateExerciseVideo(big)).toBeNull();
  });

  it('refuses a string rather than measuring its length as bytes', () => {
    expect(validateExerciseVideo('x'.repeat(64))).toMatchObject({ rejection: 'not_an_mp4' });
  });
});

describe('exerciseVideoMaxBytes', () => {
  it('defaults when nothing is configured', () => {
    delete process.env.EXERCISE_VIDEO_MAX_MB;
    expect(exerciseVideoMaxBytes()).toBe(EXERCISE_VIDEO_DEFAULT_MAX_MB * 1024 * 1024);
  });

  it('takes a configured value', () => {
    process.env.EXERCISE_VIDEO_MAX_MB = '12';
    expect(exerciseVideoMaxBytes()).toBe(12 * 1024 * 1024);
  });

  it('clamps a value past the ceiling, and ignores nonsense', () => {
    process.env.EXERCISE_VIDEO_MAX_MB = '5000';
    expect(exerciseVideoMaxBytes()).toBe(EXERCISE_VIDEO_MAX_MB_CEILING * 1024 * 1024);
    process.env.EXERCISE_VIDEO_MAX_MB = 'lots';
    expect(exerciseVideoMaxBytes()).toBe(EXERCISE_VIDEO_DEFAULT_MAX_MB * 1024 * 1024);
    process.env.EXERCISE_VIDEO_MAX_MB = '-3';
    expect(exerciseVideoMaxBytes()).toBe(EXERCISE_VIDEO_DEFAULT_MAX_MB * 1024 * 1024);
  });
});

// ─── Poster validation (#719 §7) ──────────────────────────────────────────────

describe('validateExerciseVideoPoster', () => {
  it('accepts a 512×512 PNG', () => {
    expect(validateExerciseVideoPoster(png(EXERCISE_VIDEO_POSTER_SIZE))).toBeNull();
  });

  it('rejects another size', () => {
    expect(validateExerciseVideoPoster(png(256))).toMatchObject({ kind: 'poster', rejection: 'wrong_size' });
  });

  it('rejects something that is not a PNG', () => {
    expect(validateExerciseVideoPoster(buildMp4())).toMatchObject({ rejection: 'not_a_png' });
  });

  it('does not demand transparency — a frame of video is opaque', () => {
    const opaque = Buffer.from(png(EXERCISE_VIDEO_POSTER_SIZE));
    opaque[25] = 2; // colour type 2: truecolour, no alpha channel
    expect(validateExerciseVideoPoster(opaque)).toBeNull();
  });
});

describe('validateExerciseVideoPair', () => {
  it('accepts a valid pair', () => {
    expect(validateExerciseVideoPair(buildMp4(), png(EXERCISE_VIDEO_POSTER_SIZE))).toBeNull();
  });

  it('reports the video first when both are wrong', () => {
    expect(validateExerciseVideoPair(png(16), png(16))).toMatchObject({ kind: 'video' });
  });

  it('fails the whole upload when only the poster is wrong (#719 Q2)', () => {
    expect(validateExerciseVideoPair(buildMp4(), png(64))).toMatchObject({ kind: 'poster', rejection: 'wrong_size' });
  });
});
