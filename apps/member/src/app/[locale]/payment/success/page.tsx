'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 30000;

export default function PaymentSuccessPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { isLinked, loading: appLoading } = useApp();
  const { apiFetch } = useApiClient();
  const [status, setStatus] = useState<'processing' | 'done' | 'timeout'>('processing');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }

    const poll = async () => {
      try {
        const requests = await apiFetch<Array<{ status: string }>>('/me/payment-requests');
        if (requests.some((r) => r.status === 'completed')) {
          setStatus('done');
          if (intervalRef.current) clearInterval(intervalRef.current);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
        }
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
  }, [appLoading, isLinked, locale]);

  return (
    <main style={styles.container}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={styles.card}>
        {status === 'processing' && (
          <>
            <div style={styles.spinner} />
            <p style={styles.message}>{t('payment_success.processing')}</p>
          </>
        )}
        {status === 'done' && (
          <>
            <div style={styles.checkmark}>✓</div>
            <p style={{ ...styles.message, color: '#1e7e40', fontWeight: 700 }}>
              {t('payment_success.done')}
            </p>
          </>
        )}
        {status === 'timeout' && (
          <>
            <p style={{ ...styles.message, color: '#71717a' }}>
              {t('payment_success.timeout')}
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
  card: { background: '#fff', borderRadius: 16, padding: '40px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  spinner: {
    width: 40, height: 40, borderRadius: '50%',
    border: '3px solid #e4e4e7', borderTopColor: '#18181b',
    animation: 'spin 0.8s linear infinite',
    margin: '0 auto 16px',
  },
  checkmark: { fontSize: 40, color: '#1e7e40', marginBottom: 12 },
  message: { margin: '0 0 24px', fontSize: 16, color: '#18181b' },
  backBtn: {
    background: '#18181b', color: '#fff', border: 'none',
    borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
};
