import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMBER_LOCALE,
  MEMBER_LOCALES,
  isMemberLocale,
  localePath,
  memberLocaleLabel,
  preferredLocalePath,
} from '../lib/memberLocale';

// #1039 — the rule that turns a member's stored default language into the
// locale the Members App renders in. The API suite's
// `member-preferred-locale.unit.test.ts` covers the write rule and the
// one-declaration/one-consumer gates (it runs in CI, this app's suite does
// not); what is asserted here is the pure navigation decision itself.

const t = (key: string) => `[${key}]`;

describe('localePath', () => {
  it('swaps the locale segment of a Members App path', () => {
    expect(localePath('/en/profile', 'es')).toBe('/es/profile');
    expect(localePath('/es/calendar', 'ca')).toBe('/ca/calendar');
    expect(localePath('/en/training/12', 'ca')).toBe('/ca/training/12');
  });

  it('prefixes a path that carries no locale', () => {
    expect(localePath('/', 'es')).toBe('/es');
    expect(localePath('/profile', 'es')).toBe('/es/profile');
  });

  it('leaves a path whose first segment merely looks like a page alone', () => {
    // `membership` is a page, not a locale — swapping it would send the member
    // to a route that does not exist.
    expect(localePath('/membership', 'es')).toBe('/es/membership');
  });
});

describe('preferredLocalePath', () => {
  it('redirects a member browsing in another language', () => {
    expect(preferredLocalePath('/en/profile', 'en', 'ca')).toBe('/ca/profile');
  });

  it('stays put when the member is already on their language', () => {
    // The steady state: this is the case that must not loop, since the
    // component re-runs its effect on every navigation.
    expect(preferredLocalePath('/ca/profile', 'ca', 'ca')).toBeNull();
  });

  it('stays put when there is no preference', () => {
    // §3/§11: a member without one keeps the locale the app already resolved,
    // and nothing is written.
    expect(preferredLocalePath('/en/profile', 'en', null)).toBeNull();
    expect(preferredLocalePath('/en/profile', 'en', undefined)).toBeNull();
    expect(preferredLocalePath('/en/profile', 'en', '')).toBeNull();
  });

  it('stays put for a locale this app cannot render', () => {
    // A locale dropped from the deployment, or one the API grew first: there is
    // no route segment and no message file, so redirecting would 404 or render
    // raw keys.
    expect(preferredLocalePath('/en/profile', 'en', 'de')).toBeNull();
  });
});

describe('MEMBER_LOCALES', () => {
  it('holds the three languages the app ships, with the default among them', () => {
    expect([...MEMBER_LOCALES]).toEqual(['en', 'es', 'ca']);
    expect(isMemberLocale(DEFAULT_MEMBER_LOCALE)).toBe(true);
  });

  it('labels a language through its own key, and an unknown one through neither', () => {
    expect(memberLocaleLabel('es', t)).toBe('[profile.language_es]');
    // Resolved before `t()` is called: next-intl has no `defaultValue` option
    // and would print `profile.language_fr` on screen (CLAUDE.md).
    expect(memberLocaleLabel('fr', t)).toBe('FR');
  });
});
