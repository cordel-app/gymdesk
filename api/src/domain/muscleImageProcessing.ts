// What the **server** does to the one picture a client sends for a muscle
// (#1413): orient it, fit it inside a 1080 × 1080 transparent square without
// distortion or cropping, and encode the two WebP files a muscle image is stored
// as (the 1080 master and the 256 × 256 thumbnail drawn from that master).
//
// A muscle image is an anatomical figure, so unlike a Member's photo it is
// *contained*, never centre-cropped: nothing of the figure may be cut off, and
// the padding is transparent. Everything is in memory (no temporary file), the
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
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

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
        .resize(MUSCLE_IMAGE_MASTER_SIZE, MUSCLE_IMAGE_MASTER_SIZE, { fit: 'contain', background: TRANSPARENT })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      const thumbnail = await sharp(image)
        .resize(MUSCLE_IMAGE_THUMBNAIL_SIZE, MUSCLE_IMAGE_THUMBNAIL_SIZE, { fit: 'contain', background: TRANSPARENT })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return { image, thumbnail };
    } catch (err: any) {
      if (/pixel limit/i.test(String(err?.message))) return { rejection: 'too_many_pixels' as const };
      return { rejection: 'unreadable' as const };
    }
  });
}
