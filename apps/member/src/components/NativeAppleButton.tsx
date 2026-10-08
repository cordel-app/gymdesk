'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useClerk } from '@clerk/nextjs';
import { appleIdToken, appleNativeConfig, nativePlatform } from '@/lib/native';
import { signInWithAppleToken } from '@/lib/nativeSignIn';
import { loadSocialLogin } from '@/lib/nativePlugins';
import { useIsNative } from '@/lib/useIsNative';
import { memberTheme, noticeStyle, secondaryButtonStyle } from '@/lib/memberChrome';

/**
 * #1075 (mobile app WP3b) — "Continue with Apple" **inside the iOS app**.
 *
 * App Store guideline 4.8 asks for an equivalent privacy-preserving login when
 * the app offers a third-party one (Google), and this is that option. It is
 * `NativeGoogleButton`'s twin and obeys the same rules.
 *
 * **It does not exist on the web, on Android, or in a build that cannot use it.**
 * `appleNativeConfig()` answers `null` unless the platform is iOS and the
 * deployment turned `NEXT_PUBLIC_APPLE_SIGN_IN` on, and a `null` config renders
 * nothing: a member keeps the ordinary form rather than a control that fails.
 *
 * **A cancelled sheet is not an error.** No token means the member dismissed it.
 *
 * **Clerk is handed the token and nothing else**, through
 * `signInWithAppleToken()` — the one function the spike may change. A member who
 * chose *Hide My Email* arrives with a relay address; they are linked by the
 * invitation's member id (`POST /me/link`, #1075 stage 1), not by that address.
 */
export function NativeAppleButton() {
  const native = useIsNative();
  const t = useTranslations('native');
  const clerk = useClerk();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const platform = native ? nativePlatform() : null;
  const config = appleNativeConfig(
    { NEXT_PUBLIC_APPLE_SIGN_IN: process.env.NEXT_PUBLIC_APPLE_SIGN_IN },
    platform,
  );

  if (!native || !config) return null;

  async function signIn() {
    setFailed(false);
    setBusy(true);
    try {
      const socialLogin = (await loadSocialLogin())?.plugin ?? null;
      if (!socialLogin) {
        setFailed(true);
        return;
      }
      await socialLogin.initialize({ apple: {} });
      const result = await socialLogin.login({ provider: 'apple', options: {} });
      const token = appleIdToken(result);
      if (!token) return;
      await signInWithAppleToken(clerk, token);
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
        {busy ? t('signing_in') : t('continue_with_apple')}
      </button>
      {failed && <p style={{ ...noticeStyle('error'), margin: 0 }}>{t('apple_failed')}</p>}
    </div>
  );
}
