import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS, esES, caES } from '@clerk/localizations';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { AppProvider } from '@/context/AppContext';
import { ImpersonationProvider } from '@/context/ImpersonationContext';
import { FeatureFlagsProvider } from '@/context/FeatureFlagsContext';
import { TopBar } from '@/components/TopBar';
import { GymSwitcher } from '@/components/GymSwitcher';
import { ThemeProvider } from '@/components/ThemeProvider';
import { MembersBackground } from '@/components/MembersBackground';
import { AdminBar } from '@/components/AdminBar';
import { MemberLocalePreference } from '@/components/MemberLocalePreference';
import { NativeShell } from '@/components/NativeShell';
import { NativeAppState } from '@/components/NativeAppState';
import { memberTheme, safeArea } from '@/lib/memberChrome';
import { publicAppTitle } from '@/lib/appTitle';

// #1114 — the browser title names the application and the environment
// (`(Dev) Members - Cordel.tech Fitness`), and `lib/appTitle.ts` is the one
// place it is composed. Nothing here spells it: a literal would make the two
// apps' titles two things to keep in step, and this app has no say in which
// environment it is deployed to. The installed app's own name is not this —
// that is `public/manifest.json` for the PWA and the mobile profile for the
// store build (#1074).
/**
 * #1077: the viewport is Next's to emit, and it must say `viewport-fit=cover`.
 *
 * It used to be a hand-written `<meta name="viewport">` in `<head>`, and Next adds
 * its own default one (`width=device-width, initial-scale=1`) *first* — so the page
 * carried two, and WebKit kept the first. Without `viewport-fit=cover` iOS reports
 * `env(safe-area-inset-top)` as `0`, so inside the native shell (which lets the page
 * extend under the status bar) the header sat behind the clock and the dynamic
 * island. Android has no such inset, which is why it looked right there. The
 * `viewport` export makes Next emit the one tag with the right value.
 */
/**
 * `maximumScale: 1` stops iOS from zooming into a field it considers too small
 * (under 16px) when it is focused. The zoom is not undone when the field blurs,
 * so after the impersonation dialog's search box (or the gym selector) the whole
 * page stayed ~8% too wide, shifted off the left edge and with its right edge cut.
 * It is the same remedy the native shell relies on; it does not affect text size.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: publicAppTitle(),
  description: 'Your gym, in your pocket.',
  other: {
    // Static metadata, rendered before any gym is resolved, so it cannot
    // follow a Theme: `theme-color` tints the browser's own chrome and is read
    // from the document head at navigation time. Every *painted* surface takes
    // its value from `lib/memberChrome.ts` instead (#983).
    'theme-color': '#18181b',
  },
};

const clerkLocalizations = { en: enUS, es: esES, ca: caES } as const;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const messages = await getMessages();
  const localization =
    clerkLocalizations[params.locale as keyof typeof clerkLocalizations] ?? enUS;

  return (
    <ClerkProvider localization={localization}>
      <html lang={params.locale}>
        <head>
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <link rel="manifest" href="/manifest.json" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        </head>
        {/* #1073: the bottom inset is the page's rather than any one screen's —
            every route's last control would otherwise sit under the iOS home
            indicator, and `env()` is 0px on the web so nothing moves there. The
            top inset belongs to `TopBar`, which has a background to fill it
            with. */}
        <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: memberTheme.pageBackground, color: memberTheme.text, fontSize: 16, paddingBottom: safeArea.bottom }}>
          <NextIntlClientProvider messages={messages}>
            <ImpersonationProvider>
              <AppProvider>
                <FeatureFlagsProvider>
                  <ThemeProvider>
                    <MemberLocalePreference />
                    <NativeShell />
                    <NativeAppState />
                    <MembersBackground />
                    <AdminBar />
                    <TopBar />
                    <GymSwitcher />
                    {children}
                  </ThemeProvider>
                </FeatureFlagsProvider>
              </AppProvider>
            </ImpersonationProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
