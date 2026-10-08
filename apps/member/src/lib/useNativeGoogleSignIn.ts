'use client';

import { useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { googleIdToken, googleNativeConfig, nativePlatform, signInErrorDetail } from '@/lib/native';
import { loadSocialLogin } from '@/lib/nativePlugins';
import { useIsNative } from '@/lib/useIsNative';

/**
 * #1073 (mobile app WP2), reshaped by #1077 — the **action** behind "Continue with
 * Google" inside the app, with no button of its own.
 *
 * Clerk's own Google button redirects, and a redirect leaves the app (the
 * 2026-10-04 spike: iOS opens the system browser and the session lands in Safari).
 * What works is the native sheet: `@capgo/capacitor-social-login` returns a Google
 * ID token and `Clerk.authenticateWithGoogleOneTap({ token })` turns it into an
 * active session in the WebView. The sign-in page used to hide Clerk's button and
 * draw a plainer one of its own below the card, so the app and the web had two
 * different-looking login screens. Now Clerk's button stays — its logo, its label,
 * its place above the email field — and the page only **swaps what a tap on it
 * does** for this.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **It is available only in the app, and only when it can work.** `available` is
 * false on the web (`useIsNative()` is `false` on the server and on the first
 * client render, so the web markup is the server's), and false in a build with no
 * Google client ids (`googleNativeConfig()` answers `null`). When it is false the
 * page hides Clerk's Google button in the app — a redirect cannot work there — and
 * leaves it alone on the web.
 *
 * **A cancelled sheet is not an error.** `googleIdToken()` answers `null` for a
 * result carrying no token, which is what dismissing the sheet produces, and
 * nothing is reported. Only a real failure sets `failed`.
 *
 * **Clerk is handed the token and nothing else.** No redirect URL, no
 * `window.location`: the session is established in place and the sign-in page's
 * existing Clerk redirect takes the member on, as after a password sign-in.
 *
 * **The ids are build-time configuration** (`docs/mobile-app.md` design rule 1),
 * never literals here.
 */
export function useNativeGoogleSignIn() {
  const native = useIsNative();
  const clerk = useClerk();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const config = googleNativeConfig(
    {
      NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    },
    native ? nativePlatform() : null,
  );
  const available = native && config !== null;

  async function signIn() {
    if (!config || busy) return;
    setFailed(false);
    setDetail(null);
    setBusy(true);
    try {
      const socialLogin = (await loadSocialLogin())?.plugin ?? null;
      if (!socialLogin) {
        setFailed(true);
        return;
      }
      await socialLogin.initialize({ google: config });
      const result = await socialLogin.login({ provider: 'google', options: {} });
      const token = googleIdToken(result);
      // No token means the member dismissed the sheet — nothing happened.
      if (!token) return;
      await (clerk as any).authenticateWithGoogleOneTap({ token });
    } catch (err) {
      // #1285: the notice is the same for every cause, so the cause is logged
      // and kept for the page to show in development builds.
      console.error('Native Google sign-in failed', err);
      setDetail(signInErrorDetail(err));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return { native, available, busy, failed, detail, signIn };
}
