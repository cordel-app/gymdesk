import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MEMBER_IMAGE_SLOTS } from '../domain/themeMemberImages';

// #1151 — the Theme editor's Members App → Images slot that paints the
// dashboard's My Products card is **labelled** *My Products*, because #1116
// renamed that card. It is a label change and only a label change: the slot's
// id stays `membership`, which is what `theme_member_images.slot` holds and
// what `buildThemeMemberImageKey()` writes into every object key — renaming an
// id would strand every image a gym has already uploaded (R2 has no
// directories, so a stored key is the only way back to its object, #1035).
//
// Two things are the rule rather than the implementation. A slot's label is
// the Members App's **own name for the section it paints**, so the two must
// not drift apart — a gym owner uploading artwork for *My Membership* can no
// longer find the card it lands on. And the two admin theme namespaces
// (`gym_themes`, the gym's own Themes page; `themes`, Cordel's Base Themes)
// must say the same thing, since one editor serves both screens (#806).
//
// This gate lives in the API suite for #1009's reason: CI runs `npm test` in
// `api/` only, so a scan that has to hold on every push belongs here even when
// what it scans is a frontend.

const ROOT = join(__dirname, '..', '..', '..');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
/** The two namespaces the one slot editor is rendered under. */
const THEME_NAMESPACES = ['gym_themes', 'themes'] as const;

type Messages = Record<string, Record<string, string>>;

function messages(app: 'admin' | 'member', code: string): Messages {
  return JSON.parse(readFileSync(join(ROOT, 'apps', app, 'locales', 'base', `${code}.json`), 'utf-8'));
}

describe('the membership slot reads My Products (#1151)', () => {
  it('says Products in every language, in both theme namespaces', () => {
    const expected: Record<string, string> = { en: 'Products', es: 'productos', ca: 'productes' };
    for (const code of LOCALE_CODES) {
      const admin = messages('admin', code);
      for (const ns of THEME_NAMESPACES) {
        const label = admin[ns]?.members_image_membership;
        expect(label, `${code}/${ns}`).toBeTruthy();
        expect(label!.toLowerCase(), `${code}/${ns}`).toContain(expected[code].toLowerCase());
      }
    }
  });

  it('no longer says Membership, in any language or namespace', () => {
    // The retired wording, per locale. A label still reading it would send a
    // gym owner looking for a card that does not carry that name any more.
    const retired: Record<string, RegExp> = {
      en: /Membership/i,
      es: /membres[íi]a/i,
      ca: /subscripci[óo]/i,
    };
    for (const code of LOCALE_CODES) {
      const admin = messages('admin', code);
      for (const ns of THEME_NAMESPACES) {
        expect(admin[ns].members_image_membership, `${code}/${ns}`).not.toMatch(retired[code]);
      }
    }
  });

  it('names the section the Members App names, in each app its own casing', () => {
    // The dashboard card's own title (#1116's `home.products_services`) is the
    // name this label has to track; the admin's slot labels are sentence case
    // in es/ca (`Mis objetivos`, `Els meus objectius`) while the card is title
    // case, so the words must match and the casing is each app's.
    for (const code of LOCALE_CODES) {
      const card = messages('member', code).home?.products_services;
      expect(card, code).toBeTruthy();
      for (const ns of THEME_NAMESPACES) {
        expect(messages('admin', code)[ns].members_image_membership.toLowerCase(), `${code}/${ns}`)
          .toBe(card!.toLowerCase());
      }
    }
  });

  it('is one label, identical in both namespaces', () => {
    for (const code of LOCALE_CODES) {
      const admin = messages('admin', code);
      expect(admin.themes.members_image_membership, code).toBe(admin.gym_themes.members_image_membership);
    }
  });
});

describe('nothing else about the slot moved (#1151)', () => {
  it('keeps the stored id, so existing images still resolve', () => {
    expect(MEMBER_IMAGE_SLOTS).toContain('membership');
  });

  it('adds no second slot for the same card', () => {
    expect(MEMBER_IMAGE_SLOTS).not.toContain('products');
    expect(MEMBER_IMAGE_SLOTS).toHaveLength(8);
    for (const code of LOCALE_CODES) {
      const admin = messages('admin', code);
      for (const ns of THEME_NAMESPACES) {
        expect(admin[ns].members_image_products, `${code}/${ns}`).toBeUndefined();
      }
    }
  });

  it('leaves every other slot label alone', () => {
    const untouched: Record<string, Record<string, string>> = {
      // #1158's `next_bookings` is labelled after the dashboard card it paints
      // (*My Next Bookings*), which is also what the Members App calls that
      // card — a slot's label is the Members App's own name for its section.
      en: { training: 'My Training', nutrition: 'My Nutrition', calendar: 'Calendar', bookings: 'My Bookings', next_bookings: 'My Next Bookings', personal_goals: 'My Goals', background: 'General background' },
      es: { training: 'Mi entrenamiento', nutrition: 'Mi nutrición', calendar: 'Calendario', bookings: 'Mis reservas', next_bookings: 'Mis próximas reservas', personal_goals: 'Mis objetivos', background: 'Fondo general' },
      ca: { training: "El meu entrenament", nutrition: 'La meva nutrició', calendar: 'Calendari', bookings: 'Les meves reserves', next_bookings: 'Les meves properes reserves', personal_goals: 'Els meus objectius', background: 'Fons general' },
    };
    for (const code of LOCALE_CODES) {
      const admin = messages('admin', code);
      for (const [slot, label] of Object.entries(untouched[code])) {
        for (const ns of THEME_NAMESPACES) {
          expect(admin[ns][`members_image_${slot}`], `${code}/${ns}/${slot}`).toBe(label);
        }
      }
    }
  });

  it('still resolves the label from the slot, in the one editor', () => {
    const editor = readFileSync(
      join(ROOT, 'apps', 'admin', 'src', 'components', 'ThemeMembersImagesEditor.tsx'),
      'utf-8',
    );
    expect(editor).toContain('t(`members_image_${slot}`)');
    // No slot label is rendered as a string literal — the label is the locale
    // files' (next-intl prints a missing key verbatim, so a fallback in the
    // component would hide one rather than surface it).
    for (const slot of MEMBER_IMAGE_SLOTS) {
      expect(editor).not.toContain(`members_image_${slot}'`);
    }
  });
});
