/**
 * #1073 (mobile app WP2) — the **only** module in the Members App that imports a
 * Capacitor plugin.
 *
 * `docs/mobile-app.md` design rule 3 is that everything native sits behind one
 * module and a plain browser never executes native code. `lib/native.ts` is the
 * *decision* half of that (pure, so it can be unit-tested and read from
 * anywhere); this is the *access* half, and it is deliberately tiny.
 *
 * Three things about it are the rule rather than the implementation.
 *
 * **Every import is dynamic.** The Members App is server-rendered, and a plugin
 * package evaluated during SSR — or in a browser with no bridge — is exactly the
 * "native code in the web build" rule 3 forbids. `await import()` still puts the
 * package in the bundle, which is what the spike's finding requires: a page
 * loaded from a **remote** URL does not get `registerPlugin` from the injected
 * bridge, so `@capacitor/core` has to ship in the web build. It ships here,
 * pulled in by the plugins that use it, and is executed only inside the native
 * shell.
 *
 * **Nothing here decides anything.** No `isNative()` check, no permission
 * policy, no copy: a caller that has already asked `lib/native.ts` whether it is
 * native loads what it needs. That keeps the two halves separately assertable —
 * the rules in `native.test.ts`, the wiring in `components/NativeShell.tsx`.
 *
 * **A missing plugin is `null`, not a throw.** The shell (WP3) is what installs
 * the native side of each plugin; a web build newer than the shell on a member's
 * phone would otherwise crash the page it is loaded into, which is the one
 * failure mode a remote-loaded app must not have. Push, deep links and Google
 * sign-in each degrade to "not available" on their own.
 */

/**
 * A loaded plugin, **boxed**.
 *
 * Capacitor hands a plugin out as a `Proxy` whose every property is a native
 * method, so the one property JavaScript probes on anything it resolves — `then` —
 * answers `"App.then() is not implemented on android"` (and on iOS). An `async`
 * function that *returns* a plugin, or an `await` of one, resolves a promise with
 * the proxy, so the probe fires and the call **rejects**. Found on 2026-10-08 in
 * the Android emulator (#1077): `appUrlOpen` had no listener and a tapped
 * invitation link never reached the app. Boxing the plugin in a plain object —
 * which has no `then` — is the whole fix, and it is why callers read `.plugin`.
 * Never return, resolve or `await` a bare plugin anywhere in this app.
 */
export interface LoadedPlugin<T> {
  plugin: T;
}

/** Capacitor's `App` plugin — `appUrlOpen`, which is how a link reaches the app. */
export async function loadAppPlugin() {
  try {
    const { App } = await import('@capacitor/app');
    return App ? { plugin: App } : null;
  } catch {
    return null;
  }
}

/** Capacitor's `PushNotifications` plugin — permissions, the FCM token, taps. */
export async function loadPushNotifications() {
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    return PushNotifications ? { plugin: PushNotifications } : null;
  } catch {
    return null;
  }
}

/** `@capgo/capacitor-social-login` — the native Google sheet the spike proved. */
export async function loadSocialLogin() {
  try {
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    return SocialLogin ? { plugin: SocialLogin } : null;
  } catch {
    return null;
  }
}
