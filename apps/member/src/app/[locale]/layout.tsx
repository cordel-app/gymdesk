import type { Metadata } from 'next';
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

export const metadata: Metadata = {
  title: 'Gymdesk',
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
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
