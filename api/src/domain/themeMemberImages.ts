// The six Members App background images a Custom Theme can carry (#725).
//
// Everything here is pure: the slot list, the deterministic object keys and the
// shape the API returns. The router owns the uploads, the rows and the tenant
// checks — this file owns *where an image goes* and *what a client is told*, so
// both are decided in one place and can be unit-tested without a database.

import { buildStorageObjectUrl, sanitizeStorageFolderName } from '../infra/storage';

/**
 * #725: six fixed slots, each mapped to one Members section, and nothing else —
 * "additional Members image types beyond the six defined above" is explicitly
 * out of scope, which is why this list is also the migration-181 CHECK.
 */
export const MEMBER_IMAGE_SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'background', 'membership'] as const;

export type MemberImageSlot = (typeof MEMBER_IMAGE_SLOTS)[number];

export function isMemberImageSlot(value: unknown): value is MemberImageSlot {
  return typeof value === 'string' && (MEMBER_IMAGE_SLOTS as readonly string[]).includes(value);
}

/** `Members` — the leaf folder of a theme's own folder that holds these six. */
export const THEME_MEMBERS_FOLDER = 'Members';

/** `Themes` — the gym-folder branch every Custom Theme's folder hangs off. */
export const THEME_STORAGE_FOLDER = 'Themes';

/**
 * `<folderPrefix>/Themes/<theme_id>-<sanitized theme name>` — the folder that
 * belongs to one Custom Theme. The id leads, so two themes of the same gym can
 * share a name (they cannot, but a renamed one can collide with a deleted one)
 * without ever sharing a folder, and `sanitizeStorageFolderName()` is the same
 * sanitizer the gym folder itself is built with, so one rule governs the whole
 * tree.
 */
export function buildThemeFolderPrefix(folderPrefix: string, themeId: string, themeName: string): string {
  return `${folderPrefix}/${THEME_STORAGE_FOLDER}/${themeId}-${sanitizeStorageFolderName(themeName)}`;
}

/**
 * The one key a slot's image is stored under:
 * `<folderPrefix>/Themes/<theme_id>-<name>/Members/<slot>.png`.
 *
 * The extension is part of the slot's *fixed name*, not a claim about the
 * bytes: #725 is explicit that `my-training.jpg`, `training-final.png` and
 * `awesome-training-image.webp` must all land on `Members/training.png`. The
 * uploaded file name never reaches the key, and the object's `Content-Type` is
 * the MIME the server validated — which is what a browser reads. Keeping one
 * key per slot regardless of type is also what makes a replacement incapable of
 * orphaning anything: there is no `training.jpg` for a `training.png` to leave
 * behind.
 */
export function buildThemeMemberImageKey(
  folderPrefix: string,
  themeId: string,
  themeName: string,
  slot: MemberImageSlot,
): string {
  return `${buildThemeFolderPrefix(folderPrefix, themeId, themeName)}/${THEME_MEMBERS_FOLDER}/${slot}.png`;
}

/**
 * Every folder marker between the gym root and a theme's `Members/`, outermost
 * first — what #725 means by *"automatically create the complete missing folder
 * structure"*. R2 has no directories, so these are the zero-byte `…/` objects
 * `initializeGymBucket()` writes; re-writing one is idempotent and cannot
 * destroy a real object, because a key ending in `/` is never one.
 */
export function themeMemberFolderKeys(folderPrefix: string, themeId: string, themeName: string): string[] {
  const themeFolder = buildThemeFolderPrefix(folderPrefix, themeId, themeName);
  return [
    `${folderPrefix}/`,
    `${folderPrefix}/${THEME_STORAGE_FOLDER}/`,
    `${themeFolder}/`,
    `${themeFolder}/${THEME_MEMBERS_FOLDER}/`,
  ];
}

export interface MemberImageRow {
  slot: string;
  object_key: string;
  modified_at?: Date | string | null;
}

/** `{ training_url, nutrition_url, … }` — one field per slot, always all six. */
export type MemberImageUrls = Record<`${MemberImageSlot}_url`, string | null>;

/**
 * The Members image configuration of one theme, as every theme-shaped response
 * returns it.
 *
 * All six fields are always present: a slot with no row reads `null`, which
 * #725 defines as *"not currently configured"* — the Members App then uses the
 * theme background colour, and resolves nothing else. The row, not the object,
 * is what makes a slot configured, so a removed slot reads `null` even though
 * its object is still in the bucket.
 *
 * The key is deterministic, so replacing an image reuses its URL — hence the
 * `?v=` stamp from the row's `modified_at`, the same cache-buster
 * `themeLogoUrl()` carries.
 */
export function memberImageUrls(rows: MemberImageRow[]): MemberImageUrls {
  const urls = Object.fromEntries(
    MEMBER_IMAGE_SLOTS.map((slot) => [`${slot}_url`, null]),
  ) as MemberImageUrls;
  for (const row of rows) {
    if (!isMemberImageSlot(row.slot)) continue;
    const url = buildStorageObjectUrl(row.object_key);
    if (!url) continue;
    const updatedAt = row.modified_at ? new Date(row.modified_at).getTime() : NaN;
    urls[`${row.slot}_url`] = Number.isNaN(updatedAt) ? url : `${url}?v=${updatedAt}`;
  }
  return urls;
}

/** The empty configuration — six nulls. Used for a theme with no rows at all. */
export function emptyMemberImageUrls(): MemberImageUrls {
  return memberImageUrls([]);
}

// ─── Server-side validation (#725: "Images are validated server-side") ───────

/**
 * What a Members background may be. PNG is the format the slot's key is named
 * for; JPEG and WebP are accepted because #725's own example uploads them, and
 * a photographic background is what these slots are for.
 */
export const MEMBER_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * 4 MB. A Members background is a full-bleed photograph rather than a logo, so
 * the 512 KB the logo route enforces is too tight — but the bytes are still
 * buffered in the API process (`express.raw`), which is what keeps this bounded
 * rather than open-ended.
 */
export const MEMBER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Whether the bytes really are the type the request claims. The `Content-Type`
 * header is the client's word, and #725 requires the server to validate
 * independently, so the signature decides:
 *
 *  - PNG  — the 8-byte signature.
 *  - JPEG — `FF D8 FF`.
 *  - WebP — `RIFF....WEBP`.
 *
 * A renamed `.mp4`, a truncated upload and a file whose extension was changed
 * to dodge the picker all fail here, before anything reaches the bucket.
 */
export function bytesMatchImageMime(mime: string, body: Buffer): boolean {
  if (mime === 'image/png') {
    return body.length >= 8 && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mime === 'image/jpeg') {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (mime === 'image/webp') {
    return body.length >= 12
      && body.subarray(0, 4).toString('latin1') === 'RIFF'
      && body.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
}
