import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_APP_ID } from '../domain/deviceTokens';

// #1074 (mobile app WP3) — the native shell declares no app identity of its
// own, and the native projects in the repository carry the profile they were
// generated from.
//
// This gate lives in the API suite for #1009's reason, the same one that put
// `members-app-native.unit.test.ts` and `members-app-theme-consumption.unit.test.ts`
// here: CI runs `npm test` in `api/` only, so a scan that has to hold on
// **every** push belongs here even when what it scans is another workspace.
// `apps/mobile/src/test/appProfile.test.ts` asserts the rules themselves —
// what a profile resolves to and what it writes into a native project; this
// one asserts that nothing bypasses them, and that the shell's own app id is
// the one this API resolves FCM credentials for.

const MOBILE = join(__dirname, '..', '..', '..', 'apps', 'mobile');
const PROFILES = join(MOBILE, 'profiles');

/** The stage-1 generic app — `docs/mobile-app.md` §1. */
const STAGE_1_PROFILE = 'cordel-fitness';

function read(...parts: string[]): string {
  return readFileSync(join(MOBILE, ...parts), 'utf8');
}

function profile(id = STAGE_1_PROFILE): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PROFILES, `${id}.json`), 'utf8'));
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

describe('the shell workspace exists and is one Capacitor project', () => {
  it('has the config, the profile and both native projects in the repository', () => {
    for (const path of [
      'capacitor.config.ts',
      'package.json',
      'www/index.html',
      'profiles/cordel-fitness.json',
      'ios/App/App.xcodeproj/project.pbxproj',
      'ios/App/App/Info.plist',
      'ios/App/App/AppDelegate.swift',
      'android/app/build.gradle',
      'android/app/src/main/AndroidManifest.xml',
    ]) {
      expect(existsSync(join(MOBILE, path)), `apps/mobile/${path} is missing`).toBe(true);
    }
  });

  it('is in the npm workspaces, so `npm ci` installs it', () => {
    const root = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(root.workspaces).toContain('apps/mobile');
  });
});

describe('no app identity is hard-coded (docs/mobile-app.md design rule 1)', () => {
  // The values of the one stage-1 profile. A second profile is a second file,
  // never a branch in the code — so these strings may appear in `profiles/`,
  // in the generated native projects (which are what an apply *writes*), and
  // in a test's own fixtures, and nowhere else.
  const IDENTITY = [
    String(profile().appId),
    String(profile().appName),
    String(profile().serverUrl),
  ];

  it('does not appear in the shell\u2019s own TypeScript, scripts, config or fallback page', () => {
    const scanned = [
      'capacitor.config.ts',
      ...walk(join(MOBILE, 'src'))
        .filter((rel) => /\.tsx?$/.test(rel) && !rel.startsWith('test/'))
        .map((rel) => `src/${rel}`),
      ...walk(join(MOBILE, 'scripts')).map((rel) => `scripts/${rel}`),
      ...walk(join(MOBILE, 'www')).map((rel) => `www/${rel}`),
    ];
    expect(scanned.length).toBeGreaterThan(4);

    const offenders: string[] = [];
    for (const rel of scanned) {
      const text = read(rel);
      for (const value of IDENTITY) {
        if (text.includes(value)) offenders.push(`${rel} contains "${value}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads the URL and the navigation allow-list from the environment', () => {
    const config = read('capacitor.config.ts');
    // The ticket's own wording: `server.url` and `allowNavigation` come from
    // environment variables. The config asks the profile loader, which is the
    // one place `env ?? profile` is resolved.
    expect(config).toMatch(/loadAppProfile\(/);
    expect(config).toMatch(/url: profile\.serverUrl/);
    expect(config).toMatch(/allowNavigation: profile\.allowNavigation/);

    const appProfile = read('src/appProfile.ts');
    for (const key of [
      'MOBILE_APP_PROFILE',
      'MOBILE_APP_ID',
      'MOBILE_APP_NAME',
      'MOBILE_SERVER_URL',
      'MOBILE_ALLOW_NAVIGATION',
      'MOBILE_GOOGLE_IOS_CLIENT_ID',
      'MOBILE_GOOGLE_WEB_CLIENT_ID',
    ]) {
      expect(appProfile, `${key} is not declared in appProfile.ts`).toContain(key);
      expect(read('.env.example'), `${key} is not documented in .env.example`).toContain(key);
    }
  });

  it('keeps the profile the only place a Firebase config or a Google client id lives', () => {
    const ignore = read('.gitignore');
    expect(ignore).toContain('profiles/*/google-services.json');
    expect(ignore).toContain('profiles/*/GoogleService-Info.plist');
    // The committed projects must not carry either file: both are per app
    // profile and one of them is a different gym's.
    expect(existsSync(join(MOBILE, 'android/app/google-services.json'))).toBe(false);
    expect(existsSync(join(MOBILE, 'ios/App/App/GoogleService-Info.plist'))).toBe(false);
  });
});

describe('the committed native projects carry the stage-1 profile', () => {
  // `cap add` seeds them and `cap sync` leaves them alone, so a profile edited
  // without `npm run profile:apply` would ship the previous identity. This is
  // the check that fails instead.
  const appId = String(profile().appId);
  const appName = String(profile().appName);

  it('iOS: the Bundle ID, the display name and the app\u2019s URL scheme', () => {
    const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj');
    const ids = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^;"\n]+)"?;/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...new Set(ids)]).toEqual([appId]);

    // The plist's own indentation is tabs, and a value here is a *profile's*
    // (`Body & Mind`, a Bundle ID full of dots) — so the whitespace is squashed
    // once and the assertion is a plain substring. Building a `RegExp` from a
    // configured value is the thing CodeQL's incomplete-escaping rule is about:
    // escaping the dots alone leaves a backslash in a name unescaped, and
    // escaping nothing at all lets a `(` in a display name change the pattern.
    const plist = read('ios/App/App/Info.plist').replace(/\s+/g, ' ');
    expect(plist).toContain(`<key>CFBundleDisplayName</key> <string>${appName}</string>`);
    expect(plist).toContain(
      `<key>CFBundleURLSchemes</key> <array> <string>${appId}</string>`,
    );
  });

  it('Android: the applicationId and the four identity strings', () => {
    expect(read('android/app/build.gradle')).toContain(`applicationId "${appId}"`);
    const strings = read('android/app/src/main/res/values/strings.xml');
    expect(strings).toContain(`<string name="app_name">${appName}</string>`);
    expect(strings).toContain(`<string name="package_name">${appId}</string>`);
    expect(strings).toContain(`<string name="custom_url_scheme">${appId}</string>`);
  });

  it('both: the config `cap sync` generates is not committed', () => {
    // It is `cap sync` output, so each platform's own `.gitignore` excludes it
    // and a fresh checkout does not have it. When a working tree *has* synced,
    // it must agree with the profile — a disagreement means the projects were
    // synced from a different one.
    for (const path of [
      'ios/App/App/capacitor.config.json',
      'android/app/src/main/assets/capacitor.config.json',
    ]) {
      if (!existsSync(join(MOBILE, path))) continue;
      const synced = JSON.parse(read(path));
      expect(synced.appId).toBe(appId);
      expect(synced.appName).toBe(appName);
      expect(synced.server?.url).toBe(String(profile().serverUrl));
    }
    expect(read('ios/.gitignore')).toContain('App/App/capacitor.config.json');
    expect(read('android/.gitignore')).toContain('app/src/main/assets/capacitor.config.json');
  });
});

describe('the native side of what WP1 and WP2 decided', () => {
  it('registers the shell\u2019s app id as the one this API defaults a token to', () => {
    // A registration that names no `app_id` is stored under `defaultAppId()`,
    // and `FCM_SERVICE_ACCOUNTS` is keyed by app id (#1072) — so the generic
    // app's Bundle ID and this API's default have to be the same string, or a
    // token from the stage-1 app resolves no credentials and is skipped.
    expect(profile().appId).toBe(DEFAULT_APP_ID);
  });

  it('installs the native side of every plugin the Members App loads', () => {
    const shell = JSON.parse(read('package.json')).dependencies as Record<string, string>;
    const member = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'apps', 'member', 'package.json'), 'utf8'),
    ).dependencies as Record<string, string>;

    for (const [pkg, version] of Object.entries(member)) {
      if (!/^@(capacitor|capgo)\//.test(pkg)) continue;
      // Same package *and* same version: the web half and the native half of a
      // plugin are one plugin, and a mismatch is a bridge that answers a method
      // the installed native code does not have.
      expect(shell[pkg], `apps/mobile does not install ${pkg}`).toBe(version);
    }
    expect(Object.keys(shell)).toContain('@capacitor/ios');
    expect(Object.keys(shell)).toContain('@capacitor/android');
  });

  it('hands Google\u2019s callback to the SDK and everything else to Capacitor', () => {
    const appDelegate = read('ios/App/App/AppDelegate.swift');
    const sceneDelegate = read('ios/App/App/SceneDelegate.swift');
    // The ticket's own scope: `GIDSignIn.handle` in the AppDelegate. It is
    // behind `canImport` because `GoogleSignIn` is the plugin's transitive
    // dependency rather than this target's declared product.
    expect(appDelegate).toContain('GIDSignIn.sharedInstance.handle(url)');
    expect(appDelegate).toContain('#if canImport(GoogleSignIn)');
    expect(appDelegate).toContain('ApplicationDelegateProxy.shared.application(app, open: url, options: options)');
    // A URL opened on a running app reaches the *scene* delegate, because
    // `Info.plist` declares a scene manifest — so both entry points ask the one
    // rule rather than one of them silently never running.
    expect(sceneDelegate).toContain('NativeSignInUrl.handle');
    expect(read('ios/App/App/Info.plist')).toContain('UIApplicationSceneManifest');
  });

  it('turns the APNs token into the FCM token the API delivers to', () => {
    const appDelegate = read('ios/App/App/AppDelegate.swift');
    // Delivery is FCM HTTP v1 (#1072), so an APNs token registered with
    // `POST /me/devices` is a token FCM can never deliver to.
    expect(appDelegate).toContain('Messaging.messaging().apnsToken = deviceToken');
    expect(appDelegate).toContain('capacitorDidRegisterForRemoteNotifications');
    expect(appDelegate).toContain('#if canImport(FirebaseMessaging)');
  });

  it('declares the entitlements the spike proved are needed, from build settings', () => {
    const entitlements = read('ios/App/App/App.entitlements');
    expect(entitlements).toContain('keychain-access-groups');
    // From the build setting, so a second app profile needs no edit here.
    expect(entitlements).toContain('$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)');
    expect(entitlements).toContain('aps-environment');
    expect(read('ios/App/App.xcodeproj/project.pbxproj')).toContain(
      'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
    );
  });

  it('lets a link and a notification reach the Android app', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('<data android:scheme="@string/custom_url_scheme" />');
    expect(manifest).toContain('android.intent.action.VIEW');
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    // `singleTask` is what makes a link arrive as `appUrlOpen` on the running
    // app rather than as a second instance of it.
    expect(manifest).toContain('android:launchMode="singleTask"');
  });
});

describe('the runbook', () => {
  it('exists, and covers the checks no automated suite can make', () => {
    const runbook = readFileSync(
      join(__dirname, '..', '..', '..', 'docs', 'mobile-runbook.md'),
      'utf8',
    );
    for (const topic of [
      'profile:apply',
      'GoogleService-Info.plist',
      'google-services.json',
      'keychain',
      'FirebaseMessaging',
    ]) {
      expect(runbook, `docs/mobile-runbook.md does not mention ${topic}`).toContain(topic);
    }
  });

  // #1075: the Apple capability is opt-in, so the committed entitlements match the
  // stage-1 profile — absent while the profile does not turn it on.
  it('declares the Sign in with Apple entitlement only when the profile enables it', () => {
    const entitlements = read('ios/App/App/App.entitlements');
    const enabled = profile().appleSignIn === true;
    expect(entitlements.includes('com.apple.developer.applesignin')).toBe(enabled);
  });
});

