import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS, esES, caES } from '@clerk/localizations';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { GymProvider } from '@/context/GymContext';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Gymdesk',
  description: 'Gym Management Backoffice',
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
  const localization = clerkLocalizations[params.locale as keyof typeof clerkLocalizations] ?? enUS;

  return (
    <ClerkProvider localization={localization}>
      <html lang={params.locale}>
        <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f5f5', fontSize: 16 }}>
          <NextIntlClientProvider messages={messages}>
            <GymProvider>
              <AppShell>{children}</AppShell>
            </GymProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
