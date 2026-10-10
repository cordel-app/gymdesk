/**
 * #1375 — what the Members App does to a picked photo before
 * `POST /me/profile/image`.
 *
 * The API accepts exactly one shape — a 512 × 512 PNG, validated from the bytes
 * (`api/src/domain/memberImages.ts`) — and a member picks whatever their phone
 * has: a portrait JPEG, a HEIC the browser has already converted. So the
 * browser decodes it, centre-crops it to its largest square and scales it to
 * 512 × 512 as a PNG. Pure of React and of `t()`: the result is a `Blob` the
 * page uploads, or a problem the page renders as a locale key. The admin has
 * the same helper (`apps/admin/src/lib/memberImageUpload.ts`); the two apps
 * share no frontend module, and `api/src/test/member-profile-photo.unit.test.ts`
 * holds the two sizes equal.
 *
 * No plugin is involved: `<input type="file" accept="image/*">` opens the
 * system picker in the native shell as it does in a browser (#1073's rule —
 * nothing native is reached outside `lib/nativePlugins.ts`, and nothing is
 * needed here).
 */

/** The one size a member's photo is stored at — the API's `MEMBER_IMAGE_SIZE`. */
export const MEMBER_IMAGE_SIZE = 512;

/** What the picker offers: any raster the browser can decode. */
export const MEMBER_IMAGE_ACCEPT = 'image/*';

/** Why a picked file could not be prepared — each is a key in the `profile` namespace. */
export type MemberImageProblem = 'photo_error_not_image' | 'photo_error_unreadable';

export function isPreparedMemberImage(value: Blob | MemberImageProblem): value is Blob {
  return typeof value !== 'string';
}

async function decodeImage(file: Blob): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    // Revoked after `onload`: the decoded bitmap is already the element's own.
    URL.revokeObjectURL(url);
  }
}

/**
 * A 512 × 512 PNG `Blob` built from `file`, or the reason there is none.
 *
 * The decode is attempted whatever the file's declared type says (the type is
 * the picker's word); a file that is not an image simply fails to decode. The
 * crop is the largest centred square, so a portrait photo keeps its middle
 * rather than being squashed.
 */
export async function prepareMemberImage(file: File): Promise<Blob | MemberImageProblem> {
  if (!file.type.startsWith('image/')) return 'photo_error_not_image';
  const image = await decodeImage(file);
  if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) return 'photo_error_unreadable';
  const canvas = document.createElement('canvas');
  canvas.width = MEMBER_IMAGE_SIZE;
  canvas.height = MEMBER_IMAGE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'photo_error_unreadable';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = Math.floor((image.naturalWidth - side) / 2);
  const sy = Math.floor((image.naturalHeight - side) / 2);
  ctx.drawImage(image, sx, sy, side, side, 0, 0, MEMBER_IMAGE_SIZE, MEMBER_IMAGE_SIZE);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ?? 'photo_error_unreadable';
}
