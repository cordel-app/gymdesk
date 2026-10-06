/**
 * #1074 (mobile app WP3) — `npm run profile:apply`: write the app profile into
 * the two native projects.
 *
 * `cap add` seeds the Xcode project, `Info.plist`, Gradle and `strings.xml`
 * from `capacitor.config.ts` **once**; `cap sync` copies web assets and plugins
 * and leaves those four alone. So the acceptance criterion *"changing the app
 * profile needs configuration only, no code change"* needs this step, and this
 * is the only writer of a native identity.
 *
 * It decides nothing itself: what a profile means is `src/nativeIdentity.ts`
 * and how it is written is `src/nativeProjectFiles.ts`, both pure and both
 * asserted in the API suite. This file is the I/O — read, transform, write,
 * report — plus the Firebase config copy, which is a file move rather than a
 * transform.
 *
 * Run it after `cap add`, after switching `MOBILE_APP_PROFILE`, and before any
 * release build. It is idempotent: applying the profile a project already
 * carries writes the same bytes and reports no change.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppProfileError } from '../src/appProfile';
import { loadAppProfile } from '../src/loadAppProfile';
import { NativeIdentityError, androidIdentity, iosIdentity } from '../src/nativeIdentity';
import {
  NativeProjectFileError,
  gradleNamespace,
  withAndroidStrings,
  withAssociatedDomains,
  withBundleIdentifier,
  withGradleApplicationId,
  withPlistString,
  withPlistUrlSchemes,
} from '../src/nativeProjectFiles';

const WORKSPACE = dirname(dirname(fileURLToPath(import.meta.url)));

interface Edit {
  path: string;
  next: string;
}

function planFileEdit(path: string, transform: (text: string) => string): Edit | null {
  if (!existsSync(path)) {
    throw new NativeProjectFileError(
      `${relative(WORKSPACE, path)} does not exist. Run "npx cap add ios" / "npx cap add android" first.`,
    );
  }
  const current = readFileSync(path, 'utf8');
  const next = transform(current);
  return next === current ? null : { path, next };
}

function main(): void {
  const profile = loadAppProfile(WORKSPACE);
  const gradlePath = join(WORKSPACE, 'android/app/build.gradle');
  const ios = iosIdentity(profile);
  // The namespace is the project's own and is read rather than written, so this
  // script holds no app identity of its own (design rule 1).
  const android = androidIdentity(profile, gradleNamespace(readFileSync(gradlePath, 'utf8')));

  console.log(`app profile: ${profile.id}`);
  console.log(`  app id    : ${profile.appId}`);
  console.log(`  app name  : ${profile.appName}`);
  console.log(`  server url: ${profile.serverUrl}`);
  console.log(`  schemes   : ${ios.urlSchemes.join(', ')}`);
  console.log(`  app links : ${ios.associatedDomains.join(', ')} / ${android.appLinkHost}`);

  const edits: (Edit | null)[] = [
    planFileEdit(join(WORKSPACE, 'ios/App/App.xcodeproj/project.pbxproj'), (text) =>
      withBundleIdentifier(text, ios.bundleId),
    ),
    planFileEdit(join(WORKSPACE, 'ios/App/App/Info.plist'), (text) =>
      withPlistUrlSchemes(withPlistString(text, 'CFBundleDisplayName', ios.displayName), ios.urlSchemes),
    ),
    // #1076 (WP4): the `associated-domains` entitlement. Written here for the
    // reason the Bundle ID is — Xcode seeds the file once and a capability
    // ticked in its UI would keep the previous profile's host.
    planFileEdit(join(WORKSPACE, 'ios/App/App/App.entitlements'), (text) =>
      withAssociatedDomains(text, ios.associatedDomains),
    ),
    planFileEdit(gradlePath, (text) =>
      withGradleApplicationId(text, android.applicationId),
    ),
    planFileEdit(join(WORKSPACE, 'android/app/src/main/res/values/strings.xml'), (text) =>
      withAndroidStrings(text, {
        appName: android.appName,
        packageName: android.applicationId,
        customUrlScheme: android.customUrlScheme,
        appLinkHost: android.appLinkHost,
      }),
    ),
  ];

  let changed = 0;
  for (const edit of edits) {
    if (!edit) continue;
    writeFileSync(edit.path, edit.next);
    console.log(`  updated ${relative(WORKSPACE, edit.path)}`);
    changed += 1;
  }

  changed += copyFirebaseConfig(profile.id);

  console.log(changed === 0 ? '  already up to date' : `  ${changed} file(s) written`);
  console.log('Run "npm run sync" to copy the configuration into both platforms.');
}

/**
 * Firebase config is per app profile and never committed (design rule 1 and
 * `.gitignore`), so it is *copied* when the profile directory has it and
 * reported as missing when it does not — a build without it still launches
 * (the AppDelegate only calls `FirebaseApp.configure()` when the plist is in
 * the bundle, and Gradle only applies the google-services plugin when the JSON
 * is there), it just cannot receive a push.
 */
function copyFirebaseConfig(profileId: string): number {
  const sources: [string, string][] = [
    [
      join(WORKSPACE, 'profiles', profileId, 'google-services.json'),
      join(WORKSPACE, 'android/app/google-services.json'),
    ],
    [
      join(WORKSPACE, 'profiles', profileId, 'GoogleService-Info.plist'),
      join(WORKSPACE, 'ios/App/App/GoogleService-Info.plist'),
    ],
  ];
  let copied = 0;
  for (const [from, to] of sources) {
    if (!existsSync(from)) {
      console.log(
        `  no ${relative(WORKSPACE, from)} — push will not be delivered for this build (see docs/mobile-runbook.md)`,
      );
      continue;
    }
    copyFileSync(from, to);
    console.log(`  copied ${relative(WORKSPACE, from)} -> ${relative(WORKSPACE, to)}`);
    copied += 1;
  }
  return copied;
}

try {
  main();
} catch (err) {
  if (
    err instanceof AppProfileError ||
    err instanceof NativeProjectFileError ||
    err instanceof NativeIdentityError
  ) {
    console.error(`profile:apply failed — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
