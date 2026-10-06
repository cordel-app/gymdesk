import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS, esES, caES } from '@clerk/localizations';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { GymProvider } from '@/context/GymContext';
import { CenterProvider } from '@/context/CenterContext';
import { ImpersonationProvider } from '@/context/ImpersonationContext';
import { FeatureFlagsProvider } from '@/context/FeatureFlagsContext';
import { AppShell } from '@/components/AppShell';
import { ToastProvider } from '@/components/Toast';
import { ThemeProvider } from '@/components/ThemeProvider';
import { publicAppTitle } from '@/lib/appTitle';

// #1114 — the browser title names the application and the environment
// (`(Dev) Admin - Cordel.tech Fitness`), and `lib/appTitle.ts` is the one place
// it is composed. Nothing here spells it: a literal would make the two apps'
// titles two things to keep in step, and this app has no say in which
// environment it is deployed to.
export const metadata: Metadata = {
  title: publicAppTitle(),
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
        <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: 'var(--gd-app-bg, #f5f5f5)', color: 'var(--gd-text, #111827)', fontSize: 16 }}>
          <NextIntlClientProvider messages={messages}>
            <ToastProvider>
              <ImpersonationProvider>
                <GymProvider>
                  <CenterProvider>
                    <FeatureFlagsProvider>
                      <ThemeProvider>
                        <AppShell>{children}</AppShell>
                      </ThemeProvider>
                    </FeatureFlagsProvider>
                  </CenterProvider>
                </GymProvider>
              </ImpersonationProvider>
            </ToastProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
