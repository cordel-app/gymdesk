// #1449 — what the **server** does to the one picture a client sends: orient it,
// centre-crop it to a square and encode the two WebP files a Member's profile
// image is stored as (1080 × 1080 and 256 × 256).
//
// Everything is in memory. The original arrives as a buffer, both outputs leave
// as buffers and nothing touches the disk, so there is no temporary file to
// clean up and the only copy that survives is the pair uploaded to R2.
//
// The input is judged from its **decoded bytes** (`sharp`'s own format
// detection), never from the `Content-Type` header or the file name, and the
// outputs carry no metadata: `sharp` drops EXIF/XMP/ICC unless asked to keep
// them, which is what removes a photo's GPS location.
//
// `sharp` is in the API image for two features: this one and the exercise media
// (`exerciseImageProcessing.ts`, #1420), which shares the process-wide
// concurrency bound in `imageProcessingSlot.ts`.

import sharp from 'sharp';
import { withImageProcessingSlot } from './imageProcessingSlot';
import {
  MEMBER_IMAGE_INPUT_FORMATS,
  MEMBER_IMAGE_MAX_PIXELS,
  MEMBER_IMAGE_SIZE,
  MEMBER_IMAGE_THUMBNAIL_SIZE,
  type MemberImageRejection,
} from './memberImages';

export interface ProcessedMemberImage {
  /** 1080 × 1080 WebP. */
  image: Buffer;
  /** 256 × 256 WebP, made from the cropped master. */
  thumbnail: Buffer;
}

const WEBP_QUALITY = 82;

/** The two WebP files for `input`, or why there are none. */
export async function processMemberImage(
  input: Buffer,
): Promise<ProcessedMemberImage | { rejection: MemberImageRejection }> {
  return withImageProcessingSlot(async () => {
    try {
      const probe = sharp(input, { limitInputPixels: MEMBER_IMAGE_MAX_PIXELS, failOn: 'error' });
      const meta = await probe.metadata();
      const format = meta.format as string | undefined;
      if (!format || !(MEMBER_IMAGE_INPUT_FORMATS as readonly string[]).includes(format)) {
        return { rejection: 'unsupported_format' as const };
      }
      if (!meta.width || !meta.height) return { rejection: 'unreadable' as const };
      if (meta.width * meta.height > MEMBER_IMAGE_MAX_PIXELS) return { rejection: 'too_many_pixels' as const };

      // `.rotate()` with no argument applies the EXIF orientation first, so a
      // portrait phone photo is cropped upright rather than sideways.
      const image = await sharp(input, { limitInputPixels: MEMBER_IMAGE_MAX_PIXELS, failOn: 'error' })
        .rotate()
        .resize(MEMBER_IMAGE_SIZE, MEMBER_IMAGE_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      const thumbnail = await sharp(image)
        .resize(MEMBER_IMAGE_THUMBNAIL_SIZE, MEMBER_IMAGE_THUMBNAIL_SIZE, { fit: 'cover' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return { image, thumbnail };
    } catch (err: any) {
      if (/pixel limit/i.test(String(err?.message))) return { rejection: 'too_many_pixels' as const };
      return { rejection: 'unreadable' as const };
    }
  });
}
