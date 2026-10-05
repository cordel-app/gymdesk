'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useClerk } from '@clerk/nextjs';
import { googleIdToken, googleNativeConfig, nativePlatform } from '@/lib/native';
import { loadSocialLogin } from '@/lib/nativePlugins';
import { useIsNative } from '@/lib/useIsNative';
import { memberTheme, noticeStyle, secondaryButtonStyle } from '@/lib/memberChrome';

/**
 * #1073 (mobile app WP2) — "Continue with Google" **inside the app**.
 *
 * Clerk's own Google button leaves the app: it is a redirect, so iOS opens the
 * system browser and the session lands in Safari rather than in the WebView
 * (the 2026-10-04 spike's one hard failure). What works, and what this button
 * does, is the native sheet: `@capgo/capacitor-social-login` returns a Google ID
 * token and `Clerk.authenticateWithGoogleOneTap({ token })` turns it into an
 * active session in the WebView, which survives a restart.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **It does not exist on the web.** `useIsNative()` is false on the server and on
 * the first client render, so a browser renders nothing here and keeps Clerk's own
 * button — which the sign-in page hides *only* when native, for the same reason.
 * Web behaviour is unchanged by construction rather than by a flag somebody has
 * to remember to set.
 *
 * **It does not exist in a build that cannot use it either.**
 * `googleNativeConfig()` answers `null` when the Google client ids are not
 * configured, and a `null` config renders no button at all: a member is left with
 * the ordinary email-and-password form rather than a control that fails when
 * tapped. The ids are build-time configuration (`docs/mobile-app.md` design rule
 * 1), never literals here.
 *
 * **A cancelled sheet is not an error.** `googleIdToken()` answers `null` for a
 * result carrying no token, which is what dismissing the Google sheet produces,
 * and the button simply returns to its resting state. Only a real failure — the
 * plugin throwing, or Clerk refusing the token — says so, in one line, in the
 * member's own language.
 *
 * **Clerk is handed the token and nothing else.** No redirect URL, no
 * `window.location`: the session is established in place, and the sign-in page's
 * existing Clerk redirect takes the member on from there, exactly as it does
 * after a password sign-in.
 */
export function NativeGoogleButton() {
  const native = useIsNative();
  const t = useTranslations('native');
  const clerk = useClerk();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const platform = native ? nativePlatform() : null;
  const config = googleNativeConfig(
    {
      NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    },
    platform,
  );

  if (!native || !config) return null;

  async function signIn() {
    // Re-read inside the handler: the early return above narrows the render
    // path, not a hoisted function declaration's capture of it.
    if (!config) return;
    setFailed(false);
    setBusy(true);
    try {
      const socialLogin = await loadSocialLogin();
      if (!socialLogin) {
        setFailed(true);
        return;
      }
      await socialLogin.initialize({ google: config });
      const result = await socialLogin.login({ provider: 'google', options: {} });
      const token = googleIdToken(result);
      // No token means the member dismissed the sheet — nothing happened, and
      // nothing is reported.
      if (!token) return;
      await (clerk as any).authenticateWithGoogleOneTap({ token });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        style={{
          ...secondaryButtonStyle,
          background: memberTheme.secondaryButton,
          padding: '12px 16px',
          fontSize: 15,
          fontWeight: 600,
          opacity: busy ? 0.6 : 1,
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? t('signing_in') : t('continue_with_google')}
      </button>
      {failed && <p style={{ ...noticeStyle('error'), margin: 0 }}>{t('google_failed')}</p>}
    </div>
  );
}
