'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnStyle } from '@/components/ui';
import { canWriteModule } from '@/config/permissions';

// #599: the gym's website calls POST /public/gyms/:slug/registrations with this
// key. The API returns the plaintext key once, on generate/rotate — it is kept
// in component state only, never persisted, and gone after a reload.

interface IntegrationStatus {
  configured: boolean;
  key_prefix: string | null;
  created_at: string | null;
  slug: string;
  endpoint_path: string;
  endpoint_url: string | null;
}

type PendingAction = 'rotate' | 'revoke' | null;

const cardStyle: React.CSSProperties = {
  background: 'var(--gd-card-bg, #fff)',
  border: '1px solid var(--gd-card-border, #eee)',
  borderRadius: 10,
  padding: 20,
  marginBottom: 18,
};
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 };
const codeStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
  background: 'rgba(0,0,0,0.05)', borderRadius: 6, padding: '9px 12px', overflowWrap: 'anywhere',
};
const secondaryBtn: React.CSSProperties = { padding: '9px 14px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#444' };

export default function WebsiteIntegrationPage() {
  const t = useTranslations('website_integration');
  const { activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'SYSTEM'));

  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiFetch<IntegrationStatus>('/system/website-integration'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, toast, t]);

  useEffect(() => {
    if (gymLoading || !activeGym) return;
    setNewKey(null);
    load();
  }, [gymLoading, activeGym, load]);

  async function generate() {
    setBusy(true);
    try {
      const res = await apiFetch<IntegrationStatus & { key: string }>('/system/website-integration/key', { method: 'POST' });
      const { key, ...rest } = res;
      setStatus(rest);
      setNewKey(key);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      setStatus(await apiFetch<IntegrationStatus>('/system/website-integration/key', { method: 'DELETE' }));
      setNewKey(null);
      toast(t('revoke_success'), 'success');
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(t('copied'), 'success');
    } catch {
      toast(t('copy_failed'));
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const endpoint = status?.endpoint_url ?? status?.endpoint_path ?? '';

  return (
    <div style={{ padding: 28, maxWidth: 760 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t('title')}</h1>
      <p style={{ color: '#666', fontSize: 14, lineHeight: 1.5, marginBottom: 22 }}>{t('intro')}</p>

      {loading && <p style={{ color: '#888' }}>{t('loading')}</p>}

      {!loading && status && (
        <>
          <div style={cardStyle}>
            <div style={labelStyle}>{t('endpoint_label')}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={codeStyle}>POST {endpoint}</code>
              <button style={secondaryBtn} onClick={() => copy(endpoint)}>{t('copy')}</button>
            </div>
            {!status.endpoint_url && <p style={{ color: '#888', fontSize: 12, marginTop: 8 }}>{t('endpoint_path_only')}</p>}
          </div>

          <div style={cardStyle}>
            <div style={labelStyle}>{t('key_label')}</div>

            {newKey && (
              <div style={{ border: '1px solid #e0b100', background: 'rgba(224,177,0,0.08)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('key_shown_once')}</p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={codeStyle}>{newKey}</code>
                  <button style={secondaryBtn} onClick={() => copy(newKey)}>{t('copy')}</button>
                </div>
              </div>
            )}

            {status.configured ? (
              <p style={{ fontSize: 14, marginBottom: 14 }}>
                {t('key_active', { prefix: `${status.key_prefix}…`, date: fmtDate(status.created_at) })}
              </p>
            ) : (
              <p style={{ fontSize: 14, color: '#666', marginBottom: 14 }}>{t('key_none')}</p>
            )}

            {canWrite && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {status.configured ? (
                  <>
                    <button style={btnStyle()} disabled={busy} onClick={() => setPending('rotate')}>{t('rotate')}</button>
                    <button style={btnStyle('#c0392b')} disabled={busy} onClick={() => setPending('revoke')}>{t('revoke')}</button>
                  </>
                ) : (
                  <button style={btnStyle()} disabled={busy} onClick={generate}>{t('generate')}</button>
                )}
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={labelStyle}>{t('how_label')}</div>
            <ol style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 20, margin: 0, color: '#444' }}>
              <li>{t('how_1')}</li>
              <li>{t('how_2')}</li>
              <li>{t('how_3')}</li>
              <li>{t('how_4')}</li>
            </ol>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        message={pending === 'revoke' ? t('confirm_revoke') : t('confirm_rotate')}
        confirmLabel={pending === 'revoke' ? t('revoke') : t('rotate')}
        cancelLabel={t('cancel')}
        busy={busy}
        onConfirm={pending === 'revoke' ? revoke : generate}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
