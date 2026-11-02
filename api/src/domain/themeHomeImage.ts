// #2287: a Theme's Home Image — the banner background of the Admin Home
// Dashboard. Stored as `<theme folder>/home/home.webp`, 1080 x 1080, no thumbnail.

import { buildStorageObjectUrl } from '../infra/storage';
import { processMemberImage } from './memberImageProcessing';
import type { MemberImageRejection } from './memberImages';
import { buildThemeFolderPrefix } from './themeFolders';

export const THEME_HOME_FOLDER = 'home';
export const HOME_IMAGE_FILE = 'home.webp';

/** The one key a theme's Home Image is stored under; the extension is fixed (always WebP). */
export function buildThemeHomeImageKey(folderPrefix: string, themeId: string, themeName: string): string {
  return `${buildThemeFolderPrefix(folderPrefix, themeId, themeName)}/${THEME_HOME_FOLDER}/${HOME_IMAGE_FILE}`;
}

/** Judged from the decoded bytes; the 1080 x 1080 master is the member-photo pipeline's, the thumbnail is dropped. */
export async function processHomeImage(input: Buffer): Promise<{ image: Buffer } | { rejection: MemberImageRejection }> {
  const out = await processMemberImage(input);
  return 'rejection' in out ? out : { image: out.image };
}

/** Public URL, cache-busted by the row's `modified_at` (the key is deterministic). */
export function themeHomeImageUrl(
  row: { home_image_object_key?: string | null; modified_at?: Date | string | null },
): string | null {
  const url = buildStorageObjectUrl(row.home_image_object_key);
  if (!url) return null;
  const at = row.modified_at ? new Date(row.modified_at).getTime() : NaN;
  return Number.isNaN(at) ? url : `${url}?v=${at}`;
}
