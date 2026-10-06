import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// #1076 (mobile app WP4) — an invitation link opens the app, and the three
// declarations that make it do so agree.
//
// A universal link works only when **both** halves of a grant line up: the
// domain publishes a file naming the app, and the app declares the domain. The
// two live in different workspaces and in three different languages
// (TypeScript, a plist, an Android manifest), and `apps/mobile` cannot import
// `apps/member`'s module — so nothing but a scan can keep them from drifting,
// and a drift is invisible until a link opens the app on one platform and the
// browser on the other.
//
// This gate is in the API suite for #1009's reason, the same one that put
// `mobile-shell-profile.unit.test.ts`, `members-app-native.unit.test.ts` and
// `members-app-theme-consumption.unit.test.ts` here: CI runs `npm test` in
// `api/` only, so a scan that has to hold on every push belongs here even when
// what it scans is another workspace. The rules themselves are asserted beside
// the code they belong to — `apps/member/src/test/app-associations.test.ts` for
// what the files say, `apps/mobile/src/test/appProfile.test.ts` for what a
// profile writes into the native projects.

const ROOT = join(__dirname, '..', '..', '..');
const MEMBER = join(ROOT, 'apps', 'member');
const MOBILE = join(ROOT, 'apps', 'mobile');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** The one module that decides which URLs of the Members App open the app. */
const ASSOCIATIONS = read(MEMBER, 'src/lib/appAssociations.ts');

/** The path segment the whole rule is derived from, read from that module. */
const SEGMENT = /APP_LINK_PATH_SEGMENT = '([^']+)'/.exec(ASSOCIATIONS)?.[1];

const MANIFEST = read(MOBILE, 'android/app/src/main/AndroidManifest.xml');
const ENTITLEMENTS = read(MOBILE, 'ios/App/App/App.entitlements');
const STRINGS = read(MOBILE, 'android/app/src/main/res/values/strings.xml');
const NEXT_CONFIG = read(MEMBER, 'next.config.js');
const MIDDLEWARE = read(MEMBER, 'src/middleware.ts');
const PROFILE = JSON.parse(read(MOBILE, 'profiles/cordel-fitness.json')) as { serverUrl: string };

describe('the Members App serves both association files (#1076)', () => {
  it('has a route handler for each, and they decide nothing themselves', () => {
    for (const route of [
      'src/app/api/well-known/apple-app-site-association/route.ts',
      'src/app/api/well-known/assetlinks/route.ts',
    ]) {
      const path = join(MEMBER, route);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, 'utf8');
      // Built from the environment per request: a statically prerendered route
      // would bake the build container's empty configuration into the deploy.
      expect(source).toContain("export const dynamic = 'force-dynamic'");
      expect(source).toContain('wellKnownResponse');
      // No second place that reads the variable or spells the content type.
      expect(source).not.toContain('MOBILE_APP_ASSOCIATIONS');
      expect(source).not.toContain('application/json');
    }
  });

  it('serves them as application/json, with no redirect', () => {
    const response = read(MEMBER, 'src/lib/wellKnownResponse.ts');
    expect(response).toContain("WELL_KNOWN_CONTENT_TYPE = 'application/json'");
    // A redirect is refused by Apple, so the route never issues one.
    expect(response).not.toContain('NextResponse.redirect');
    // Nothing configured is a 404 rather than a file associating no app.
    expect(response).toContain('status: 404');
  });

  it('maps the canonical paths onto them with rewrites rather than redirects', () => {
    expect(NEXT_CONFIG).toContain('async rewrites()');
    expect(NEXT_CONFIG).toContain("source: '/.well-known/apple-app-site-association'");
    expect(NEXT_CONFIG).toContain("destination: '/api/well-known/apple-app-site-association'");
    expect(NEXT_CONFIG).toContain("source: '/.well-known/assetlinks.json'");
    expect(NEXT_CONFIG).toContain("destination: '/api/well-known/assetlinks'");
    expect(NEXT_CONFIG).not.toContain('async redirects()');
  });

  it('keeps the middleware off both paths', () => {
    // Apple and Google fetch these with no session and no `Accept-Language`, so
    // Clerk's protection and the locale redirect must never see them. The
    // matcher excludes anything containing a dot, which both canonical paths do
    // — assert the regex rather than the comment claiming it.
    const matcher = /'\/\(\(\?!([^']+)\)\.\*\)'/.exec(MIDDLEWARE)?.[0];
    expect(matcher).toBeTruthy();
    // The file holds a TypeScript string literal, so `\\.` in the source is one
    // escaped dot in the pattern Next compiles.
    const source = (matcher as string).slice(1, -1).replace(/\\\\/g, '\\');
    const pattern = new RegExp(`^${source}$`);
    // A positive control, so the assertion below cannot pass vacuously on a
    // pattern that was mis-extracted and matches nothing.
    expect(pattern.test('/en/link')).toBe(true);
    for (const path of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
      expect(pattern.test(path)).toBe(false);
    }
    // The internal path the rewrite lands on is matched (`/api/…`), so it is
    // let through explicitly rather than protected.
    expect(MIDDLEWARE).toContain("startsWith('/api/well-known')");
  });

  it('reads the Team ID and the fingerprints from one variable keyed by app id', () => {
    // The shape `FCM_SERVICE_ACCOUNTS` uses (#1072), for its reason: a stage-2
    // per-gym app is a new key, never a code change and never a new variable.
    expect(ASSOCIATIONS).toContain("APP_ASSOCIATIONS_ENV_KEY = 'MOBILE_APP_ASSOCIATIONS'");
    expect(read(MEMBER, '.env.example')).toContain('MOBILE_APP_ASSOCIATIONS');
  });
});

describe('the app declares the domain the files grant it (#1076)', () => {
  it('derives the host from the profile’s serverUrl, in both projects', () => {
    const host = new URL(PROFILE.serverUrl).hostname;
    expect(ENTITLEMENTS).toContain(`<string>applinks:${host}</string>`);
    expect(STRINGS).toContain(`<string name="app_link_host">${host}</string>`);
  });

  it('iOS: the associated-domains entitlement, written by the apply script', () => {
    expect(ENTITLEMENTS).toContain('<key>com.apple.developer.associated-domains</key>');
    const apply = read(MOBILE, 'scripts/apply-profile.ts');
    expect(apply).toContain('withAssociatedDomains');
    expect(apply).toContain('App.entitlements');
    // `npm run profile:apply` stays the only writer of a native identity
    // (#1074): nothing else may write the entitlement.
    expect(read(MOBILE, 'capacitor.config.ts')).not.toContain('associated');
  });

  it('Android: an autoVerify App Links filter on that host, via the resource', () => {
    const filter = /<intent-filter android:autoVerify="true">[\s\S]*?<\/intent-filter>/.exec(MANIFEST);
    expect(filter).toBeTruthy();
    const body = (filter as RegExpMatchArray)[0];
    expect(body).toContain('<data android:scheme="https" />');
    expect(body).toContain('<data android:host="@string/app_link_host" />');
    expect(body).toContain('android.intent.action.VIEW');
    expect(body).toContain('android.intent.category.BROWSABLE');
    // Design rule 1: the host is the profile's, so the manifest holds no literal.
    expect(MANIFEST).not.toContain(new URL(PROFILE.serverUrl).hostname);
  });

  it('claims the invitation path and not the whole domain, on both platforms', () => {
    expect(SEGMENT).toBe('link');
    // One declaration, two syntaxes — `apps/mobile` cannot import the module,
    // so this is what keeps the Android pattern equal to the Apple component.
    expect(ASSOCIATIONS).toContain(`APPLE_APP_LINK_COMPONENT = \`/*/\${APP_LINK_PATH_SEGMENT}\``);
    expect(ASSOCIATIONS).toContain(
      `ANDROID_APP_LINK_PATH_PATTERN = \`/.*/\${APP_LINK_PATH_SEGMENT}\``,
    );
    expect(MANIFEST).toContain(`<data android:pathPattern="/.*/${SEGMENT}" />`);
    // A filter over the whole domain would swallow the OAuth and Clerk
    // redirects a sign-in bounces through.
    expect(MANIFEST).not.toContain('android:pathPattern="/.*"');
    expect(MANIFEST).not.toContain('android:pathPrefix="/"');
  });

  it('keeps the custom URL scheme beside it, for a link a universal link misses', () => {
    // An in-app browser that does not trigger a universal link, and a build
    // whose domain is not verified yet, both still reach the app this way.
    expect(MANIFEST).toContain('<data android:scheme="@string/custom_url_scheme" />');
    expect(read(MOBILE, 'ios/App/App/Info.plist')).toContain('CFBundleURLSchemes');
  });

  it('turns the opened link into the invitation path it was written for', () => {
    // WP2 already made `appUrlOpenPath()` read an https URL, which is what a
    // universal link arrives as — so WP4 adds no second link rule.
    const native = read(MEMBER, 'src/lib/native.ts');
    expect(native).toContain('appUrlOpenPath');
    expect(native).toContain("parsed.protocol === 'https:'");
  });
});
