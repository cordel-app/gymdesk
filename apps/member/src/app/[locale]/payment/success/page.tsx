'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { memberTheme, primaryButtonStyle, sectionCardStyle } from '@/lib/memberChrome';
import { InlineStyle } from '@/components/InlineStyle';
import { isFailedPaymentReturn, paymentErrorPath, paymentIdFromReturn } from '@/lib/paymentReturn';

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
  const searchParams = useSearchParams();
  const purpose = searchParams.get('purpose');
  const isCardUpdate = purpose === 'card_update';
  // Monei returns here on a failure too, with its status in the query: a
  // declined card or a failed 3D Secure check never becomes a completed
  // request, so polling for one would only end in the timeout.
  const failed = isFailedPaymentReturn(searchParams.get('status'));
  const [status, setStatus] = useState<'processing' | 'done' | 'timeout'>('processing');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (failed) { router.replace(paymentErrorPath(locale, purpose)); return; }

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

    // #2087: a 3DS payment leaves the hosted page before it has a result, so
    // this return is where the API is asked to confirm with the provider. The
    // answer only speeds up the poll below; a failure here changes nothing and
    // the webhook remains the fallback.
    const paymentId = paymentIdFromReturn(searchParams);
    if (paymentId) {
      apiFetch<{ status: string }>(`/payment-page/payments/${encodeURIComponent(paymentId)}/confirm`, { method: 'POST' })
        .catch(() => {})
        .finally(poll);
    } else {
      poll();
    }
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    timeoutRef.current = setTimeout(() => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setStatus((prev) => (prev === 'processing' ? 'timeout' : prev));
    }, TIMEOUT_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [appLoading, isLinked, locale, isCardUpdate, failed, purpose]);

  return (
    <main style={styles.container}>
      <InlineStyle css={`@keyframes spin { to { transform: rotate(360deg); } }`} />
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
  card: { ...sectionCardStyle, padding: '40px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
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
