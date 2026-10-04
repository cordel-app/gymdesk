'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { memberTheme, primaryButtonStyle, sectionCardStyle } from '@/lib/memberChrome';

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 30000;

export default function PaymentSuccessPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { isLinked, loading: appLoading } = useApp();
  const { apiFetch } = useApiClient();
  // #788: both a paid fee and a replaced card come back here. A card update
  // writes no payment at all, so the poll below has to look somewhere else —
  // PAYMENT_OK_URL carries `purpose=card_update` for exactly that.
  const isCardUpdate = useSearchParams().get('purpose') === 'card_update';
  const [status, setStatus] = useState<'processing' | 'done' | 'timeout'>('processing');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }

    const settled = () => {
      setStatus('done');
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };

    const poll = async () => {
      try {
        if (isCardUpdate) {
          const card = await apiFetch<{ last_update: { status: string } | null }>('/me/payment-method');
          if (card.last_update?.status === 'completed') settled();
          return;
        }
        const requests = await apiFetch<Array<{ status: string }>>('/me/payment-requests');
        if (requests.some((r) => r.status === 'completed')) settled();
      } catch {}
    };

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    timeoutRef.current = setTimeout(() => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setStatus((prev) => (prev === 'processing' ? 'timeout' : prev));
    }, TIMEOUT_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [appLoading, isLinked, locale, isCardUpdate]);

  return (
    <main style={styles.container}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={styles.card}>
        {status === 'processing' && (
          <>
            <div style={styles.spinner} />
            <p style={styles.message}>
              {t(isCardUpdate ? 'payment_success.card_processing' : 'payment_success.processing')}
            </p>
          </>
        )}
        {status === 'done' && (
          <>
            <div style={styles.checkmark}>✓</div>
            <p style={{ ...styles.message, color: memberTheme.statusSuccess, fontWeight: 700 }}>
              {t(isCardUpdate ? 'payment_success.card_done' : 'payment_success.done')}
            </p>
          </>
        )}
        {status === 'timeout' && (
          <>
            <p style={{ ...styles.message, color: memberTheme.textMuted }}>
              {t(isCardUpdate ? 'payment_success.card_timeout' : 'payment_success.timeout')}
            </p>
          </>
        )}
        <button style={styles.backBtn} onClick={() => router.push(`/${locale}/membership`)}>
          {t('payment_success.back')}
        </button>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24, maxWidth: 480, margin: '40px auto', textAlign: 'center' },
  card: { ...sectionCardStyle, borderRadius: 16, padding: '40px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  spinner: {
    width: 40, height: 40, borderRadius: '50%',
    border: `3px solid ${memberTheme.separator}`, borderTopColor: memberTheme.primaryButton,
    animation: 'spin 0.8s linear infinite',
    margin: '0 auto 16px',
  },
  checkmark: { fontSize: 40, color: memberTheme.statusSuccess, marginBottom: 12 },
  message: { margin: '0 0 24px', fontSize: 16, color: memberTheme.text },
  backBtn: {
    ...primaryButtonStyle,
    padding: '10px 24px', fontSize: 14, fontWeight: 600,
  },
};
