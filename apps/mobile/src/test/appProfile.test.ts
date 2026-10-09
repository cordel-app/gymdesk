import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppProfileError,
  DEFAULT_PROFILE_ID,
  PROFILE_ENV_KEYS,
  parseAllowNavigation,
  profileIdFromEnv,
  resolveAppProfile,
  type AppProfileInput,
} from '../appProfile';
import { availableProfileIds, loadAppProfile, profilePath, readProfileFile } from '../loadAppProfile';
import {
  NativeIdentityError,
  androidIdentity,
  appLinkHost,
  associatedDomains,
  iosIdentity,
  reversedGoogleClientId,
  urlSchemes,
} from '../nativeIdentity';
import {
  NativeProjectFileError,
  withAndroidStrings,
  withAppleSignIn,
  withAssociatedDomains,
  withBundleIdentifier,
  withGradleApplicationId,
  withPlistString,
  withPlistUrlSchemes,
} from '../nativeProjectFiles';

// #1074 (mobile app WP3) — the shell's own rules. Nothing here needs a macOS
// machine, an Android SDK or a device: what a profile resolves to and what it
// writes into the two native projects are pure, which is the whole reason they
// are separate from the script that performs the I/O.
//
// The drift gate that has to hold on *every* push is in the API suite
// (`api/src/test/mobile-shell-profile.unit.test.ts`), because CI runs
// `npm test` in `api/` only — the same reason #1073's two-module rule and
// #983's theme rule are asserted there.

const WORKSPACE = join(__dirname, '..', '..');

const PROFILE: AppProfileInput = {
  id: 'example',
  appId: 'com.example.app',
  appName: 'Example',
  serverUrl: 'https://members.example.com',
  allowNavigation: ['members.example.com'],
};

describe('resolveAppProfile', () => {
  it('resolves a complete profile with no environment at all', () => {
    const resolved = resolveAppProfile(PROFILE, {});
    expect(resolved).toEqual({
      id: 'example',
      appId: 'com.example.app',
      appName: 'Example',
      serverUrl: 'https://members.example.com',
      allowNavigation: ['members.example.com'],
      googleIosClientId: null,
      googleWebClientId: null,
      customUrlScheme: 'com.example.app',
      appleSignIn: false,
    });
  });

  it('lets the environment override each field on its own', () => {
    const resolved = resolveAppProfile(PROFILE, {
      [PROFILE_ENV_KEYS.serverUrl]: 'https://staging.example.com',
    });
    expect(resolved.serverUrl).toBe('https://staging.example.com');
    // Everything the environment did not name is still the profile's.
    expect(resolved.appId).toBe('com.example.app');
    expect(resolved.allowNavigation).toEqual(['members.example.com']);
  });

  it('refuses a profile with no appId, appName or serverUrl, naming the variable', () => {
    for (const field of ['appId', 'appName', 'serverUrl'] as const) {
      const incomplete = { ...PROFILE, [field]: undefined };
      expect(() => resolveAppProfile(incomplete, {})).toThrow(AppProfileError);
      expect(() => resolveAppProfile(incomplete, {})).toThrow(PROFILE_ENV_KEYS[field]);
    }
  });

  it('accepts a profile missing those fields when the environment supplies them', () => {
    const resolved = resolveAppProfile(
      { id: 'env-only' },
      {
        [PROFILE_ENV_KEYS.appId]: 'com.example.env',
        [PROFILE_ENV_KEYS.appName]: 'From env',
        [PROFILE_ENV_KEYS.serverUrl]: 'https://env.example.com',
      },
    );
    expect(resolved.appId).toBe('com.example.env');
    expect(resolved.customUrlScheme).toBe('com.example.env');
  });

  it('treats blank and whitespace values as absent rather than as an override', () => {
    const resolved = resolveAppProfile(PROFILE, {
      [PROFILE_ENV_KEYS.appName]: '   ',
      [PROFILE_ENV_KEYS.googleWebClientId]: '',
    });
    expect(resolved.appName).toBe('Example');
    expect(resolved.googleWebClientId).toBeNull();
  });

  it('defaults the custom URL scheme to the app id, never to a literal', () => {
    expect(resolveAppProfile({ ...PROFILE, appId: 'com.gym.one' }, {}).customUrlScheme).toBe('com.gym.one');
    expect(
      resolveAppProfile({ ...PROFILE, customUrlScheme: 'gymone' }, {}).customUrlScheme,
    ).toBe('gymone');
  });

  it('deduplicates and trims allowNavigation from either source', () => {
    expect(
      resolveAppProfile({ ...PROFILE, allowNavigation: [' a.com ', 'a.com', 'b.com', ''] }, {})
        .allowNavigation,
    ).toEqual(['a.com', 'b.com']);
    expect(
      resolveAppProfile(PROFILE, { [PROFILE_ENV_KEYS.allowNavigation]: 'a.com, b.com a.com' })
        .allowNavigation,
    ).toEqual(['a.com', 'b.com']);
  });

  it('lets the environment clear allowNavigation, which an absent variable does not', () => {
    expect(parseAllowNavigation('')).toEqual([]);
    expect(parseAllowNavigation(undefined)).toBeNull();
    expect(
      resolveAppProfile(PROFILE, { [PROFILE_ENV_KEYS.allowNavigation]: '' }).allowNavigation,
    ).toEqual([]);
  });

  it('names the profile the environment asks for, else the stage-1 default', () => {
    expect(profileIdFromEnv({})).toBe(DEFAULT_PROFILE_ID);
    expect(profileIdFromEnv({ [PROFILE_ENV_KEYS.profile]: 'gym-x' })).toBe('gym-x');
    expect(resolveAppProfile(PROFILE, { [PROFILE_ENV_KEYS.profile]: 'gym-x' }).id).toBe('gym-x');
  });
});

describe('the profiles this workspace holds', () => {
  it('has the stage-1 generic app, and it resolves with no environment', () => {
    expect(availableProfileIds(WORKSPACE)).toContain(DEFAULT_PROFILE_ID);
    const resolved = resolveAppProfile(readProfileFile(WORKSPACE, DEFAULT_PROFILE_ID), {});
    expect(resolved.appId).toBe('com.cordel.fitness');
    expect(resolved.appName).toBe('Cordel Fitness');
    expect(resolved.serverUrl.startsWith('https://')).toBe(true);
  });

  it('is what the last `cap sync` built with, where one has run', () => {
    const resolved = loadAppProfile(WORKSPACE, {});
    const synced = join(WORKSPACE, 'ios/App/App/capacitor.config.json');
    // That file is `cap sync` output and is gitignored, so a fresh checkout
    // does not have it; where it exists it must agree with the profile, or the
    // native projects were synced from a different one.
    if (!existsSync(synced)) return;
    const config = JSON.parse(readFileSync(synced, 'utf8'));
    expect(config.appId).toBe(resolved.appId);
    expect(config.appName).toBe(resolved.appName);
    expect(config.server.url).toBe(resolved.serverUrl);
  });

  it('says which profiles exist when asked for one that does not', () => {
    expect(() => readProfileFile(WORKSPACE, 'no-such-profile')).toThrow(AppProfileError);
    expect(() => readProfileFile(WORKSPACE, 'no-such-profile')).toThrow(DEFAULT_PROFILE_ID);
    expect(profilePath(WORKSPACE, 'gym-x').endsWith('profiles/gym-x.json')).toBe(true);
  });
});

describe('what a profile means for the native projects', () => {
  it('reverses a Google client id, and answers null for anything that is not one', () => {
    expect(reversedGoogleClientId('123-abc.apps.googleusercontent.com')).toBe(
      'com.googleusercontent.apps.123-abc',
    );
    expect(reversedGoogleClientId(null)).toBeNull();
    expect(reversedGoogleClientId('  ')).toBeNull();
    expect(reversedGoogleClientId('not-a-client-id')).toBeNull();
  });

  it('registers the app scheme always and the Google scheme only when there is an id', () => {
    const without = resolveAppProfile(PROFILE, {});
    expect(urlSchemes(without)).toEqual(['com.example.app']);

    const withGoogle = resolveAppProfile(PROFILE, {
      [PROFILE_ENV_KEYS.googleIosClientId]: '123-abc.apps.googleusercontent.com',
    });
    expect(urlSchemes(withGoogle)).toEqual([
      'com.example.app',
      'com.googleusercontent.apps.123-abc',
    ]);
    expect(iosIdentity(withGoogle)).toEqual({
      bundleId: 'com.example.app',
      displayName: 'Example',
      urlSchemes: urlSchemes(withGoogle),
      associatedDomains: ['applinks:members.example.com'],
    });
  });

  it('moves the Android applicationId and leaves the template namespace alone', () => {
    const identity = androidIdentity(resolveAppProfile(PROFILE, {}), 'com.cordel.fitness');
    expect(identity.applicationId).toBe('com.example.app');
    expect(identity.namespace).toBe('com.cordel.fitness');
  });
});

describe('writing a profile into the native projects', () => {
  it('rewrites every PRODUCT_BUNDLE_IDENTIFIER of the Xcode project', () => {
    const pbxproj = [
      '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.old.app;',
      '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.old.app;',
    ].join('\n');
    expect(withBundleIdentifier(pbxproj, 'com.new.app')).toBe(
      ['\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.new.app;', '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.new.app;'].join('\n'),
    );
  });

  it('replaces the URL scheme array whole rather than appending to it', () => {
    const plist = '<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>com.old.app</string>\n\t\t\t</array>';
    const next = withPlistUrlSchemes(plist, ['com.new.app', 'com.googleusercontent.apps.1']);
    expect(next).toContain('<string>com.new.app</string>');
    expect(next).toContain('<string>com.googleusercontent.apps.1</string>');
    expect(next).not.toContain('com.old.app');
  });

  it('escapes a display name that contains XML', () => {
    const plist = '<key>CFBundleDisplayName</key>\n\t<string>Old</string>';
    expect(withPlistString(plist, 'CFBundleDisplayName', 'Body & Mind')).toContain(
      '<string>Body &amp; Mind</string>',
    );
    expect(
      withAndroidStrings(
        '<resources><string name="app_name">Old</string><string name="title_activity_main">Old</string><string name="package_name">com.old</string><string name="custom_url_scheme">com.old</string><string name="app_link_host">old.example.com</string></resources>',
        { appName: 'Body & Mind', packageName: 'com.new', customUrlScheme: 'com.new', appLinkHost: 'h' },
      ),
    ).toContain('<string name="app_name">Body &amp; Mind</string>');
  });

  it('moves Gradle’s applicationId in either quoting style', () => {
    expect(withGradleApplicationId('applicationId "com.old"', 'com.new')).toBe('applicationId "com.new"');
    expect(withGradleApplicationId("applicationId = 'com.old'", 'com.new')).toBe('applicationId = "com.new"');
  });

  it('throws rather than reporting success when an anchor is gone', () => {
    for (const run of [
      () => withBundleIdentifier('nothing here', 'com.new'),
      () => withPlistString('nothing here', 'CFBundleDisplayName', 'x'),
      () => withPlistUrlSchemes('nothing here', ['x']),
      () => withGradleApplicationId('nothing here', 'com.new'),
      () => withAssociatedDomains('nothing here', ['applinks:example.com']),
      () =>
        withAndroidStrings('<resources></resources>', {
          appName: 'a',
          packageName: 'b',
          customUrlScheme: 'c',
          appLinkHost: 'd',
        }),
    ]) {
      expect(run).toThrow(NativeProjectFileError);
    }
  });

  it('is idempotent on the committed projects: applying the stage-1 profile changes nothing', () => {
    const profile = loadAppProfile(WORKSPACE, {});
    const ios = iosIdentity(profile);
    const pbxproj = readFileSync(join(WORKSPACE, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    const plist = readFileSync(join(WORKSPACE, 'ios/App/App/Info.plist'), 'utf8');
    const gradle = readFileSync(join(WORKSPACE, 'android/app/build.gradle'), 'utf8');
    const strings = readFileSync(
      join(WORKSPACE, 'android/app/src/main/res/values/strings.xml'),
      'utf8',
    );

    expect(withBundleIdentifier(pbxproj, ios.bundleId)).toBe(pbxproj);
    expect(withPlistUrlSchemes(withPlistString(plist, 'CFBundleDisplayName', ios.displayName), ios.urlSchemes)).toBe(plist);
    expect(withGradleApplicationId(gradle, profile.appId)).toBe(gradle);
    expect(
      withAndroidStrings(strings, {
        appName: profile.appName,
        packageName: profile.appId,
        customUrlScheme: profile.customUrlScheme,
        appLinkHost: appLinkHost(profile),
      }),
    ).toBe(strings);
    const entitlements = readFileSync(join(WORKSPACE, 'ios/App/App/App.entitlements'), 'utf8');
    expect(withAssociatedDomains(entitlements, ios.associatedDomains)).toBe(entitlements);
  });
});

// #1076 (mobile app WP4) — the app-link host is derived from `serverUrl`, and
// both platforms are written from it.
describe('app links', () => {
  it('takes the host from the profile’s own serverUrl', () => {
    expect(appLinkHost(resolveAppProfile(PROFILE))).toBe('members.example.com');
    expect(associatedDomains(resolveAppProfile(PROFILE))).toEqual(['applinks:members.example.com']);
  });

  it('follows an environment override of the URL, so a staging build claims staging', () => {
    const profile = resolveAppProfile(PROFILE, {
      [PROFILE_ENV_KEYS.serverUrl]: 'https://staging.example.org/members',
    });
    expect(appLinkHost(profile)).toBe('staging.example.org');
  });

  it('carries the host into both native identities', () => {
    const profile = resolveAppProfile(PROFILE);
    expect(iosIdentity(profile).associatedDomains).toEqual(['applinks:members.example.com']);
    expect(androidIdentity(profile, 'com.template.pkg').appLinkHost).toBe('members.example.com');
  });

  it('throws rather than claiming a host it could not parse', () => {
    // `resolveAppProfile()` requires a `serverUrl` but cannot know it is a URL,
    // so this is where a profile holding a placeholder fails — visibly, at
    // apply time, rather than as an entitlement no domain can verify.
    expect(() => appLinkHost(resolveAppProfile({ ...PROFILE, serverUrl: 'members.example.com' }))).toThrow(
      NativeIdentityError,
    );
  });

  it('replaces the entitlement’s domains whole', () => {
    const entitlements =
      '<key>com.apple.developer.associated-domains</key>\n\t<array>\n\t\t<string>applinks:old.example.com</string>\n\t</array>';
    const next = withAssociatedDomains(entitlements, ['applinks:new.example.com']);
    expect(next).toContain('<string>applinks:new.example.com</string>');
    expect(next).not.toContain('old.example.com');
  });

  it('writes the host as a string resource, so the manifest holds no literal', () => {
    const strings =
      '<resources><string name="app_name">A</string><string name="title_activity_main">A</string><string name="package_name">com.a</string><string name="custom_url_scheme">com.a</string><string name="app_link_host">old.example.com</string></resources>';
    const next = withAndroidStrings(strings, {
      appName: 'A',
      packageName: 'com.a',
      customUrlScheme: 'com.a',
      appLinkHost: 'new.example.com',
    });
    expect(next).toContain('<string name="app_link_host">new.example.com</string>');
    expect(next).not.toContain('old.example.com');
  });
});

describe('Sign in with Apple (#1075)', () => {
  const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>aps-environment</key>
\t<string>development</string>
</dict>
</plist>
`;

  it('is off by default, and the profile or MOBILE_APPLE_SIGN_IN turns it on', () => {
    const base = { appId: 'com.x.y', appName: 'X', serverUrl: 'https://x.example' };
    expect(resolveAppProfile(base).appleSignIn).toBe(false);
    expect(resolveAppProfile({ ...base, appleSignIn: true }).appleSignIn).toBe(true);
    expect(resolveAppProfile({ ...base, appleSignIn: true }, { MOBILE_APPLE_SIGN_IN: 'false' }).appleSignIn).toBe(false);
    expect(resolveAppProfile(base, { MOBILE_APPLE_SIGN_IN: 'true' }).appleSignIn).toBe(true);
  });

  it('adds the entitlement once and removes it when disabled', () => {
    const on = withAppleSignIn(entitlements, true);
    expect(on).toContain('com.apple.developer.applesignin');
    expect(on).toContain('<string>Default</string>');
    expect(on).toContain('aps-environment');
    expect(withAppleSignIn(on, true)).toBe(on);
    expect(withAppleSignIn(on, false)).toBe(entitlements);
    expect(withAppleSignIn(entitlements, false)).toBe(entitlements);
  });

  it('throws rather than reporting success when the file has no anchor', () => {
    expect(() => withAppleSignIn('nothing here', true)).toThrow();
  });
});
