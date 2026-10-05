'use client';

import { SignIn } from '@clerk/nextjs';
import { NativeGoogleButton } from '@/components/NativeGoogleButton';
import { useIsNative } from '@/lib/useIsNative';
import { memberTheme, safeArea } from '@/lib/memberChrome';

/**
 * What `appearance` hides in the app. Both button shapes, because Clerk renders
 * the block form or the icon form depending on how many connections the instance
 * has, and the divider with them: with Google gone there is nothing left inside
 * the card for an "or" to separate, and every native option sits below it. WP3b
 * (Sign in with Apple) adds a second button down there and revisits this one set.
 */
const NATIVE_SIGN_IN_ELEMENTS = {
  socialButtonsBlockButton__google: { display: 'none' },
  socialButtonsIconButton__google: { display: 'none' },
  dividerRow: { display: 'none' },
} as const;

/**
 * #1073 (mobile app WP2): inside the native shell, Clerk's own "Continue with
 * Google" is **hidden** and `NativeGoogleButton` takes its place.
 *
 * Not a preference — a redirect-based Google sign-in leaves the app (the
 * 2026-10-04 spike: iOS opens the system browser and the session lands in Safari,
 * not in the WebView), so the button that works is the native sheet. Hiding is
 * through Clerk's `appearance`, which is the one place that component's own
 * controls can be addressed; the rest of `<SignIn />` — email, password, the
 * invitation flow — is untouched, and on the web `appearance` is `undefined` and
 * nothing about this screen changes at all.
 */
export default function SignInPage() {
  const native = useIsNative();

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
      <SignIn
        appearance={native ? { elements: NATIVE_SIGN_IN_ELEMENTS } : undefined}
      />
      <div style={{ width: '100%', maxWidth: 400 }}>
        <NativeGoogleButton />
      </div>
    </main>
  );
}
