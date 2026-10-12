// #1420 — what the **server** does to the one picture a client sends for an
// exercise: orient it, fit it **whole** in a 1080 × 1080 canvas and encode the
// two WebP files an exercise's gender-specific image is stored as (1080 × 1080
// master and 256 × 256 thumbnail). A video's frame goes through the same function.
//
// It is the Member photo's discipline (`memberImageProcessing.ts`, #1449) with
// one deliberate difference: a Member's photo is a face and is centre-**cropped**;
// an exercise picture is an instruction and must show everything in it, so a
// non-square source is *contained* and the rest of the square is transparent. It
// is never stretched and never cropped.
//
// Everything is in memory, the input is judged from its decoded bytes (never
// `Content-Type` or a file name), the outputs carry no metadata, and the two
// outputs are verified to be WebP of exactly the documented size before anyone
// uploads them. The thumbnail is made from the processed master, not from the
// original.

import sharp from 'sharp';
import {
  EXERCISE_GENDER_IMAGE_MASTER_SIZE,
  EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE,
  EXERCISE_IMAGE_INPUT_FORMATS,
  EXERCISE_IMAGE_MAX_PIXELS,
  type ExerciseImageRejection,
} from './exerciseGenderMedia';
import { withImageProcessingSlot } from './imageProcessingSlot';
import { readWebpMetadata } from './webpImage';

export interface ProcessedExerciseImage {
  /** 1080 × 1080 WebP, the source contained and padded with transparency. */
  image: Buffer;
  /** 256 × 256 WebP, made from the processed master. */
  thumbnail: Buffer;
}

const WEBP_QUALITY = 82;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

function hasExactSize(buffer: Buffer, size: number): boolean {
  const meta = readWebpMetadata(buffer);
  return !!meta && meta.width === size && meta.height === size;
}

/** The two WebP files for `input`, or why there are none. */
export async function processExerciseImage(
  input: Buffer,
): Promise<ProcessedExerciseImage | { rejection: ExerciseImageRejection }> {
  return withImageProcessingSlot(async () => {
    try {
      const probe = sharp(input, { limitInputPixels: EXERCISE_IMAGE_MAX_PIXELS, failOn: 'error' });
      const meta = await probe.metadata();
      const format = meta.format as string | undefined;
      if (!format || !(EXERCISE_IMAGE_INPUT_FORMATS as readonly string[]).includes(format)) {
        return { rejection: 'unsupported_format' as const };
      }
      if (!meta.width || !meta.height) return { rejection: 'unreadable' as const };
      if (meta.width * meta.height > EXERCISE_IMAGE_MAX_PIXELS) return { rejection: 'too_many_pixels' as const };

      // `.rotate()` with no argument applies the EXIF orientation first, so a
      // portrait phone photo is fitted upright rather than sideways.
      const image = await sharp(input, { limitInputPixels: EXERCISE_IMAGE_MAX_PIXELS, failOn: 'error' })
        .rotate()
        .resize(EXERCISE_GENDER_IMAGE_MASTER_SIZE, EXERCISE_GENDER_IMAGE_MASTER_SIZE, {
          fit: 'contain',
          position: 'centre',
          background: TRANSPARENT,
        })
        .ensureAlpha()
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      const thumbnail = await sharp(image)
        .resize(EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE, EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE, {
          fit: 'contain',
          background: TRANSPARENT,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();

      // Never report success for a file that is not what the convention says.
      if (
        !hasExactSize(image, EXERCISE_GENDER_IMAGE_MASTER_SIZE) ||
        !hasExactSize(thumbnail, EXERCISE_GENDER_IMAGE_THUMBNAIL_SIZE)
      ) {
        return { rejection: 'unreadable' as const };
      }
      return { image, thumbnail };
    } catch (err: any) {
      if (/pixel limit/i.test(String(err?.message))) return { rejection: 'too_many_pixels' as const };
      return { rejection: 'unreadable' as const };
    }
  });
}
