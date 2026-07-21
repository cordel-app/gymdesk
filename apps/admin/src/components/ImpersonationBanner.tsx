'use client';

import { useTranslations } from 'next-intl';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';

export function ImpersonationBanner() {
  const t = useTranslations('impersonation');
  const { session, isImpersonating, stopImpersonation } = useImpersonation();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  if (!isImpersonating || !session) return null;

  async function handleStop() {
    if (!session) return;
    const durationSeconds = Math.round((Date.now() - session.startedAt) / 1000);
    try {
      await apiFetch('/platform/impersonation/stop', {
        method: 'POST',
        body: JSON.stringify({
          impersonated_user_id: session.effectiveUserId,
          impersonated_user_name: session.effectiveName,
          impersonated_role: session.effectiveRole,
          duration_seconds: durationSeconds,
        }),
      });
    } catch {
      // Audit failure should not block stopping the session
    }
    stopImpersonation();
    toast(t('stopped'));
  }

  return (
    <div style={{
      background: '#b45309',
      color: '#fff',
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      fontSize: 14,
      flexWrap: 'wrap',
      zIndex: 1000,
      position: 'relative',
    }}>
      <span>
        <strong>{t('impersonating_label')}</strong>{' '}
        {session.effectiveName} ({session.effectiveRole})
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
          padding: '4px 14px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {t('stop_button')}
      </button>
    </div>
  );
}
