/**
 * #1074 (mobile app WP3) — the **one** place that says what a resolved app
 * profile means for the two native projects.
 *
 * `capacitor.config.ts` covers what Capacitor itself reads (`appId`, `appName`,
 * `server.url`, `server.allowNavigation`); everything else about an app's
 * identity lives in files Capacitor generates once and never rewrites — the
 * Xcode project's `PRODUCT_BUNDLE_IDENTIFIER`, `Info.plist`'s display name and
 * URL schemes, Gradle's `namespace`/`applicationId`, `strings.xml`. Those are
 * what `scripts/apply-profile.ts` writes, and this module is what it asks:
 * pure, so the values a build lands on are assertable without a macOS machine
 * (`api/src/test/mobile-shell-profile.unit.test.ts`).
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * **The Google URL scheme is derived, never configured.** Google's iOS SDK
 * requires the app to register the *reversed* client id, and it is a mechanical
 * transform of the id itself (`123-abc.apps.googleusercontent.com` →
 * `com.googleusercontent.apps.123-abc`). Asking a profile for it as a second
 * field is how the two come to disagree, which fails at the moment a member
 * taps Google and the redirect has nowhere to land.
 *
 * **A build with no Google id registers no Google scheme.** WP2's rule is that
 * the native button is absent rather than broken in such a build
 * (`googleNativeConfig()` answers `null`), so the shell must not register a
 * scheme for a sign-in it cannot do — and an empty `CFBundleURLTypes` entry is
 * exactly the kind of half-configured plist that makes a store build fail
 * validation.
 *
 * **The app's own scheme is always registered.** It is how a link reaches the
 * app before WP4's universal links exist, and `appUrlOpenPath()` (WP2) already
 * reads a custom-scheme URL as an in-app path — the shell is the half that has
 * to declare it.
 */

import type { AppProfile } from './appProfile';

/** A Google OAuth client id's reversed form, or `null` when there is no id. */
export function reversedGoogleClientId(clientId: string | null | undefined): string | null {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  if (!id) return null;
  const parts = id.split('.');
  // Anything that is not a Google client id is not reversed into something that
  // looks like one: a profile holding a placeholder must fail visibly at apply
  // time rather than register a scheme nothing will ever call back on.
  if (parts.length < 2) return null;
  return parts.reverse().join('.');
}

/**
 * Every URL scheme the app registers, in the order a plist lists them: the
 * app's own first (links), then Google's (sign-in) when the build has an id.
 */
export function urlSchemes(profile: AppProfile): string[] {
  const schemes = [profile.customUrlScheme];
  const google = reversedGoogleClientId(profile.googleIosClientId);
  if (google && !schemes.includes(google)) schemes.push(google);
  return schemes;
}

/** The values the iOS project carries for a profile. */
export interface IosIdentity {
  bundleId: string;
  displayName: string;
  urlSchemes: string[];
}

export function iosIdentity(profile: AppProfile): IosIdentity {
  return {
    bundleId: profile.appId,
    displayName: profile.appName,
    urlSchemes: urlSchemes(profile),
  };
}

/** The values the Android project carries for a profile. */
export interface AndroidIdentity {
  /** Gradle's `applicationId` — what the Play Store and FCM identify the app by. */
  applicationId: string;
  /**
   * Gradle's `namespace` — the package the generated `R` and `BuildConfig`
   * classes live in. It is the **template's** package and is deliberately *not*
   * the profile's: the generated Java/Kotlin sources are checked in under that
   * directory, so moving it would mean moving files rather than editing a
   * value, and Android has allowed the two to differ since AGP 7.
   */
  namespace: string;
  appName: string;
  /** The scheme an intent filter accepts, for links before WP4. */
  customUrlScheme: string;
}

export function androidIdentity(profile: AppProfile, templateNamespace: string): AndroidIdentity {
  return {
    applicationId: profile.appId,
    namespace: templateNamespace,
    appName: profile.appName,
    customUrlScheme: profile.customUrlScheme,
  };
}
