import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS, esES, caES } from '@clerk/localizations';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { AppProvider } from '@/context/AppContext';
import { BottomNav } from '@/components/BottomNav';
import { CenterSwitcher } from '@/components/CenterSwitcher';

export const metadata: Metadata = {
  title: 'Gymdesk',
  description: 'Your gym, in your pocket.',
  other: {
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
        </head>
        <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f5f5', fontSize: 16 }}>
          <NextIntlClientProvider messages={messages}>
            <AppProvider gymId={null}>
              <CenterSwitcher />
              <div style={{ paddingBottom: 72 }}>
                {children}
              </div>
              <BottomNav />
            </AppProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
