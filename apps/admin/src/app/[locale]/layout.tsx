import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS, esES, caES } from '@clerk/localizations';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { GymProvider } from '@/context/GymContext';
import { CenterProvider } from '@/context/CenterContext';
import { AppShell } from '@/components/AppShell';
import { ToastProvider } from '@/components/Toast';
import { ThemeProvider } from '@/components/ThemeProvider';

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
            <ToastProvider>
              <GymProvider>
                <CenterProvider>
                  <ThemeProvider>
                    <AppShell>{children}</AppShell>
                  </ThemeProvider>
                </CenterProvider>
              </GymProvider>
            </ToastProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
