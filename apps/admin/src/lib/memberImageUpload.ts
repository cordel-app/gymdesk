/**
 * #1374 — what the browser does to a picked file before `POST /members/:id/image`.
 *
 * The server accepts exactly one shape — a 512 × 512 PNG, validated from the
 * bytes (`api/src/domain/memberImages.ts`) — and staff pick whatever photograph
 * they have: a portrait JPEG off a phone, a WebP from a website. So the browser
 * decodes it, centre-crops it to its largest square and scales it to 512 × 512
 * as a PNG, through the app's one canvas helper (`makeThumbnail`, #719) rather
 * than a second drawer. Nothing here talks to the API: the result is a `Blob`
 * the caller uploads, or a problem the caller renders as a locale key.
 *
 * The browser's checks exist to give a clear error *before* the upload, never
 * instead of it: the server re-reads the signature and the dimensions.
 */
import { makeThumbnail, readImageDimensions } from './exerciseImageUpload';

/** The one size a Member's image is stored at — the server's `MEMBER_IMAGE_SIZE`. */
export const MEMBER_IMAGE_SIZE = 512;

/** What the picker offers: any raster the browser can decode. */
export const MEMBER_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** Why a picked file could not be prepared — each is a key in the `members` namespace. */
export type MemberImageProblem = 'image_error_not_image' | 'image_error_unreadable';

/**
 * A 512 × 512 PNG `Blob` built from `file`, or the reason there is none.
 *
 * The decode is attempted whatever the file's declared type says, since the
 * type is the picker's word and a `.jpg` renamed `.png` still decodes; a file
 * that is not an image at all simply fails to decode and reads as unreadable.
 */
export async function prepareMemberImage(file: File): Promise<Blob | MemberImageProblem> {
  if (!file.type.startsWith('image/')) return 'image_error_not_image';
  const dimensions = await readImageDimensions(file);
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) return 'image_error_unreadable';
  const prepared = await makeThumbnail(file, MEMBER_IMAGE_SIZE, { cropToSquare: true });
  return prepared ?? 'image_error_unreadable';
}

export function isPreparedMemberImage(value: Blob | MemberImageProblem): value is Blob {
  return typeof value !== 'string';
}
