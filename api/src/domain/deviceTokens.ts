/**
 * #1072 (mobile app WP1) — what a **device token** is, and what a registration
 * request may say.
 *
 * One row of `member_device_tokens` (migration 221) is "this member, on this
 * device, in this app, can be reached by push". Everything about the shape of
 * that row that is a *rule* rather than a query lives here, so the route, the
 * sender and the migration cannot disagree about it.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * **The platform vocabulary is closed and is mirrored in SQL.** `ios` | `android`
 * is `DEVICE_PLATFORMS` here and `chk_mdt_platform` beside the table, so a new
 * platform goes in **two** places — adding only the first makes every insert of
 * that platform fail, which is the `member_notifications.type` shape CLAUDE.md
 * already names.
 *
 * **The `app_id` is the registering app's own identity, never a code branch.**
 * `docs/mobile-app.md` design rule 1 is that no app identity is hard-coded, and
 * rule 2 is that the token records which app it came from *from the first
 * migration*, because adding it later is a data migration. So the column exists
 * before the second app does, the default is deployment configuration
 * (`MOBILE_DEFAULT_APP_ID`) rather than a literal in a route, and the sender
 * resolves FCM credentials per `app_id` — a stage-2 per-gym app is then a new
 * profile and a new credential entry, not a change here.
 *
 * **A device belongs to whoever signed in on it last.** The token is the
 * device's, not the member's: an FCM registration token identifies an app
 * installation, so two members sharing a phone (a couple, a gym's demo handset)
 * produce one token and the second sign-in must take it over. That is why
 * `UNIQUE (platform, token)` is global rather than per gym and why the upsert
 * re-points `gym_id`/`member_id` instead of inserting a second row — leaving the
 * first row in place would push the new member's alerts to the old member's
 * account and the old member's to a phone that is no longer theirs.
 */

/**
 * The platforms a token may be registered for. Mirrored by `chk_mdt_platform`
 * (current definition: migration 221); a value outside this list is a 400 on the
 * way in, never a coercion — a token sent to the wrong transport is not
 * delivered at all, and guessing is worse than refusing.
 */
export const DEVICE_PLATFORMS = ['ios', 'android'] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The generic app of stage 1 — "Cordel Fitness", `com.cordel.fitness`
 * (`docs/mobile-app.md` §1). It is the fallback for a registration that names no
 * app, which is every registration until stage 2 exists, and it is spelled here
 * **once** so the migration's column default, the route and the sender all read
 * the same string. A deployment overrides it with `MOBILE_DEFAULT_APP_ID`; the
 * literal is what that variable defaults to, not a second source of truth.
 */
export const DEFAULT_APP_ID = 'com.cordel.fitness';

/** `member_device_tokens.app_id`'s width (migration 221). */
export const APP_ID_MAX_LENGTH = 191;

/**
 * `member_device_tokens.token`'s width (migration 221). An FCM registration
 * token is ~160–200 characters today and Google documents no maximum, so the
 * column is generous and the route refuses anything longer rather than letting
 * MySQL truncate it — a truncated token is a token that silently never delivers.
 */
export const TOKEN_MAX_LENGTH = 512;

/**
 * The default `app_id` this deployment registers a token under. Read per call
 * rather than at module load, so a test (and a `.env` change) can set it without
 * re-importing the module — the same shape `api/src/infra/locale.ts` uses for
 * its own configuration.
 */
export function defaultAppId(): string {
  const raw = process.env.MOBILE_DEFAULT_APP_ID;
  if (typeof raw !== 'string') return DEFAULT_APP_ID;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > APP_ID_MAX_LENGTH) return DEFAULT_APP_ID;
  return trimmed;
}

export interface DeviceRegistration {
  platform: DevicePlatform;
  token: string;
  appId: string;
}

/**
 * Either a refusal or a registration, never both. `registration: null` rather
 * than an absent key so the caller narrows on the value it is about to use
 * (`if (!parsed.registration) return 400`) instead of on the error string's
 * truthiness, which TypeScript cannot use as a discriminant.
 */
export type DeviceRegistrationInput =
  | { error: string; registration: null }
  | { error: null; registration: DeviceRegistration };

/**
 * The one place a `POST /me/devices` body is judged.
 *
 * Every answer is a refusal or a value — nothing is coerced, because each field
 * decides whether a notification reaches a real phone: an unknown `platform`
 * would pick a transport, a blank `token` would store a row that can never be
 * delivered to and would occupy the unique key, and an `app_id` the deployment
 * holds no credentials for is better reported at registration time than
 * discovered as a silent delivery failure a week later. The only default is the
 * `app_id`, per `defaultAppId()` above.
 */
export function parseDeviceRegistration(body: unknown): DeviceRegistrationInput {
  const source = (body ?? {}) as Record<string, unknown>;

  if (!isDevicePlatform(source.platform)) {
    return { error: `platform must be one of: ${DEVICE_PLATFORMS.join(', ')}`, registration: null };
  }

  if (typeof source.token !== 'string') return { error: 'token is required', registration: null };
  const token = source.token.trim();
  if (!token) return { error: 'token is required', registration: null };
  if (token.length > TOKEN_MAX_LENGTH) {
    return { error: `token must be at most ${TOKEN_MAX_LENGTH} characters`, registration: null };
  }

  const rawAppId = source.app_id;
  if (rawAppId !== undefined && rawAppId !== null && typeof rawAppId !== 'string') {
    return { error: 'app_id must be a string', registration: null };
  }
  const trimmedAppId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
  if (trimmedAppId.length > APP_ID_MAX_LENGTH) {
    return { error: `app_id must be at most ${APP_ID_MAX_LENGTH} characters`, registration: null };
  }

  return {
    error: null,
    registration: {
      platform: source.platform,
      token,
      appId: trimmedAppId || defaultAppId(),
    },
  };
}
