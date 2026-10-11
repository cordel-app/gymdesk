/**
 * #1373 — what the browser does to a picked file before
 * `POST /activity-types/:id/image`.
 *
 * The server accepts exactly one shape — a 1080 × 1080 PNG, validated from the
 * bytes (`api/src/domain/activityImages.ts`) — and staff pick whatever picture
 * they have. So the browser decodes it, centre-crops it to its largest square
 * and scales it to 1080 × 1080 as a PNG through the app's one canvas helper
 * (`makeThumbnail`), the arrangement `memberImageUpload.ts` (#1374) uses.
 */
import { makeThumbnail, readImageDimensions } from './exerciseImageUpload';

/** The one size an Activity Type's image is stored at — the server's `ACTIVITY_IMAGE_SIZE`. */
export const ACTIVITY_IMAGE_SIZE = 1080;

export const ACTIVITY_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export type ActivityImageProblem = 'image_error_not_image' | 'image_error_unreadable';

export async function prepareActivityImage(file: File): Promise<Blob | ActivityImageProblem> {
  if (!file.type.startsWith('image/')) return 'image_error_not_image';
  const dimensions = await readImageDimensions(file);
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) return 'image_error_unreadable';
  const prepared = await makeThumbnail(file, ACTIVITY_IMAGE_SIZE, { cropToSquare: true });
  return prepared ?? 'image_error_unreadable';
}

export function isPreparedActivityImage(value: Blob | ActivityImageProblem): value is Blob {
  return typeof value !== 'string';
}
