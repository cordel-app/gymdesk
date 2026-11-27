'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { MemberDialog } from '@/components/MemberDialog';
import { memberTheme, noticeStyle, primaryButtonStyle, secondaryButtonStyle } from '@/lib/memberChrome';
import {
  PAYMENT_GATEWAY_STATUS_PATH,
  shouldShowGatewayWarning,
  warningSeenKey,
  type PaymentGatewayStatus,
} from '@/lib/paymentGatewayWarning';

/**
 * #3512 — the warning shown after sign-in to a member whose Default Payment
 * Method is Automated and who has no MONEI token. Mounted once by the locale
 * layout; it blocks nothing (closing it, or tapping outside, dismisses it) and
 * decides nothing (the API's `registration_required` does).
 *
 * **Register now does nothing in this ticket**: the gateway's registration
 * destination is a later ticket's, so the button is rendered and has no
 * handler — no navigation, no URL, no request.
 */
export function PaymentGatewayWarning() {
  const t = useTranslations('payment_gateway');
  const { sessionId } = useAuth();
  const { gymId, member, isLinked, loading, accessRevoked } = useApp();
  const { apiFetch } = useApiClient();
  const [open, setOpen] = useState(false);

  const memberId = member?.id ?? null;

  useEffect(() => {
    if (loading || !isLinked || accessRevoked || !sessionId || !gymId || memberId == null) return;
    const key = warningSeenKey(sessionId, gymId, memberId);
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {}
    let cancelled = false;
    apiFetch<PaymentGatewayStatus>(PAYMENT_GATEWAY_STATUS_PATH)
      .then((status) => {
        if (cancelled) return;
        try { sessionStorage.setItem(key, '1'); } catch {}
        if (shouldShowGatewayWarning(status)) setOpen(true);
      })
      // A failed read shows nothing: the warning is a courtesy, never a gate.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loading, isLinked, accessRevoked, sessionId, gymId, memberId, apiFetch]);

  if (!open) return null;

  return (
    <MemberDialog
      labelledBy="payment-gateway-warning-title"
      title={t('title')}
      onClose={() => setOpen(false)}
      actions={(
        <>
          <button type="button" style={{ ...styles.button, ...secondaryButtonStyle }} onClick={() => setOpen(false)}>
            {t('close')}
          </button>
          {/* #3512: intentionally no action — the registration flow is a later ticket's. */}
          <button type="button" style={{ ...styles.button, ...primaryButtonStyle }}>
            {t('register_now')}
          </button>
        </>
      )}
    >
      <div role="alert" style={noticeStyle('error')}>{t('notice')}</div>
      <p style={styles.text}>{t('body')}</p>
    </MemberDialog>
  );
}

const styles: Record<string, CSSProperties> = {
  button: { flex: 1, padding: '10px 14px', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' },
  text: { margin: 0, fontSize: 14, color: memberTheme.text },
};
