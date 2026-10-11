// Preparing a muscle image for `POST /platform/muscles/:id/image/:sex` (#1412).
//
// The browser produces both files (no server-side image library, #719 Q2): the
// picked raster is fitted inside a 1080x1080 transparent square without
// distortion, and the 256x256 thumbnail is drawn from that master. Both are
// encoded as WebP. The server repeats every check from the bytes
// (`domain/muscleImages.ts`), so this exists to fail early and clearly; the one
// rule only it can keep is that nothing is sent unless both files were produced.

import { blobToBase64, readImageDimensions } from './exerciseImageUpload';

export const MUSCLE_IMAGE_MASTER_SIZE = 1080;
export const MUSCLE_IMAGE_THUMBNAIL_SIZE = 256;
const WEBP_QUALITY = 0.92;

export type MuscleImageProblem = 'unreadable' | 'encode_failed';

export interface PreparedMuscleImage {
  image: string;
  thumbnail: string;
}

async function drawSquareWebp(source: CanvasImageSource, width: number, height: number, size: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Contain: scale to fit, centre, leave the rest transparent.
  const scale = Math.min(size / width, size / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  ctx.drawImage(source, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
  // A browser that cannot encode WebP silently returns a PNG: refuse that.
  return blob && blob.type === 'image/webp' ? blob : null;
}

export async function prepareMuscleImage(file: File): Promise<PreparedMuscleImage | MuscleImageProblem> {
  const dimensions = await readImageDimensions(file);
  if (!dimensions) return 'unreadable';
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return 'unreadable';
    const master = await drawSquareWebp(img, dimensions.width, dimensions.height, MUSCLE_IMAGE_MASTER_SIZE);
    if (!master) return 'encode_failed';
    const masterBitmap = await createImageBitmap(master);
    const thumb = await drawSquareWebp(masterBitmap, MUSCLE_IMAGE_MASTER_SIZE, MUSCLE_IMAGE_MASTER_SIZE, MUSCLE_IMAGE_THUMBNAIL_SIZE);
    if (!thumb) return 'encode_failed';
    const [image, thumbnail] = await Promise.all([blobToBase64(master), blobToBase64(thumb)]);
    return { image, thumbnail };
  } catch {
    return 'encode_failed';
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isPreparedMuscleImage(r: PreparedMuscleImage | MuscleImageProblem): r is PreparedMuscleImage {
  return typeof r !== 'string';
}
