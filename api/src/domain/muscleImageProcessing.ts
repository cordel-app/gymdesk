// What the **server** does to the one picture a client sends for a muscle
// (#1413): orient it, centre-crop it to a 1080 × 1080 square without
// distortion, and encode the two WebP files a muscle image is stored as (the
// 1080 master and the 256 × 256 thumbnail drawn from that master).
//
// Since the #1527 follow-up a muscle image is centre-cropped like an exercise
// image, by the owner's choice: #1413 contained it with transparent padding, and
// My Training — where a muscle image stands in for an exercise with none of its
// own — showed that padding as a grey band at the card's edge. Everything is in memory (no temporary file), the
// input is judged from its decoded bytes and the outputs carry no metadata —
// `memberImageProcessing.ts`'s rules, sharing its decode slots so one burst of
// uploads cannot starve the rest of the API.

import sharp from 'sharp';
import {
  MEMBER_IMAGE_INPUT_FORMATS,
  MEMBER_IMAGE_MAX_PIXELS,
  type MemberImageRejection,
} from './memberImages';
import { withImageProcessingSlot } from './imageProcessingSlot';
import { MUSCLE_IMAGE_MASTER_SIZE, MUSCLE_IMAGE_THUMBNAIL_SIZE } from './muscleImages';

export interface ProcessedMuscleImage {
  /** 1080 × 1080 WebP. */
  image: Buffer;
  /** 256 × 256 WebP, made from the processed master. */
  thumbnail: Buffer;
}

const WEBP_QUALITY = 82;

/** The two WebP files for `input`, or why there are none. */
export async function processMuscleImage(
  input: Buffer,
): Promise<ProcessedMuscleImage | { rejection: MemberImageRejection }> {
  return withImageProcessingSlot(async () => {
    try {
      const options = { limitInputPixels: MEMBER_IMAGE_MAX_PIXELS, failOn: 'error' as const };
      const meta = await sharp(input, options).metadata();
      const format = meta.format as string | undefined;
      if (!format || !(MEMBER_IMAGE_INPUT_FORMATS as readonly string[]).includes(format)) {
        return { rejection: 'unsupported_format' as const };
      }
      if (!meta.width || !meta.height) return { rejection: 'unreadable' as const };
      if (meta.width * meta.height > MEMBER_IMAGE_MAX_PIXELS) return { rejection: 'too_many_pixels' as const };

      const image = await sharp(input, options)
        .rotate()
        .resize(MUSCLE_IMAGE_MASTER_SIZE, MUSCLE_IMAGE_MASTER_SIZE, { fit: 'cover' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      const thumbnail = await sharp(image)
        .resize(MUSCLE_IMAGE_THUMBNAIL_SIZE, MUSCLE_IMAGE_THUMBNAIL_SIZE, { fit: 'cover' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return { image, thumbnail };
    } catch (err: any) {
      if (/pixel limit/i.test(String(err?.message))) return { rejection: 'too_many_pixels' as const };
      return { rejection: 'unreadable' as const };
    }
  });
}
