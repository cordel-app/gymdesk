/**
 * #1449 — what the Members App does to a picked photo before
 * `POST /me/profile/image`: **nothing but check it**. The server orients it,
 * centre-crops it and makes the 1080 × 1080 master and the 256 × 256 thumbnail
 * (both WebP) from the one original (`api/src/domain/memberImageProcessing.ts`),
 * so a member's phone photo is sent as it is. Pure of React and of `t()`: the
 * result is the file the page uploads, or a problem the page renders as a locale
 * key. The admin has the same helper (`apps/admin/src/lib/memberImageUpload.ts`);
 * the two apps share no frontend module.
 *
 * No plugin is involved: `<input type="file" accept="image/*">` opens the system
 * picker in the native shell as it does in a browser (#1073's rule — nothing
 * native is reached outside `lib/nativePlugins.ts`, and nothing is needed here).
 * iOS hands the web view a JPEG for a HEIC picked from Photos.
 */

/** What the picker offers: any raster; the server judges the decoded bytes. */
export const MEMBER_IMAGE_ACCEPT = 'image/*';

/** The largest file sent, in megabytes — the API's `MEMBER_IMAGE_MAX_MB` default. */
export function memberImageMaxMb(): number {
  const raw = Number(process.env.NEXT_PUBLIC_MEMBER_IMAGE_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 25) : 10;
}

/** Why a picked file was not sent — each is a key in the `profile` namespace. */
export type MemberImageProblem = 'photo_error_not_image' | 'photo_error_too_large';

export function isPreparedMemberImage(value: Blob | MemberImageProblem): value is Blob {
  return typeof value !== 'string';
}

/** `file` as it is, or the reason it should not be uploaded. */
export async function prepareMemberImage(file: File): Promise<Blob | MemberImageProblem> {
  if (!file.type.startsWith('image/')) return 'photo_error_not_image';
  if (file.size > memberImageMaxMb() * 1024 * 1024) return 'photo_error_too_large';
  return file;
}
