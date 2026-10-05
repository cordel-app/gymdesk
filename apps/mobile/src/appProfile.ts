/**
 * #1074 (mobile app WP3) — the **one** place an app profile is resolved.
 *
 * `docs/mobile-app.md` design rule 1 is that *no app identity is hard-coded*:
 * the Bundle ID / package name, the display name, the URL the shell loads, the
 * Google OAuth client ids and the Firebase config are build-time
 * configuration, so that stage 2 (an app per gym) is a second **profile** of
 * this one workspace rather than a fork of it. Stage 1 has exactly one profile,
 * `profiles/cordel-fitness.json`.
 *
 * This half is **pure** — no `fs`, no `process`, no Capacitor import — exactly
 * as `apps/member/src/lib/native.ts` is the pure half of WP2's two-module
 * split: `loadAppProfile.ts` beside it is the I/O half that finds the file and
 * reads the environment, and `nativeIdentity.ts` is what the native projects
 * are written from. That is what lets `capacitor.config.ts`, the apply script
 * and the gate in the API suite all ask one implementation.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **The environment overrides the profile, per field.** The ticket asks for
 * `server.url` and `allowNavigation` to come from environment variables; a
 * profile is where an app's own defaults live. So the answer is
 * `env ?? profile`, resolved one field at a time, which means a CI build can
 * point the generic app at a staging URL without editing a profile and a
 * per-gym profile needs no environment at all.
 *
 * **A missing identity is an error, never a default.** `appId`, `appName` and
 * `serverUrl` have no fallback in code: a shell built with no Bundle ID would
 * install over another app's identity, and one built with no URL would open a
 * blank WebView. The one place a literal app identity may appear is a profile
 * file, which is configuration — `api/src/test/mobile-shell-profile.unit.test.ts`
 * fails the build if one appears anywhere else under `apps/mobile/src`.
 *
 * **`allowNavigation` is a list the shell may *navigate* to, and it is not the
 * same question as what the WebView may load.** It is kept exactly as
 * configured, deduplicated and trimmed, because every entry is a host a
 * sign-in flow may bounce through and silently dropping one is how a
 * redirect-based login dead-ends inside the app.
 *
 * **The Google client ids are optional here.** WP2 already decided that the
 * native Google button is *absent* rather than broken in a build that has no
 * ids (`googleNativeConfig()` answers `null`), so this module reports them as
 * `null` rather than refusing to build a shell that can still do email and
 * password.
 */

/** An app profile as a profile file holds it, before any environment override. */
export interface AppProfileInput {
  /** The profile's own id — the file name under `profiles/`. */
  id?: string;
  /** The Bundle ID (iOS) / package name (Android), and `member_device_tokens.app_id`. */
  appId?: string;
  /** What the app is called on the home screen and in the stores. */
  appName?: string;
  /** The deployed Members App the shell loads (`server.url`). */
  serverUrl?: string;
  /** Hosts the WebView may navigate to (`server.allowNavigation`). */
  allowNavigation?: string[];
  /** The iOS OAuth client id, bound to the Bundle ID. */
  googleIosClientId?: string | null;
  /** The **web** OAuth client id — the audience Clerk verifies (the spike's finding). */
  googleWebClientId?: string | null;
  /** The custom URL scheme the app registers, for links before WP4's universal links. */
  customUrlScheme?: string;
}

/** A resolved profile: every field the native projects and the config need. */
export interface AppProfile {
  id: string;
  appId: string;
  appName: string;
  serverUrl: string;
  allowNavigation: string[];
  googleIosClientId: string | null;
  googleWebClientId: string | null;
  customUrlScheme: string;
}

/** The environment variables a build may override a profile with. */
export const PROFILE_ENV_KEYS = {
  profile: 'MOBILE_APP_PROFILE',
  appId: 'MOBILE_APP_ID',
  appName: 'MOBILE_APP_NAME',
  serverUrl: 'MOBILE_SERVER_URL',
  allowNavigation: 'MOBILE_ALLOW_NAVIGATION',
  googleIosClientId: 'MOBILE_GOOGLE_IOS_CLIENT_ID',
  googleWebClientId: 'MOBILE_GOOGLE_WEB_CLIENT_ID',
  customUrlScheme: 'MOBILE_CUSTOM_URL_SCHEME',
} as const;

/** The profile a build uses when the environment does not name one. */
export const DEFAULT_PROFILE_ID = 'cordel-fitness';

export class AppProfileError extends Error {}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A comma- or whitespace-separated environment list, as `allowNavigation` takes it. */
export function parseAllowNavigation(value: string | undefined | null): string[] | null {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return [];
  return dedupe(value.split(/[\s,]+/));
}

function dedupe(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const entry = text(value);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Which profile id a build is for — the environment's, else `cordel-fitness`. */
export function profileIdFromEnv(env: Record<string, string | undefined>): string {
  return text(env[PROFILE_ENV_KEYS.profile]) ?? DEFAULT_PROFILE_ID;
}

/**
 * The profile a build runs with: the file's values, each overridden by its own
 * environment variable.
 *
 * Throws `AppProfileError` for a missing `appId`, `appName` or `serverUrl` —
 * see the module comment. The error names the field and the variable that would
 * supply it, because this runs inside `capacitor.config.ts` and its message is
 * all a `cap sync` prints.
 */
export function resolveAppProfile(
  input: AppProfileInput | null | undefined,
  env: Record<string, string | undefined> = {},
): AppProfile {
  const profile = input ?? {};
  const id = text(env[PROFILE_ENV_KEYS.profile]) ?? text(profile.id) ?? DEFAULT_PROFILE_ID;

  const appId = text(env[PROFILE_ENV_KEYS.appId]) ?? text(profile.appId);
  const appName = text(env[PROFILE_ENV_KEYS.appName]) ?? text(profile.appName);
  const serverUrl = text(env[PROFILE_ENV_KEYS.serverUrl]) ?? text(profile.serverUrl);

  requireField(appId, 'appId', PROFILE_ENV_KEYS.appId, id);
  requireField(appName, 'appName', PROFILE_ENV_KEYS.appName, id);
  requireField(serverUrl, 'serverUrl', PROFILE_ENV_KEYS.serverUrl, id);

  const allowNavigation =
    parseAllowNavigation(env[PROFILE_ENV_KEYS.allowNavigation]) ??
    dedupe(profile.allowNavigation ?? []);

  return {
    id,
    appId: appId as string,
    appName: appName as string,
    serverUrl: serverUrl as string,
    allowNavigation,
    googleIosClientId:
      text(env[PROFILE_ENV_KEYS.googleIosClientId]) ?? text(profile.googleIosClientId),
    googleWebClientId:
      text(env[PROFILE_ENV_KEYS.googleWebClientId]) ?? text(profile.googleWebClientId),
    // The scheme defaults to the app id, which is what a Bundle ID-shaped
    // custom scheme is everywhere else in Capacitor — never to a literal.
    customUrlScheme:
      text(env[PROFILE_ENV_KEYS.customUrlScheme]) ??
      text(profile.customUrlScheme) ??
      (appId as string),
  };
}

function requireField(
  value: string | null,
  field: keyof AppProfileInput,
  envKey: string,
  profileId: string,
): void {
  if (value) return;
  throw new AppProfileError(
    `App profile "${profileId}" has no ${field}. Set it in apps/mobile/profiles/${profileId}.json or pass ${envKey}.`,
  );
}
