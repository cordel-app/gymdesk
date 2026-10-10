import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMemberPreferredLocaleInput, toMemberPreferredLocale } from '../domain/memberPreferredLocale';
import { SUPPORTED_LOCALES } from '../infra/locale';

// #1039 — the Member's default language for the Members App.
//
// Two halves, in one file on purpose. The first is the write rule: what a
// `PATCH /me/profile` may store, and the three answers a partial write has to
// distinguish (keep · clear · set). The second is the Members App's side of it,
// scanned from here for #1009's reason — CI runs `npm test` in `api/` only, so a
// check that has to hold on every push belongs in this suite even when what it
// checks is a frontend file.

const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');
const MEMBER_LOCALES_DIR = join(__dirname, '..', '..', '..', 'apps', 'member', 'locales', 'base');

function memberFile(relative: string): string {
  return readFileSync(join(MEMBER_SRC, relative), 'utf-8');
}

describe('parseMemberPreferredLocaleInput', () => {
  it('keeps the stored value when the field is not mentioned', () => {
    // The load-bearing case: `PATCH /me/profile` is partial and every client
    // written before this ticket sends the phone alone.
    expect(parseMemberPreferredLocaleInput({ phone: '+34 600 000 000' })).toEqual({ keep: true });
    expect(parseMemberPreferredLocaleInput({})).toEqual({ keep: true });
    expect(parseMemberPreferredLocaleInput(undefined)).toEqual({ keep: true });
    expect(parseMemberPreferredLocaleInput(null)).toEqual({ keep: true });
  });

  it('treats an explicit null or empty string as "no preference"', () => {
    expect(parseMemberPreferredLocaleInput({ preferred_locale: null })).toEqual({ clear: true });
    expect(parseMemberPreferredLocaleInput({ preferred_locale: '' })).toEqual({ clear: true });
  });

  it('accepts every configured locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(parseMemberPreferredLocaleInput({ preferred_locale: locale })).toEqual({ locale });
    }
  });

  it('stores the allowlist\'s own string, not the caller\'s', () => {
    const parsed = parseMemberPreferredLocaleInput({ preferred_locale: 'ES' });
    expect(parsed.locale).toBe('es');
    // Same string, but provably the one parsed from `SUPPORTED_LOCALES` at boot.
    expect(SUPPORTED_LOCALES).toContain(parsed.locale);
  });

  it('folds a regional tag onto its base locale', () => {
    expect(parseMemberPreferredLocaleInput({ preferred_locale: 'es-ES' })).toEqual({ locale: 'es' });
    expect(parseMemberPreferredLocaleInput({ preferred_locale: ' ca-ES ' })).toEqual({ locale: 'ca' });
  });

  it('refuses an unsupported or malformed value rather than coercing it', () => {
    for (const raw of ['fr', 'zz', 'english', 42, true, {}, []]) {
      const parsed = parseMemberPreferredLocaleInput({ preferred_locale: raw });
      expect(parsed.error, JSON.stringify(raw)).toBeTruthy();
      expect(parsed.locale).toBeUndefined();
      expect(parsed.clear).toBeUndefined();
      expect(parsed.keep).toBeUndefined();
    }
  });
});

describe('toMemberPreferredLocale', () => {
  it('reports a configured locale as itself', () => {
    expect(toMemberPreferredLocale('es')).toBe('es');
  });

  it('reports a locale the deployment no longer configures as no preference', () => {
    expect(toMemberPreferredLocale('de')).toBeNull();
    expect(toMemberPreferredLocale(null)).toBeNull();
    expect(toMemberPreferredLocale('')).toBeNull();
  });
});

describe('the Members App side of the preference', () => {
  it('declares its languages once, and the middleware reads that list', () => {
    const lib = memberFile('lib/memberLocale.ts');
    expect(lib).toMatch(/export const MEMBER_LOCALES = \['en', 'es', 'ca'\] as const;/);

    const middleware = memberFile('middleware.ts');
    expect(middleware).toContain('MEMBER_LOCALES');
    // A second list is what §2's "do not create a second language/locale
    // system" forbids, and it is what this file used to hold.
    expect(middleware).not.toMatch(/locales:\s*\['en'/);
  });

  it('agrees with the API about which locales exist', () => {
    const lib = memberFile('lib/memberLocale.ts');
    const declared = [...lib.matchAll(/export const MEMBER_LOCALES = \[([^\]]+)\]/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')))
      .filter(Boolean);
    // The app can only render a locale it has route segments and messages for,
    // so its list may be narrower than a deployment's — never wider, or the
    // selector would offer a language the API refuses to store (§10).
    for (const locale of declared) {
      expect(SUPPORTED_LOCALES, locale).toContain(locale);
    }
  });

  it('applies the preference in exactly one place', () => {
    // §5: no page may switch the locale for itself. `preferredLocalePath()` is
    // the decision and `MemberLocalePreference` its only consumer.
    const component = memberFile('components/MemberLocalePreference.tsx');
    expect(component).toContain('preferredLocalePath');

    const profile = memberFile('app/[locale]/profile/page.tsx');
    expect(profile).not.toContain('preferredLocalePath');
    expect(profile).toContain('preferred_locale');
  });

  it('applies the member\'s language while impersonating and restores the superadmin\'s', () => {
    // Impersonating exists to see what the member sees, so the preference is not
    // skipped for a superadmin; the locale they came from is kept and restored.
    const component = memberFile('components/MemberLocalePreference.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(component).not.toMatch(/loading \|\| isImpersonating/);
    expect(component).toContain("'impersonation_return_locale'");
    expect(component).toContain('rememberReturnLocale(locale)');
    expect(component).toContain('clearReturnLocale()');
    // Remembered only once, so a second switch does not overwrite where they came from.
    expect(component).toMatch(/if \(!sessionStorage\.getItem\(RETURN_LOCALE_KEY\)\)/);
  });

  it('holds the page back while a language switch is pending, with a way out', () => {
    // The flicker: rendering the screens in the wrong language and then replacing
    // the route. The component wraps the page and renders nothing for it while a
    // switch is pending, and gives up after a timeout rather than leave it blank.
    const component = memberFile('components/MemberLocalePreference.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(component).toMatch(/export function MemberLocalePreference\(\{ children \}/);
    expect(component).toContain('SWITCH_TIMEOUT_MS');
    expect(component).toMatch(/target && !gaveUp \? null : children/);
    const layout = memberFile('app/[locale]/layout.tsx');
    expect(layout).toContain('<MemberLocalePreference>{children}</MemberLocalePreference>');
    expect(layout).not.toContain('<MemberLocalePreference />');
  });

  it('labels every language in every locale file', () => {
    for (const code of ['en', 'es', 'ca']) {
      const messages = JSON.parse(readFileSync(join(MEMBER_LOCALES_DIR, `${code}.json`), 'utf-8'));
      expect(messages.profile.language, code).toBeTruthy();
      for (const named of ['en', 'es', 'ca']) {
        // next-intl prints a missing key verbatim and `memberLocaleLabel()`
        // resolves `profile.language_<tag>` before calling `t()`, so a missing
        // one renders the tag rather than the key — still wrong on screen.
        expect(messages.profile[`language_${named}`], `${code}: language_${named}`).toBeTruthy();
      }
    }
  });
});
