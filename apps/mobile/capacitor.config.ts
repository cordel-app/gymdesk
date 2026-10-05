/// <reference types="node" />
import type { CapacitorConfig } from '@capacitor/cli';
import { loadAppProfile } from './src/loadAppProfile';

/**
 * #1074 (mobile app WP3) — the Capacitor shell's configuration.
 *
 * It declares no app identity of its own: every value comes from the app
 * profile this build is for (`MOBILE_APP_PROFILE`, default `cordel-fitness`),
 * with `server.url` and `server.allowNavigation` overridable per build through
 * `MOBILE_SERVER_URL` and `MOBILE_ALLOW_NAVIGATION` — `docs/mobile-app.md`
 * design rule 1, which is what makes stage 2's per-gym app a second profile
 * rather than a fork.
 *
 * `webDir` is `www/`, which holds the one local document this shell owns: the
 * offline notice. The UI is the **deployed** Members App, loaded from
 * `server.url` (§2 of that plan — there is no second front end), so nothing is
 * bundled into the app and a web release reaches a member without a store
 * review.
 */
const profile = loadAppProfile(__dirname);

const config: CapacitorConfig = {
  appId: profile.appId,
  appName: profile.appName,
  webDir: 'www',
  server: {
    url: profile.serverUrl,
    allowNavigation: profile.allowNavigation,
    // The Members App is served over HTTPS in every environment that has a
    // URL worth pointing an app at; allowing cleartext would let a profile
    // that is wrong fail silently over http instead of visibly.
    cleartext: false,
  },
  ios: {
    // The WebView scrolls the page itself; bouncing past the end of a themed
    // page shows the WebView's own background under it.
    scrollEnabled: true,
    contentInset: 'never',
  },
  android: {
    // The spike's first load took close to a minute on a clean install: a
    // mixed-content or cleartext fallback would hide a bad URL rather than
    // surface it.
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      // A push is a courtesy copy of a `member_notifications` row (#1072), so
      // the OS banner is all the shell does with it; the badge the member sees
      // is the Members App's own, refreshed when a push arrives in the
      // foreground (WP2's `NativeShell`).
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
