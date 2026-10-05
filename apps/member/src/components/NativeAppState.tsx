'use client';

import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useIsNative } from '@/lib/useIsNative';
import { memberTheme, primaryButtonStyle, safeArea } from '@/lib/memberChrome';

/**
 * #1073 (mobile app WP2) — what the app shows while it has nothing to show, and
 * what it shows when it cannot reach the gym.
 *
 * Two states the web never needed and the native shell does.
 *
 * **A splash.** The first WebView load on a clean install is very slow — close to
 * a minute in the simulator (`docs/mobile-app.md` §3) — and the page that finally
 * arrives then loads the member's gym, profile and centers before any screen has
 * content. On the web that reads as a fast flash; in a store app, an ellipsis on a
 * blank page reads as a broken download. So while `AppContext` is loading, this
 * covers the screen with the app's own name and a spinner, over the Theme's page
 * background.
 *
 * **An error screen with a retry.** An app loaded from a URL is only as reachable
 * as that URL: if the API cannot be reached the member gets a landing screen that
 * looks like "you have no gym", which is a lie that invites a support call. This
 * says the gym could not be reached and offers the one action that can help —
 * `reload()`, which re-runs the same load rather than reloading the WebView, so
 * the member keeps their session.
 *
 * **Native only, deliberately.** `useIsNative()` is false on the server and on the
 * first client render, so the web build renders nothing here and behaves exactly
 * as it did — which is this ticket's first acceptance criterion. The states
 * themselves are not native concepts, so promoting either to the web later is a
 * one-line change and a decision somebody takes.
 *
 * It declares no colour of its own (#983): every value is `memberChrome`'s, so a
 * gym's Theme paints the first screen of its app too.
 */
export function NativeAppState() {
  const native = useIsNative();
  const t = useTranslations('native');
  const { loading, loadError, reload, isSuperadmin } = useApp();

  // A superadmin in support mode has no member context to load and is not who
  // this screen is for — the bars that tell them whose account they are in are
  // outside the Theme for the same reason.
  if (!native || isSuperadmin) return null;
  if (!loading && !loadError) return null;

  return (
    <div
      role={loadError ? 'alert' : 'status'}
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: `calc(24px + ${safeArea.top}) 24px calc(24px + ${safeArea.bottom})`,
        textAlign: 'center',
        background: memberTheme.pageBackground,
        color: memberTheme.text,
      }}
    >
      {loadError ? (
        <>
          <h1 style={{ margin: 0, fontSize: 20, color: memberTheme.title1 }}>{t('offline_title')}</h1>
          <p style={{ margin: 0, fontSize: 15, color: memberTheme.textMuted, maxWidth: 320 }}>{t('offline_body')}</p>
          <button
            type="button"
            onClick={reload}
            style={{ ...primaryButtonStyle, padding: '12px 24px', fontSize: 15, fontWeight: 600 }}
          >
            {t('retry')}
          </button>
        </>
      ) : (
        <>
          {/* The spinner needs a keyframe, which an inline style cannot declare —
              `CalendarThemeStyles` sets the same precedent for a rule this app
              cannot express inline. The colours stay the Theme's. */}
          <style>{'@keyframes gd-native-spin { to { transform: rotate(360deg); } }'}</style>
          <div
            aria-hidden
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: `3px solid ${memberTheme.separator}`,
              borderTopColor: memberTheme.primaryButton,
              animation: 'gd-native-spin 0.8s linear infinite',
            }}
          />
          <p style={{ margin: 0, fontSize: 15, color: memberTheme.textMuted }}>{t('loading')}</p>
        </>
      )}
    </div>
  );
}
