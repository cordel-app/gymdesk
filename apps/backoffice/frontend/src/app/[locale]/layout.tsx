import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { Sidebar } from '@/components/Sidebar';
import { TopHeader } from '@/components/TopHeader';

export const metadata: Metadata = {
  title: 'Gymdesk',
  description: 'Gym Management Backoffice',
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const messages = await getMessages();

  return (
    <html lang={params.locale}>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f5f5', fontSize: 16 }}>
        <NextIntlClientProvider messages={messages}>
          <TopHeader />
          <div style={{ display: 'flex', minHeight: '100vh', paddingTop: 52 }}>
            <Sidebar />
            <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
              {children}
            </main>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
