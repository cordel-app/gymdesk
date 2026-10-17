/**
 * #1714 — what the browser does to a picked file before
 * `POST /activity-types/:id/image` (and an event's): **nothing but check it**.
 * The server makes the 1080 × 1080 WebP master and the 256 × 256 thumbnail from
 * the one original it is sent (`api/src/domain/memberImageProcessing.ts`), as it
 * does for a Member's photo (#1449), so the browser neither crops, scales nor
 * encodes. The checks only give a clear error before a large upload.
 */
import { memberImageMaxMb } from './memberImageUpload';

export const ACTIVITY_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

export type ActivityImageProblem = 'image_error_not_image' | 'image_error_unreadable';

/** `file` as it is, or the reason it should not be uploaded. */
export async function prepareActivityImage(file: File): Promise<Blob | ActivityImageProblem> {
  if (!file.type.startsWith('image/')) return 'image_error_not_image';
  if (file.size > memberImageMaxMb() * 1024 * 1024) return 'image_error_unreadable';
  return file;
}

export function isPreparedActivityImage(value: Blob | ActivityImageProblem): value is Blob {
  return typeof value !== 'string';
}
