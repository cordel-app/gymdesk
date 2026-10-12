/**
 * #1449 — what the browser does to a picked file before `POST /members/:id/image`:
 * **nothing but check it**. The server makes the 1080 × 1080 master and the
 * 256 × 256 thumbnail (both WebP) from the one original it is sent
 * (`api/src/domain/memberImageProcessing.ts`), so the browser neither crops, nor
 * scales, nor encodes. Its checks exist to give a clear error *before* a large
 * upload, never instead of the server's: the server re-reads the bytes.
 *
 * Nothing here talks to the API: the result is the `File` the caller uploads, or
 * a problem the caller renders as a locale key.
 */

/** What the picker offers — the formats the server decodes (HEIC arrives as a JPEG from iOS). */
export const MEMBER_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

/**
 * The largest file the picker lets through, in megabytes — the API's
 * `MEMBER_IMAGE_MAX_MB` default. Keep `NEXT_PUBLIC_MEMBER_IMAGE_MAX_MB` in step
 * with it when a deployment changes it.
 */
export function memberImageMaxMb(): number {
  const raw = Number(process.env.NEXT_PUBLIC_MEMBER_IMAGE_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 25) : 10;
}

/** Why a picked file was not sent — each is a key in the `members` namespace. */
export type MemberImageProblem = 'image_error_not_image' | 'image_error_too_large';

/** `file` as it is, or the reason it should not be uploaded. */
export async function prepareMemberImage(file: File): Promise<Blob | MemberImageProblem> {
  if (!file.type.startsWith('image/')) return 'image_error_not_image';
  if (file.size > memberImageMaxMb() * 1024 * 1024) return 'image_error_too_large';
  return file;
}

export function isPreparedMemberImage(value: Blob | MemberImageProblem): value is Blob {
  return typeof value !== 'string';
}
