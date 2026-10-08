/**
 * #1073 (mobile app WP2) — the **one** module that says whether the Members App
 * is running inside the native shell, and every rule that answer feeds.
 *
 * `docs/mobile-app.md` design rule 3: *everything native sits behind one module;
 * a plain browser never executes native code.* This is that module. It is pure —
 * no React, no router, no plugin import, no `t()` call of its own — so a page or
 * a component asks it rather than reading `window.Capacitor`, sniffing a user
 * agent or keeping a flag of its own, exactly as `lib/memberLocale.ts` is the
 * one place a language decision is taken (#1039) and `lib/memberChrome.ts` the
 * one place a colour is spelled (#983).
 *
 * The plugins themselves are `lib/nativePlugins.ts`'s, which is the only module
 * that imports one: a plugin package evaluated on the server, or in a browser
 * that has no bridge, is the way "native code in the web build" gets in.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **Detection and the platform that is registered are one answer.** `isNative()`
 * is true for exactly the platforms `member_device_tokens.platform` accepts
 * (`ios` | `android`, `DEVICE_PLATFORMS` in `api/src/domain/deviceTokens.ts`,
 * mirrored by `chk_mdt_platform`), because the same value that makes the app
 * "native" is the one `POST /me/devices` is called with. A future Capacitor
 * target (`electron`) therefore reads as **not** native here rather than
 * registering a platform the API would refuse — which is a refusal the member
 * could never see, since the registration is fire-and-forget.
 *
 * **Nothing is coerced on the way to the API.** `deviceRegistrationBody()`
 * answers `null` for anything that could not be a registration instead of
 * sending a body that `parseDeviceRegistration()` would 400: the API is still the
 * one place a body is *judged* (CLAUDE.md), and this is only the client
 * declining to ask a meaningless question.
 *
 * **A link decides a path, never a page.** `appUrlOpenPath()` turns the URL the
 * shell hands us into an in-app path and returns it; navigating is the caller's,
 * so the rule is assertable without a router and there is one place that knows an
 * invitation link is `/{locale}/link?gym_id=…&__clerk_ticket=…` under whichever
 * locale the link was written in.
 *
 * **The Google client ids are configuration, never literals.** Design rule 1 is
 * that no app identity is hard-coded; `googleNativeConfig()` reads them from the
 * environment and answers `null` when the deployment has not set them, which is
 * what makes the native button *absent* rather than broken in a build that
 * cannot use it.
 */

// The Members App's languages are declared once (`lib/memberLocale.ts`, #1039
// §2), and `appUrlOpenPath()` has to recognise the locale segment a link
// carries — so it reads that list rather than keeping a second one.
import { MEMBER_LOCALES } from './memberLocale';

/**
 * The platforms the native shell runs on — the same closed set as the API's
 * `DEVICE_PLATFORMS`, for the reason above. Adding one here means adding it
 * there and to `chk_mdt_platform` beside it.
 */
export const NATIVE_PLATFORMS = ['ios', 'android'] as const;

export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export function isNativePlatform(value: unknown): value is NativePlatform {
  return typeof value === 'string' && (NATIVE_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The shape of the bridge Capacitor injects into the WebView.
 *
 * Deliberately structural and entirely optional: on a **remote** page the bridge
 * is injected by the native side and is not the `@capacitor/core` object the
 * package exports (the spike's own finding — a remote page does not get
 * `registerPlugin` from it), so reading the object rather than importing it is
 * what keeps this module free of a plugin dependency and makes both shapes
 * answerable.
 */
export interface NativeBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  platform?: string;
}

/** The bridge's own platform string, or `null` when there is no bridge at all. */
export function bridgePlatform(bridge: NativeBridge | null | undefined): string | null {
  if (!bridge) return null;
  try {
    const reported = typeof bridge.getPlatform === 'function' ? bridge.getPlatform() : bridge.platform;
    return typeof reported === 'string' && reported.trim() ? reported.trim().toLowerCase() : null;
  } catch {
    // A bridge that throws is a bridge we cannot trust to run native code
    // through, which is the same answer as not having one.
    return null;
  }
}

/**
 * Which native platform a bridge reports, or `null` for the web.
 *
 * Taken from the platform string rather than from `isNativePlatform()`, so the
 * value this returns is the value a device registration carries — see the
 * module comment.
 */
export function bridgeNativePlatform(bridge: NativeBridge | null | undefined): NativePlatform | null {
  const platform = bridgePlatform(bridge);
  return isNativePlatform(platform) ? platform : null;
}

/** Pure counterpart of `isNative()`, for a bridge the caller already holds. */
export function isNativeBridge(bridge: NativeBridge | null | undefined): boolean {
  return bridgeNativePlatform(bridge) !== null;
}

function currentBridge(): NativeBridge | null {
  if (typeof globalThis === 'undefined') return null;
  return ((globalThis as any).Capacitor ?? null) as NativeBridge | null;
}

/**
 * Is this page running inside the native shell?
 *
 * `false` on the server and in every plain browser, including a PWA installed
 * from the same URL: there is no bridge there, so no native code path is
 * reachable. A component that *renders* differently when native resolves this
 * after mount (`useIsNative()`), never during render, or the server's `false`
 * and the client's `true` would be a hydration mismatch.
 */
export function isNative(): boolean {
  return isNativeBridge(currentBridge());
}

/** The platform the shell reports, or `null` on the web. */
export function nativePlatform(): NativePlatform | null {
  return bridgeNativePlatform(currentBridge());
}

/** The body `POST /me/devices` takes (#1072). `app_id` is omitted when the shell
 * does not name one, so the API applies its own `MOBILE_DEFAULT_APP_ID` default
 * rather than this app shipping a second copy of it. */
export interface DeviceRegistrationBody {
  platform: NativePlatform;
  token: string;
  app_id?: string;
}

/**
 * The registration for a push token, or `null` when there is nothing to
 * register: no native platform, or a blank token. Both refusals are about not
 * asking a meaningless question — a blank token would occupy the API's
 * `UNIQUE (platform, token)` and could never be delivered to.
 */
export function deviceRegistrationBody(
  platform: NativePlatform | null | undefined,
  token: string | null | undefined,
  appId?: string | null,
): DeviceRegistrationBody | null {
  if (!isNativePlatform(platform)) return null;
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return null;
  const app = typeof appId === 'string' ? appId.trim() : '';
  return app ? { platform, token: trimmed, app_id: app } : { platform, token: trimmed };
}

/**
 * The in-app path for a URL the shell opened the app with (`appUrlOpen`), or
 * `null` when there is nothing to navigate to.
 *
 * An invitation link is `/{locale}/link?gym_id=…&__clerk_ticket=…` (WP4 makes it
 * a universal link; until then it arrives through a custom scheme), so the query
 * is what carries the invitation and is preserved verbatim — dropping it would
 * turn a working invitation into "no invitation found". The **link's own** locale
 * is kept when it has one and the app's current locale is used when it does not:
 * swapping it would move a member who was invited in Spanish into the language
 * the app happens to be showing.
 *
 * The origin is deliberately not checked. A universal link can only reach the app
 * from a domain the app is associated with (WP4's association files), and a
 * custom scheme carries no meaningful origin at all, so the host says nothing
 * this module could verify — and the result is always a path inside this app,
 * never an external navigation.
 */
export function appUrlOpenPath(
  url: string | null | undefined,
  locale: string,
  locales: readonly string[] = MEMBER_LOCALES,
): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  // A custom-scheme link (`com.cordel.fitness://link?gym_id=…`) has no authority:
  // `URL` parses its first segment as the *host*, so prepending it is what makes
  // the two link shapes one rule. For `http(s)` the host is the domain and says
  // nothing about the path.
  const isWebUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!isWebUrl && parsed.hostname) segments.unshift(parsed.hostname);
  const first = segments[0]?.toLowerCase();
  if (first && locales.includes(first)) segments[0] = first;
  else segments.unshift(locale);
  return `/${segments.join('/')}${parsed.search}${parsed.hash}`;
}


/**
 * Where a **tapped notification** opens the app: the Alerts page, in the app's
 * current locale.
 *
 * Not a per-type destination. The push `data` block carries `type`, `entity_type`
 * and `entity_id` (`buildPushMessage()`, #1072) precisely so a later ticket can
 * route on them, but the Members App declares no per-type screen today, and
 * guessing one would send a member to a page that does not answer the alert they
 * tapped. `/notifications` is the page that lists all of them, which is what
 * this ticket asks for.
 */
export function notificationTapPath(locale: string): string {
  return `/${locale}/notifications`;
}

/**
 * What `@capgo/capacitor-social-login` is initialised with for Google.
 *
 * `iOSServerClientId` is the **web** OAuth client — the one Clerk holds — so the
 * ID token's `aud` is the audience Clerk verifies against. That is the single
 * fact the 2026-10-04 spike turned on: with only `iOSClientId` the token is
 * issued for the iOS client and Clerk rejects it.
 */
export interface GoogleNativeConfig {
  iOSClientId?: string;
  iOSServerClientId?: string;
  webClientId?: string;
}

/**
 * The Google configuration for this platform, or `null` when the deployment has
 * not provided it.
 *
 * `null` is a real answer rather than a failure: the native sign-in button is not
 * rendered at all in a build with no client ids, so a member sees the ordinary
 * sign-in form instead of a button that cannot work. Design rule 1 — the ids are
 * build-time configuration, never literals in the code, which is also what lets
 * a stage-2 per-gym app be another build rather than another branch.
 */
export function googleNativeConfig(
  env: Record<string, string | undefined>,
  platform: NativePlatform | null | undefined,
): GoogleNativeConfig | null {
  const iosClientId = (env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '').trim();
  const webClientId = (env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();

  if (platform === 'ios') {
    // Both, for the `aud` reason above: the iOS client identifies the app, the
    // web client is the audience Clerk accepts.
    if (!iosClientId || !webClientId) return null;
    return { iOSClientId: iosClientId, iOSServerClientId: webClientId, webClientId };
  }
  if (platform === 'android') {
    // Android's token is requested for the web client directly.
    if (!webClientId) return null;
    return { webClientId };
  }
  return null;
}

/**
 * The ID token out of the plugin's `login()` result, or `null`.
 *
 * Read defensively and in one place: the token is the whole value of the native
 * round trip, the plugin nests it under `result` and a provider that answers
 * without one (a cancelled sheet) must read as "no token" rather than as a token
 * of `undefined` handed to Clerk.
 */
export function googleIdToken(result: unknown): string | null {
  const source = (result ?? {}) as Record<string, any>;
  const candidate = source?.result?.idToken ?? source?.idToken ?? null;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * What `@capgo/capacitor-social-login` is initialised with for Apple (#1075,
 * mobile app WP3b).
 *
 * Apple has no client id on the native side — the sheet is the OS's, bound to
 * the app's Bundle ID and its *Sign in with Apple* capability — so the one
 * "is this configured" signal is `NEXT_PUBLIC_APPLE_SIGN_IN`. It is a build-time
 * switch for the reason the Google ids are (design rule 1), and it is **off by
 * default**: a build that turns it on without the capability on the App ID would
 * show a button that fails when tapped, which WP2's rule forbids.
 *
 * Only iOS answers: guideline 4.8 is an App Store rule, Android is unaffected,
 * and the web keeps Clerk's own Apple button.
 */
export interface AppleNativeConfig {
  /** Reserved for the plugin's `apple` options; none are needed today. */
  readonly enabled: true;
}

export function appleNativeConfig(
  env: Record<string, string | undefined>,
  platform: NativePlatform | null | undefined,
): AppleNativeConfig | null {
  if (platform !== 'ios') return null;
  const flag = (env.NEXT_PUBLIC_APPLE_SIGN_IN ?? '').trim().toLowerCase();
  return flag === 'true' || flag === '1' ? { enabled: true } : null;
}

/**
 * The identity token out of the plugin's `login()` result for Apple, or `null`.
 *
 * Same defensive reading as `googleIdToken()`, kept as its own function so the
 * two providers can diverge (the spike has not yet shown what Clerk accepts for
 * Apple): a cancelled sheet is `null`, never a token of `undefined`.
 */
export function appleIdToken(result: unknown): string | null {
  const source = (result ?? {}) as Record<string, any>;
  const candidate = source?.result?.idToken ?? source?.idToken ?? null;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * The app's own id — the Bundle ID (iOS) or package name (Android) — out of what
 * Capacitor's `App.getInfo()` answers, or `null`.
 *
 * #1077: a push registration used to name no `app_id`, so the API filed every
 * token under its default (`com.cordel.fitness`) whichever app sent it, and a dev
 * app (`com.cordel.fitness.dev`) would have been delivered to with the pro app's
 * credentials, or not at all. The app already knows what it is installed as; this
 * reads it defensively (`getInfo()` answers an object, and anything else is "do
 * not say" rather than an invented id, which the API then resolves to its default).
 */
export function appIdFromInfo(info: unknown): string | null {
  const id = (info as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * #1285 — what went wrong in a native sign-in, as one short line for a developer.
 *
 * The hook used to swallow the error, so a failed Google sign-in showed the same
 * notice whether the sheet, the token or Clerk had refused. A Clerk error carries
 * `errors[0].code` / `longMessage`; anything else its own `message`. Pure: the
 * hook decides whether to show it (development builds only).
 */
export function signInErrorDetail(err: unknown): string {
  const e = err as { errors?: Array<{ code?: string; longMessage?: string; message?: string }>; message?: unknown } | null;
  const clerk = e?.errors?.[0];
  if (clerk) {
    const parts = [clerk.code, clerk.longMessage ?? clerk.message].filter((v) => typeof v === 'string' && v.trim());
    if (parts.length) return parts.join(': ').slice(0, 300);
  }
  if (typeof e?.message === 'string' && e.message.trim()) return e.message.trim().slice(0, 300);
  return typeof err === 'string' && err.trim() ? err.trim().slice(0, 300) : 'unknown error';
}
