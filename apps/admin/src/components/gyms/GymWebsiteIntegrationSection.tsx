'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnSmall, primaryBtnSmall } from '@/components/ui';

/**
 * #1052: the gym's Website Integration, administered from
 * **Cordel → Gyms → [Gym]** rather than from the gym's own Configuration group.
 *
 * It is the same configuration it always was, moved: the routes
 * (`GET`/`POST /key`/`DELETE /key` on `/system/website-integration`), the
 * `website_integration` copy in all three languages, the key's once-only
 * display, both confirmations and the audit rows the API already writes are
 * unchanged. What moved is *where it is accessed from*, which is why this
 * section reads the gym the **row** names rather than the selected gym —
 * `apiFetch`'s `gymId` (`apps/admin/src/lib/apiClient.ts`) is the one way a
 * Cordel screen does that, and `tenantContext` is still what decides whether
 * the caller may: a superadmin gets admin on any gym it names, anybody else
 * needs a `gym_memberships` row for it.
 *
 * The section owns its own read because the key state is not in the gym list's
 * row: the endpoint URL is built by the API from `API_PUBLIC_URL` + the gym ref
 * (#645), and building it a second time in the browser would be a second place
 * deciding what a gym's registration endpoint is. It is loaded when the card is
 * expanded, not with the list, so opening Cordel → Gyms stays one request.
 */
export interface WebsiteIntegrationStatus {
  configured: boolean;
  key_prefix: string | null;
  created_at: string | null;
  slug: string;
  gym_ref: string;
  endpoint_path: string;
  endpoint_url: string | null;
}

type PendingAction = 'rotate' | 'revoke' | null;

const ROOT = '/system/website-integration';

/**
 * `canWrite` defaults to offering the write actions, the way a shared section
 * takes its gate as a prop: its one host is Cordel → Gyms, which is already
 * superadmin-only (the page redirects anybody else), so there is no permission
 * for this component to decide — and the server decides it anyway, through
 * `requireModuleWrite('SYSTEM')` on both key routes.
 */
export function GymWebsiteIntegrationSection({ gymId, canWrite = true }: { gymId: string; canWrite?: boolean }) {
  const t = useTranslations('website_integration');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [status, setStatus] = useState<WebsiteIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** The plaintext key, shown once: the API returns it only on generate/rotate. */
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  // The load effect is keyed on the gym, not on these two: a toast function and
  // a translator are not reasons to re-read a gym's key state.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const errorRef = useRef(t('error_generic'));
  errorRef.current = t('error_generic');

  // Keyed on the gym and the client alone: a card expanded on another row is a
  // different gym's status, and nothing else here is worth a second read. The
  // writes below update the status from their own response, so this is the one
  // place that loads it.
  useEffect(() => {
    let cancelled = false;
    setNewKey(null);
    setLoading(true);
    (async () => {
      try {
        const next = await apiFetch<WebsiteIntegrationStatus>(ROOT, { gymId });
        if (!cancelled) setStatus(next);
      } catch (err: any) {
        if (!cancelled) toastRef.current(err.message ?? errorRef.current);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, gymId]);

  async function generate() {
    setBusy(true);
    try {
      const res = await apiFetch<WebsiteIntegrationStatus & { key: string }>(`${ROOT}/key`, { method: 'POST', gymId });
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
      setStatus(await apiFetch<WebsiteIntegrationStatus>(`${ROOT}/key`, { method: 'DELETE', gymId }));
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

  if (loading) return <p style={mutedStyle}>{t('loading')}</p>;
  if (!status) return null;

  const endpoint = status.endpoint_url ?? status.endpoint_path;

  return (
    <div>
      <p style={{ ...mutedStyle, lineHeight: 1.5, marginBottom: 12 }}>{t('intro')}</p>

      <div style={blockStyle}>
        <div style={labelStyle}>{t('endpoint_label')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={codeStyle}>POST {endpoint}</code>
          <button onClick={() => copy(endpoint)} style={btnSmall('#444')}>{t('copy')}</button>
        </div>
        {!status.endpoint_url && <p style={{ ...mutedStyle, marginTop: 6 }}>{t('endpoint_path_only')}</p>}
      </div>

      <div style={blockStyle}>
        <div style={labelStyle}>{t('key_label')}</div>

        {newKey && (
          <div style={newKeyStyle}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>{t('key_shown_once')}</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={codeStyle}>{newKey}</code>
              <button onClick={() => copy(newKey)} style={btnSmall('#444')}>{t('copy')}</button>
            </div>
          </div>
        )}

        {status.configured ? (
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            {t('key_active', { prefix: `${status.key_prefix}…`, date: fmtDate(status.created_at) })}
          </p>
        ) : (
          <p style={{ ...mutedStyle, margin: '0 0 10px' }}>{t('key_none')}</p>
        )}

        {canWrite && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {status.configured ? (
              <>
                <button onClick={() => setPending('rotate')} disabled={busy} style={primaryBtnSmall()}>{t('rotate')}</button>
                <button onClick={() => setPending('revoke')} disabled={busy} style={btnSmall('#c0392b')}>{t('revoke')}</button>
              </>
            ) : (
              <button onClick={generate} disabled={busy} style={primaryBtnSmall()}>{t('generate')}</button>
            )}
          </div>
        )}
      </div>

      <div style={blockStyle}>
        <div style={labelStyle}>{t('how_label')}</div>
        <ol style={{ fontSize: 13, lineHeight: 1.6, paddingLeft: 18, margin: 0, color: '#444' }}>
          <li>{t('how_1')}</li>
          <li>{t('how_2')}</li>
          <li>{t('how_3')}</li>
          <li>{t('how_4')}</li>
          <li>{t('how_5')}</li>
        </ol>
      </div>

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

// ─── Styles ───────────────────────────────────────────────────────────────────
// The gym card's own voice: the label treatment of the sections around it and
// the monospace block the endpoint and the key were already shown in.

const mutedStyle: React.CSSProperties = { fontSize: 12.5, color: '#888', margin: 0 };

const blockStyle: React.CSSProperties = { marginTop: 12 };

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginBottom: 6,
};

const codeStyle: React.CSSProperties = {
  flex: 1, minWidth: 220,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5,
  background: 'rgba(0,0,0,0.05)', borderRadius: 6, padding: '8px 10px', overflowWrap: 'anywhere',
};

/** The once-only key: the same warning tint the old page showed it in. */
const newKeyStyle: React.CSSProperties = {
  border: '1px solid #e0b100', background: 'rgba(224,177,0,0.08)',
  borderRadius: 8, padding: 12, marginBottom: 12,
};
