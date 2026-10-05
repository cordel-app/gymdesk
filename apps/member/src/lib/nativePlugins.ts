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

/** Capacitor's `App` plugin — `appUrlOpen`, which is how a link reaches the app. */
export async function loadAppPlugin() {
  try {
    const { App } = await import('@capacitor/app');
    return App ?? null;
  } catch {
    return null;
  }
}

/** Capacitor's `PushNotifications` plugin — permissions, the FCM token, taps. */
export async function loadPushNotifications() {
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    return PushNotifications ?? null;
  } catch {
    return null;
  }
}

/** `@capgo/capacitor-social-login` — the native Google sheet the spike proved. */
export async function loadSocialLogin() {
  try {
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    return SocialLogin ?? null;
  } catch {
    return null;
  }
}
