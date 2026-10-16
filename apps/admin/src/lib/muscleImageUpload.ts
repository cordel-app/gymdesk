/**
 * #1413 — what the browser does to a picked file before
 * `POST /platform/muscles/:id/image/:sex`: **nothing but check it**. The server
 * orients the picture, centre-crops it to a 1080 × 1080 square and encodes
 * the WebP master and its 256 × 256 thumbnail
 * (`api/src/domain/muscleImageProcessing.ts`), so no browser crops, scales or
 * encodes anything — what a user's browser can encode never decides the result.
 * The checks here only give a clear error before a large upload; the server
 * re-reads the bytes.
 */

/** What the picker offers — the formats the server decodes. */
export const MUSCLE_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

/**
 * The largest file the picker lets through, in megabytes — the API's
 * `MUSCLE_IMAGE_MAX_MB` default. Keep `NEXT_PUBLIC_MUSCLE_IMAGE_MAX_MB` in step
 * with it when a deployment changes it.
 */
export function muscleImageMaxMb(): number {
  const raw = Number(process.env.NEXT_PUBLIC_MUSCLE_IMAGE_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 25) : 10;
}

/** Why a picked file was not sent — each is a key in the `muscles_page` namespace. */
export type MuscleImageProblem = 'image_error_not_image' | 'image_error_too_large';

/** `file` as it is, or the reason it should not be uploaded. */
export function prepareMuscleImage(file: File): Blob | MuscleImageProblem {
  if (!file.type.startsWith('image/')) return 'image_error_not_image';
  if (file.size > muscleImageMaxMb() * 1024 * 1024) return 'image_error_too_large';
  return file;
}

export function isPreparedMuscleImage(value: Blob | MuscleImageProblem): value is Blob {
  return typeof value !== 'string';
}
