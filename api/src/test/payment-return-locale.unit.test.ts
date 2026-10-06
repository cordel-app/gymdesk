import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1081 — the hosted payment page's two return URLs carry **no locale segment**.
//
// `PAYMENT_OK_URL` / `PAYMENT_KO_URL` are one deploy-time value shared by every
// member of every gym, so the API cannot build them per member: a fixed
// `https://members…/es/payment/success` landed an English- or Catalan-speaking
// member on the Spanish result page after paying. The locale-less path is what
// lets the Members App's own middleware answer the question instead — it
// redirects to the member's language (the `NEXT_LOCALE` cookie first, then
// `Accept-Language`, then `en`) and keeps the query string, which is what
// carries `purpose=card_update` back to the page (#788).
//
// So the rule is a property of two files that have no other connection, and
// nothing at runtime would notice it breaking: a locale put back into the
// example (or copied from it into a deployment's variables) just works, in one
// language. This gate lives in the API suite for #1009's reason — CI runs
// `npm test` in `api/` only — which is also why it reads the Members App's
// middleware from here rather than from `apps/member`'s own suite.

const ENV_EXAMPLE = join(__dirname, '..', '..', '.env.example');
const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

/** The file with its comments removed, so prose naming a locale or a path does
 * not read as configuration. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function envValue(name: string): string {
  const line = read(ENV_EXAMPLE)
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not in api/.env.example`);
  return line.slice(name.length + 1).trim();
}

/** The Members App's own language list, read from the one module that declares
 * it (#1039) rather than restated here — a locale added there must be refused
 * in these URLs too. */
function memberLocales(): string[] {
  const source = read(join(MEMBER_SRC, 'lib', 'memberLocale.ts'));
  const match = /export const MEMBER_LOCALES = \[([^\]]+)\]/.exec(source);
  if (!match) throw new Error('MEMBER_LOCALES is not declared as a literal array');
  return Array.from(match[1].matchAll(/'([a-z-]+)'/g)).map((m) => m[1]);
}

describe('the payment return URLs carry no locale (#1081)', () => {
  const locales = memberLocales();

  it('reads the Members App language list rather than restating it', () => {
    expect(locales).toContain('en');
    expect(locales.length).toBeGreaterThan(1);
  });

  for (const name of ['PAYMENT_OK_URL', 'PAYMENT_KO_URL']) {
    it(`${name}'s example points at the locale-less path`, () => {
      const value = envValue(name);
      const { pathname } = new URL(value);
      const segments = pathname.split('/').filter((s) => s.length > 0);

      // The member's language is the middleware's answer, never the deploy's.
      expect(locales).not.toContain(segments[0]);
      expect(segments[0]).toBe('payment');
      expect(segments).toHaveLength(2);
      expect(['success', 'error']).toContain(segments[1]);
      // A query string here would survive the redirect, but `purpose=card_update`
      // is appended by the API (`withPurposeParam`) and must not be baked in.
      expect(value).not.toContain('?');
    });
  }
});

describe('the Members App middleware is what localizes the return (#1081)', () => {
  const middleware = withoutComments(read(join(MEMBER_SRC, 'middleware.ts')));

  it('leaves next-intl locale detection on', () => {
    // Detection is what reads the cookie and `Accept-Language`; switched off,
    // every locale-less return would render in `defaultLocale` and the fixed
    // `/es` defect comes back one layer down.
    expect(middleware).not.toMatch(/localeDetection\s*:\s*false/);
    expect(middleware).toMatch(/createIntlMiddleware\(/);
  });

  it('routes off the one declared language list', () => {
    expect(middleware).toMatch(/locales:\s*\[\.\.\.MEMBER_LOCALES\]/);
    expect(middleware).toMatch(/defaultLocale:\s*DEFAULT_MEMBER_LOCALE/);
  });

  it('keeps the return pages behind auth', () => {
    // Deliberate, and the answer to the ticket's auth question: both pages poll
    // an authenticated route (`/me/payment-requests`, `/me/payment-method`), so
    // there is nothing to show a visitor with no session — being sent to sign-in
    // and brought back to the locale-less path, which then redirects by locale,
    // is the correct behaviour rather than a defect to make public.
    const publicRoutes = /createRouteMatcher\(\[([\s\S]*?)\]\)/.exec(middleware);
    expect(publicRoutes).not.toBeNull();
    expect(publicRoutes![1]).not.toContain('payment');
  });
});
