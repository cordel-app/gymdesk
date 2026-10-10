'use client';

import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { memberTheme, primaryButtonStyle, sectionCardStyle } from '@/lib/memberChrome';

export default function PaymentErrorPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();

  return (
    <main style={styles.container}>
      <div style={styles.card}>
        <div style={styles.icon}>✕</div>
        <h1 style={styles.title}>{t('payment_error.title')}</h1>
        <button style={styles.retryBtn} onClick={() => router.push(`/${locale}/membership`)}>
          {t('payment_error.retry')}
        </button>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24, maxWidth: 480, margin: '40px auto', textAlign: 'center' },
  card: { ...sectionCardStyle, padding: '40px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  icon: { fontSize: 40, color: memberTheme.statusError, marginBottom: 12 },
  title: { margin: '0 0 24px', fontSize: 20, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  retryBtn: {
    ...primaryButtonStyle,
    padding: '10px 24px', fontSize: 14, fontWeight: 600,
  },
};
