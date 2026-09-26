// How an exercise media sweep tells two references to the same object apart
// from two different objects.
//
// A stored media URL comes in two forms for one object: the public origin
// (`CLOUDFLARE_R2_PUBLIC_URL`) that new rows get, and the private
// `endpoint + bucket` composition that rows written before it still hold.
// Comparing the strings would call them two objects. The sweep would then
// delete an object it just re-uploaded under the same key, or miss another
// row that still points at it. Both helpers here compare the *object* instead.

import { storageKeyFromObjectUrl, storageObjectUrlForms } from '../infra/storage';

/** The four exercise columns that hold a media reference. */
const MEDIA_COLUMNS = ['image_url', 'image_thumbnail_url', 'video_url', 'video_thumbnail_url'] as const;

/**
 * What a media URL points at: its object key when this deployment built the
 * URL, in either form, and the URL itself otherwise (an external link, another
 * deployment's object). Two URLs with the same identity name the same thing.
 */
export function mediaIdentity(url: string): string {
  return storageKeyFromObjectUrl(url) ?? url;
}

/**
 * Every string a row may hold for the object `url` names: all URL forms of its
 * key, or just `url` when it is not ours.
 */
export function mediaUrlForms(url: string): string[] {
  const key = storageKeyFromObjectUrl(url);
  if (!key) return [url];
  const forms = storageObjectUrlForms(key);
  return forms.includes(url) ? forms : [url, ...forms];
}

/**
 * A SQL condition true for any row that references the object `url` names,
 * through any of the four media columns and in any URL form, with its
 * parameters. Placeholders are spelled out because `db.query` runs prepared
 * statements, which do not expand an array into `IN (?)`.
 */
export function mediaReferenceClause(url: string): { clause: string; params: string[] } {
  const forms = mediaUrlForms(url);
  const placeholders = forms.map(() => '?').join(', ');
  const clause = `(${MEDIA_COLUMNS.map((column) => `${column} IN (${placeholders})`).join(' OR ')})`;
  const params = MEDIA_COLUMNS.flatMap(() => forms);
  return { clause, params };
}
