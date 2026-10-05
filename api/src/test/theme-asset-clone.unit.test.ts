// #1041: what cloning a Theme copies, and where each copy lands.
//
// Unit, not integration: `planThemeAssetCopies()` is pure — the router owns the
// bucket calls and the rows — so every rule the ticket states about *which*
// assets move and *which key* each one takes is assertable without a database.

import { describe, expect, it } from 'vitest';
import {
  clonedLogo,
  clonedMemberImageRows,
  copyStageFor,
  planThemeAssetCopies,
  type ThemeAssetSource,
} from '../domain/themeAssetClone';
import { MEMBER_IMAGE_SLOTS } from '../domain/themeMemberImages';
import { STORAGE_FAILURE_STAGES } from '../domain/storageFailureStage';

const DEST = { folderPrefix: 'gyms/g1-Acme', themeId: 'new-theme', themeName: 'Black copy' };
const SOURCE_PREFIX = 'gyms/g1-Acme/themes/src-theme-Black';

function source(overrides: Partial<ThemeAssetSource> = {}): ThemeAssetSource {
  return {
    logoObjectKey: null,
    logoMime: null,
    hasLogoBytes: false,
    memberImages: [],
    ...overrides,
  };
}

describe('planThemeAssetCopies (#1041 §4–§9)', () => {
  it('copies nothing for a theme that configured nothing', () => {
    expect(planThemeAssetCopies(source(), DEST)).toEqual([]);
  });

  it('copies the logo into the clone’s own folder, keyed by the validated MIME', () => {
    const copies = planThemeAssetCopies(
      source({ logoObjectKey: `${SOURCE_PREFIX}/logo/logo.png`, logoMime: 'image/png' }),
      DEST,
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].kind).toBe('logo');
    expect(copies[0].origin).toEqual({ from: 'object', key: `${SOURCE_PREFIX}/logo/logo.png` });
    // The clone's id and sanitized name — never the source's folder (§6/§12).
    expect(copies[0].destKey).toBe('gyms/g1-Acme/themes/new-theme-Blackcopy/logo/logo.png');
  });

  it('takes the extension from the stored MIME, not from the source key', () => {
    const copies = planThemeAssetCopies(
      // A pre-#824 key, under the retired gym-wide `Branding/Logo/` folder: the
      // clone still lands in its own theme folder, as `logo.svg`.
      source({ logoObjectKey: 'gyms/g1-Acme/Branding/Logo/logo.svg', logoMime: 'image/svg+xml' }),
      DEST,
    );
    expect(copies[0].destKey).toBe('gyms/g1-Acme/themes/new-theme-Blackcopy/logo/logo.svg');
  });

  it('plans an upload, not a copy, for a legacy `logo_bytes` logo', () => {
    const copies = planThemeAssetCopies(source({ hasLogoBytes: true, logoMime: 'image/png' }), DEST);
    expect(copies).toHaveLength(1);
    expect(copies[0].origin).toEqual({ from: 'blob' });
    expect(copies[0].mime).toBe('image/png');
  });

  it('prefers the object over the blob when a row carries both', () => {
    const copies = planThemeAssetCopies(
      source({ logoObjectKey: `${SOURCE_PREFIX}/logo/logo.png`, logoMime: 'image/png', hasLogoBytes: true }),
      DEST,
    );
    expect(copies[0].origin).toEqual({ from: 'object', key: `${SOURCE_PREFIX}/logo/logo.png` });
  });

  it('plans no logo when there is nothing to copy, and none without a MIME', () => {
    expect(planThemeAssetCopies(source({ logoMime: 'image/png' }), DEST)).toEqual([]);
    // A key with no `logo_mime` has no extension this codebase could build a
    // destination from — the uploaded file's name never reaches a key (#713).
    expect(planThemeAssetCopies(source({ logoObjectKey: `${SOURCE_PREFIX}/logo/logo.png` }), DEST)).toEqual([]);
  });

  it('copies one Members background per configured slot, and only those', () => {
    const copies = planThemeAssetCopies(
      source({
        memberImages: [
          { slot: 'nutrition', object_key: `${SOURCE_PREFIX}/members_app/nutrition.png` },
          { slot: 'training', object_key: `${SOURCE_PREFIX}/members_app/training.png` },
        ],
      }),
      DEST,
    );
    expect(copies.map((c) => c.slot)).toEqual(['training', 'nutrition']); // MEMBER_IMAGE_SLOTS order
    expect(copies.map((c) => c.destKey)).toEqual([
      'gyms/g1-Acme/themes/new-theme-Blackcopy/members_app/training.png',
      'gyms/g1-Acme/themes/new-theme-Blackcopy/members_app/nutrition.png',
    ]);
    // §4: an optional asset the source does not have produces no copy at all,
    // rather than an artificial empty file.
    expect(copies).toHaveLength(2);
  });

  it('is not hard-coded to a fixed list of file names (§5)', () => {
    // Every slot this build knows, whatever the list grows to: the plan is
    // driven by the source's rows and the key builder, so a slot added to
    // MEMBER_IMAGE_SLOTS later is copied with no change to this module.
    const copies = planThemeAssetCopies(
      source({
        memberImages: MEMBER_IMAGE_SLOTS.map((slot) => ({
          slot,
          object_key: `${SOURCE_PREFIX}/members_app/${slot}.png`,
        })),
      }),
      DEST,
    );
    expect(copies).toHaveLength(MEMBER_IMAGE_SLOTS.length);
    expect(copies.map((c) => c.slot)).toEqual([...MEMBER_IMAGE_SLOTS]);
    for (const copy of copies) {
      expect(copy.destKey).toBe(`gyms/g1-Acme/themes/new-theme-Blackcopy/members_app/${copy.slot}.png`);
    }
  });

  it('skips a slot this build does not know, and a row with no key', () => {
    const copies = planThemeAssetCopies(
      source({
        memberImages: [
          { slot: 'from_a_future_migration', object_key: `${SOURCE_PREFIX}/members_app/whatever.png` },
          { slot: 'training', object_key: '' },
        ],
      }),
      DEST,
    );
    expect(copies).toEqual([]);
  });

  it('never points a copy at the source folder (§7/§9/§13)', () => {
    const copies = planThemeAssetCopies(
      source({
        logoObjectKey: `${SOURCE_PREFIX}/logo/logo.png`,
        logoMime: 'image/png',
        memberImages: [{ slot: 'background', object_key: `${SOURCE_PREFIX}/members_app/background.png` }],
      }),
      DEST,
    );
    for (const copy of copies) {
      expect(copy.destKey).not.toContain('src-theme-Black');
      expect(copy.destKey.startsWith('gyms/g1-Acme/themes/new-theme-Blackcopy/')).toBe(true);
    }
  });

  it('copies a Base Theme’s platform objects into the gym’s own folder', () => {
    const copies = planThemeAssetCopies(
      source({
        logoObjectKey: 'cordel/themes/base-1-Crimson/logo/logo.png',
        logoMime: 'image/png',
        memberImages: [{ slot: 'bookings', object_key: 'cordel/themes/base-1-Crimson/members_app/bookings.png' }],
      }),
      DEST,
    );
    // Reading `cordel/` is how a gym gets a Base Theme's artwork; writing into
    // it is what §14 forbids, and no destination key here is under it.
    expect(copies.map((c) => c.origin)).toEqual([
      { from: 'object', key: 'cordel/themes/base-1-Crimson/logo/logo.png' },
      { from: 'object', key: 'cordel/themes/base-1-Crimson/members_app/bookings.png' },
    ]);
    for (const copy of copies) expect(copy.destKey.startsWith('gyms/')).toBe(true);
  });
});

describe('what a successful clone stores', () => {
  const copies = planThemeAssetCopies(
    source({
      logoObjectKey: `${SOURCE_PREFIX}/logo/logo.webp`,
      logoMime: 'image/webp',
      memberImages: [{ slot: 'membership', object_key: `${SOURCE_PREFIX}/members_app/membership.png` }],
    }),
    DEST,
  );

  it('reports the clone’s own logo key and MIME', () => {
    expect(clonedLogo(copies)).toEqual({
      objectKey: 'gyms/g1-Acme/themes/new-theme-Blackcopy/logo/logo.webp',
      mime: 'image/webp',
    });
    expect(clonedLogo([])).toBeNull();
  });

  it('reports one row per copied background, keyed to the new object', () => {
    expect(clonedMemberImageRows(copies)).toEqual([
      { slot: 'membership', objectKey: 'gyms/g1-Acme/themes/new-theme-Blackcopy/members_app/membership.png' },
    ]);
  });

  it('derives rows from the copies that happened, never from the logo', () => {
    expect(clonedMemberImageRows([copies[0]])).toEqual([]);
  });
});

describe('copyStageFor', () => {
  it('names a declared storage stage for each kind', () => {
    const logo = copyStageFor({ kind: 'logo', slot: null, origin: { from: 'blob' }, destKey: 'k', mime: 'image/png' });
    const image = copyStageFor({ kind: 'members_image', slot: 'training', origin: { from: 'object', key: 's' }, destKey: 'k', mime: null });
    expect(logo).toBe('copy_logo');
    expect(image).toBe('copy_members_image');
    // The admin interpolates the value into `storage_stage_<value>`, so a stage
    // that is not declared has no locale key and would print verbatim.
    expect(STORAGE_FAILURE_STAGES).toContain(logo);
    expect(STORAGE_FAILURE_STAGES).toContain(image);
  });
});
