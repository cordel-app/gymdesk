// What cloning a Theme has to copy, and where each copy goes (#1041).
//
// Pure: the router owns the bucket calls, the rows and the tenant checks, and
// this module owns the *plan* — which of the source theme's assets exist, and
// the key each one takes inside the clone's own folder. One place, so "every
// asset belonging to the theme" is a single list rather than a decision each
// caller takes again.
//
// The one property that makes §5 ("do not limit the implementation to the seven
// currently known Members App images… avoid unnecessary hard-coded special
// cases for individual filenames") true is that nothing here names a file. A
// Members background is planned from the *row* the source theme has, and its
// destination key comes from `buildThemeMemberImageKey()`, so a slot added to
// `MEMBER_IMAGE_SLOTS` later is copied by this module with no change at all —
// the slot list and the key builders stay the only places a theme asset's
// location is decided (#725, #824).

import { buildThemeLogoKey } from './themeLogo';
import {
  buildThemeMemberImageKey,
  isMemberImageSlot,
  MEMBER_IMAGE_SLOTS,
  type MemberImageSlot,
} from './themeMemberImages';

/** The two kinds of asset a theme owns, as a failure response names them. */
export type ThemeAssetKind = 'logo' | 'members_image';

/**
 * Where the bytes of one planned copy come from.
 *
 *  - `object` — an object in the bucket, copied server-side.
 *  - `blob` — a `themes.logo_bytes` logo, which is not in the bucket at all:
 *    a Base Theme's from before #829, or a Custom Theme's from before migration
 *    180. It is *uploaded* into the clone's own key instead, which is also what
 *    makes the clone's logo an R2 object even when its source's never was —
 *    `logo_bytes` has had no writer since #829 and may not gain one, so the
 *    copy can only ever go the other way.
 */
export type ThemeAssetOrigin = { from: 'object'; key: string } | { from: 'blob' };

export interface PlannedThemeAssetCopy {
  kind: ThemeAssetKind;
  /** The slot, for a Members background; `null` for the logo. */
  slot: MemberImageSlot | null;
  origin: ThemeAssetOrigin;
  /** The key inside the clone's own folder. Never shared with the source. */
  destKey: string;
  /** The MIME type the copy is stored as. `null` for a server-side copy, which carries the source's own. */
  mime: string | null;
}

/** The source theme's assets, as the router reads them. */
export interface ThemeAssetSource {
  /** `themes.logo_object_key` — null for a blob-backed logo or none at all. */
  logoObjectKey: string | null;
  /** `themes.logo_mime` — the type the logo was validated as, and the clone's extension. */
  logoMime: string | null;
  /** Whether `themes.logo_bytes` holds a legacy blob. */
  hasLogoBytes: boolean;
  /** The source's `theme_member_images` rows: the gym's own, or the platform's for a Base Theme. */
  memberImages: readonly { slot: string; object_key: string }[];
}

/** The clone: its folder root (the gym's prefix), its id and its name. */
export interface ThemeAssetDestination {
  folderPrefix: string;
  themeId: string;
  themeName: string;
}

/**
 * Every copy a clone of `source` needs, logo first and then one per configured
 * Members slot, in `MEMBER_IMAGE_SLOTS` order so a partial failure is
 * reproducible rather than dependent on row order.
 *
 * Three things it refuses to invent (§4: *"if an optional asset does not exist
 * on the source theme, do not create an artificial empty file"*):
 *
 *  - a logo the source does not have — no key, no blob, nothing planned;
 *  - a logo with no `logo_mime`, which has no extension to be stored under and
 *    so no key this codebase could build (`buildThemeLogoKey()` takes the
 *    validated MIME, never a file name);
 *  - a slot with no row. The row, not the object, is what makes a slot
 *    configured (#725), so a slot the source removed is not copied and the
 *    clone reads `null` for it exactly as the source does.
 *
 * A row whose `slot` is not one this build knows is skipped rather than guessed
 * at: it can only come from a future migration, and there is no key builder for
 * it here.
 */
export function planThemeAssetCopies(
  source: ThemeAssetSource,
  dest: ThemeAssetDestination,
): PlannedThemeAssetCopy[] {
  const copies: PlannedThemeAssetCopy[] = [];

  if (source.logoMime && (source.logoObjectKey || source.hasLogoBytes)) {
    copies.push({
      kind: 'logo',
      slot: null,
      origin: source.logoObjectKey ? { from: 'object', key: source.logoObjectKey } : { from: 'blob' },
      destKey: buildThemeLogoKey(dest.folderPrefix, dest.themeId, dest.themeName, source.logoMime),
      mime: source.logoMime,
    });
  }

  const bySlot = new Map<string, string>();
  for (const row of source.memberImages) {
    if (!isMemberImageSlot(row.slot) || !row.object_key) continue;
    bySlot.set(row.slot, row.object_key);
  }
  for (const slot of MEMBER_IMAGE_SLOTS) {
    const key = bySlot.get(slot);
    if (!key) continue;
    copies.push({
      kind: 'members_image',
      slot,
      origin: { from: 'object', key },
      destKey: buildThemeMemberImageKey(dest.folderPrefix, dest.themeId, dest.themeName, slot),
      mime: null,
    });
  }

  return copies;
}

/**
 * The `theme_member_images` rows a successful clone writes: one per copied
 * background, keyed to the clone's own key.
 *
 * Separate from the plan so the router never derives a row from anything but a
 * copy that actually happened — §9's whole point is that the clone's references
 * are the *new* keys, and a row written from the plan rather than from the
 * result could point at an object that was never stored.
 */
export function clonedMemberImageRows(
  copies: readonly PlannedThemeAssetCopy[],
): { slot: MemberImageSlot; objectKey: string }[] {
  return copies
    .filter((copy): copy is PlannedThemeAssetCopy & { slot: MemberImageSlot } => copy.kind === 'members_image' && copy.slot !== null)
    .map((copy) => ({ slot: copy.slot, objectKey: copy.destKey }));
}

/** The logo copy of a plan, or null when the source has no logo to clone. */
export function clonedLogo(
  copies: readonly PlannedThemeAssetCopy[],
): { objectKey: string; mime: string } | null {
  const logo = copies.find((copy) => copy.kind === 'logo');
  if (!logo || !logo.mime) return null;
  return { objectKey: logo.destKey, mime: logo.mime };
}

/**
 * Which step a failed copy reports as its `stage` (#824's diagnostic), so the
 * admin reads *Copy logo* / *Copy Members image* rather than a bare message.
 * The two values are `STORAGE_FAILURE_STAGES`' own; this is the mapping from
 * the asset to them, which is this module's to know.
 */
export function copyStageFor(copy: PlannedThemeAssetCopy): 'copy_logo' | 'copy_members_image' {
  return copy.kind === 'logo' ? 'copy_logo' : 'copy_members_image';
}
