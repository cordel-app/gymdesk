'use client';

import { useTranslations } from 'next-intl';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { reportImpersonationStopped } from '@/lib/endImpersonation';
import { withSafeArea } from '@/lib/memberChrome';

/**
 * #983 — deliberately outside the Theme, for `AdminBar`'s reason: this is the
 * banner that says somebody is acting as another person, and a gym must not be
 * able to tint it into its own chrome.
 */
export function ImpersonationBanner() {
  const t = useTranslations('impersonation');
  const { session, isImpersonating, stopImpersonation } = useImpersonation();
  const { apiFetch } = useApiClient();

  if (!isImpersonating || !session) return null;

  // The member app only ever impersonates members (#415) — show the translated
  // label rather than the raw role enum.
  const roleLabel = session.effectiveRole === 'member' ? t('type_member') : session.effectiveRole;

  async function handleStop() {
    if (!session) return;
    await reportImpersonationStopped(apiFetch, session);
    stopImpersonation();
  }

  return (
    <div style={{
      background: '#b45309',
      color: '#fff',
      // #1294: same inset as `AdminBar`, which this replaces while impersonating.
      paddingTop: withSafeArea(10, 'top'),
      paddingBottom: 10,
      paddingLeft: withSafeArea(16, 'left'),
      paddingRight: withSafeArea(16, 'right'),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      flexWrap: 'wrap',
    }}>
      <span>
        <strong>{t('impersonating_label')}</strong>{' '}
        {session.effectiveName} ({roleLabel})
        {'  ·  '}
        <strong>{t('signed_in_as')}</strong>{' '}
        {session.authenticatorName}
      </span>
      <button
        onClick={handleStop}
        style={{
          background: 'rgba(255,255,255,0.15)',
          border: '1px solid rgba(255,255,255,0.4)',
          color: '#fff',
          padding: '4px 12px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {t('stop_button')}
      </button>
    </div>
  );
}
