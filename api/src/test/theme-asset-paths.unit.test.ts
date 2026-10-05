// #829: the exact Cloudflare R2 tree a Theme's assets live in, pinned in one
// place for both kinds of Theme — the ticket's §1–§4 read as a test.
//
//   {bucket}/gyms/{gym_id}-{gym_name}/themes/{theme_id}-{theme_name}/
//     ├── logo/logo.{extension}
//     └── members_app/{training,nutrition,calendar,bookings,membership,personal_goals,background}.png
//
//   {bucket}/cordel/themes/{theme_id}-{theme_name}/   (a Base Theme: no gym root)
//     └── … the same two leaves
//
// Pure — no database, no HTTP, no R2. The routes' own behaviour (which prefix each
// one uses, the markers actually reaching R2, the uploaded file name never
// reaching a key) is covered by theme-logo-storage.test.ts,
// base-theme-logo-storage.test.ts, theme-members-images.test.ts and
// base-theme-members-images.test.ts.
//
// The spelling is what this file exists for. R2 has no directories, so the case
// of a folder *is* the folder: an upload that wrote `Logo/` beside `logo/` would
// silently split a theme's assets across two trees rather than rename one.

import { describe, expect, it } from 'vitest';
import { buildThemeFolderPrefix, THEME_LOGO_FOLDER, THEME_MEMBERS_FOLDER } from '../domain/themeFolders';
import { buildThemeLogoKey } from '../domain/themeLogo';
import { buildThemeMemberImageKey, MEMBER_IMAGE_SLOTS } from '../domain/themeMemberImages';
import { buildGymFolderPrefix, PLATFORM_STORAGE_ROOT, THEMES_FOLDER } from '../infra/storage';

const GYM_ID = 'gym_1';
const THEME_ID = 'theme_1';
const THEME_NAME = 'Dark Modern';

/** The two roots a theme folder may hang off, as the ticket spells them. */
const CUSTOM_ROOT = buildGymFolderPrefix(GYM_ID, 'Acme Fitness');
const BASE_ROOT = PLATFORM_STORAGE_ROOT;

const ROOTS: ReadonlyArray<{ kind: string; prefix: string; themeFolder: string }> = [
  { kind: 'Custom Theme', prefix: CUSTOM_ROOT, themeFolder: `gyms/${GYM_ID}-AcmeFitness/themes/${THEME_ID}-DarkModern` },
  { kind: 'Base Theme', prefix: BASE_ROOT, themeFolder: `cordel/themes/${THEME_ID}-DarkModern` },
];

describe('the folder names (#829 §1–§4)', () => {
  it('spells the three folders exactly as the ticket does', () => {
    expect(THEMES_FOLDER).toBe('themes');
    expect(THEME_LOGO_FOLDER).toBe('logo');
    expect(THEME_MEMBERS_FOLDER).toBe('members_app');
  });

  it('puts a Custom Theme under its gym and a Base Theme under the platform root', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      expect(buildThemeFolderPrefix(prefix, THEME_ID, THEME_NAME)).toBe(themeFolder);
    }
    // `gyms/` and `cordel/` are siblings, so the same theme id can never collide
    // across the two roots (§8: a Base Theme never writes into a gym's folder).
    expect(buildThemeFolderPrefix(CUSTOM_ROOT, THEME_ID, THEME_NAME))
      .not.toBe(buildThemeFolderPrefix(BASE_ROOT, THEME_ID, THEME_NAME));
  });
});

describe('the logo (#829 §2)', () => {
  it('is `logo/logo.<ext>` inside the theme\'s own folder, for both kinds of Theme', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      expect(buildThemeLogoKey(prefix, THEME_ID, THEME_NAME, 'image/png')).toBe(`${themeFolder}/logo/logo.png`);
    }
  });

  it('takes the extension from the validated mime type and nothing else', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      for (const [mime, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/svg+xml', 'svg']]) {
        expect(buildThemeLogoKey(prefix, THEME_ID, THEME_NAME, mime)).toBe(`${themeFolder}/logo/logo.${ext}`);
      }
    }
  });

  it('keeps the file name fixed, so a replacement of the same type overwrites in place (§5)', () => {
    for (const { prefix } of ROOTS) {
      const first = buildThemeLogoKey(prefix, THEME_ID, THEME_NAME, 'image/png');
      const second = buildThemeLogoKey(prefix, THEME_ID, THEME_NAME, 'image/png');
      expect(second).toBe(first);
      expect(first).not.toMatch(/logo-(2|new)\./);
    }
  });
});

describe('the Members App slots (#829 §3)', () => {
  it('is `members_app/<slot>.png` for every slot, for both kinds of Theme', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      for (const slot of MEMBER_IMAGE_SLOTS) {
        expect(buildThemeMemberImageKey(prefix, THEME_ID, THEME_NAME, slot))
          .toBe(`${themeFolder}/members_app/${slot}.png`);
      }
    }
  });

  it('covers exactly the declared slots, with the fixed filename the slot names', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      expect(MEMBER_IMAGE_SLOTS.map((slot) => buildThemeMemberImageKey(prefix, THEME_ID, THEME_NAME, slot)).sort())
        .toEqual([
          `${themeFolder}/members_app/background.png`,
          `${themeFolder}/members_app/bookings.png`,
          `${themeFolder}/members_app/calendar.png`,
          `${themeFolder}/members_app/membership.png`,
          `${themeFolder}/members_app/nutrition.png`,
          `${themeFolder}/members_app/personal_goals.png`,
          `${themeFolder}/members_app/training.png`,
        ]);
    }
  });

  it('gives the logo and the backgrounds two different leaves of one folder', () => {
    for (const { prefix, themeFolder } of ROOTS) {
      const logo = buildThemeLogoKey(prefix, THEME_ID, THEME_NAME, 'image/png');
      const background = buildThemeMemberImageKey(prefix, THEME_ID, THEME_NAME, 'background');
      expect(logo.startsWith(`${themeFolder}/`)).toBe(true);
      expect(background.startsWith(`${themeFolder}/`)).toBe(true);
      expect(logo).not.toBe(background);
    }
  });
});
