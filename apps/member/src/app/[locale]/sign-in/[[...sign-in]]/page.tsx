'use client';

import { SignIn } from '@clerk/nextjs';
import { NativeAppleButton } from '@/components/NativeAppleButton';
import { appleNativeConfig, nativePlatform } from '@/lib/native';
import { useNativeGoogleSignIn } from '@/lib/useNativeGoogleSignIn';
import { memberTheme, noticeStyle, safeArea } from '@/lib/memberChrome';
import { useTranslations } from 'next-intl';

/**
 * What `appearance` hides in the app **when the native Google sheet is not
 * available** (a build with no Google client ids): Clerk's Google button in both
 * shapes — a redirect cannot work there, so a button that tries it is worse than
 * none — and the divider with it, since nothing is left inside the card for an
 * "or" to separate. When the native sheet *is* available Clerk's button stays, and
 * `onClickCapture` below swaps its action (#1077), so the app and the web show the
 * same screen.
 */
const NO_NATIVE_GOOGLE_ELEMENTS = {
  socialButtonsBlockButton__google: { display: 'none' },
  socialButtonsIconButton__google: { display: 'none' },
  dividerRow: { display: 'none' },
} as const;

/** Clerk's own Apple button, hidden only where the native one takes its place. */
const NATIVE_APPLE_ELEMENTS = {
  socialButtonsBlockButton__apple: { display: 'none' },
  socialButtonsIconButton__apple: { display: 'none' },
} as const;

const APPLE_NATIVE_ENABLED = process.env.NEXT_PUBLIC_APPLE_SIGN_IN;

/**
 * #1073 (mobile app WP2), #1077: inside the native shell a tap on Clerk's own
 * "Continue with Google" runs the **native sheet** instead of Clerk's redirect
 * (`useNativeGoogleSignIn`), which would leave the app for Safari. The button itself
 * is Clerk's, so the web and the app look identical. The swap is a capture-phase
 * click handler on the wrapper that stops the click before Clerk's own handler sees
 * it; on the web `native` is false and the handler does nothing.
 */
export default function SignInPage() {
  const t = useTranslations('native');
  const google = useNativeGoogleSignIn();
  const native = google.native;
  const appleOn = appleNativeConfig(
    { NEXT_PUBLIC_APPLE_SIGN_IN: APPLE_NATIVE_ENABLED },
    native ? nativePlatform() : null,
  );
  const nativeElements = {
    ...(google.available ? {} : NO_NATIVE_GOOGLE_ELEMENTS),
    ...(appleOn ? NATIVE_APPLE_ELEMENTS : {}),
  };

  function swapGoogleForNative(e: React.MouseEvent<HTMLDivElement>) {
    if (!google.available) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.cl-socialButtonsBlockButton__google, .cl-socialButtonsIconButton__google')) {
      e.preventDefault();
      e.stopPropagation();
      void google.signIn();
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        // The sign-in screen renders before `TopBar` exists (it returns null
        // here), so it reserves its own insets.
        padding: `calc(24px + ${safeArea.top}) 24px calc(24px + ${safeArea.bottom})`,
        background: memberTheme.pageBackground,
      }}
    >
      <div style={{ display: 'contents' }} onClickCapture={swapGoogleForNative}>
        <SignIn appearance={native ? { elements: nativeElements } : undefined} />
      </div>
      <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {google.failed && (
          <p style={{ ...noticeStyle('error'), margin: 0 }}>
            {t('google_failed')}
            {/* #1285: the cause. Clerk's own messages are written for the person reading them, and dev has no APP_ENV_LABEL to gate on. */}
            {google.detail && (
              <small style={{ display: 'block', marginTop: 6, opacity: 0.8, wordBreak: 'break-word' }}>{google.detail}</small>
            )}
          </p>
        )}
        <NativeAppleButton />
      </div>
    </main>
  );
}
