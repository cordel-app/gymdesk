'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnSmall } from '@/components/ui';

/**
 * #709: Clerk login accounts linked to nothing in Gymdesk (no active member,
 * no staff access, not a superadmin). The superadmin decides which to delete —
 * the API re-checks each one before deleting it in Clerk.
 */
type Reason = 'member_deleted' | 'signup_incomplete' | 'signup_in_progress' | 'no_links';

interface OrphanedAccount {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  reason: Reason;
  deletable: boolean;
  gyms: { gym_id: string; gym_name: string | null }[];
}

const REASON_COLORS: Record<Reason, { bg: string; fg: string }> = {
  member_deleted: { bg: '#fdecea', fg: '#b3261e' },
  signup_incomplete: { bg: '#fff4e5', fg: '#8a5300' },
  signup_in_progress: { bg: '#e8f0fe', fg: '#1a4fa0' },
  no_links: { bg: '#f1f3f4', fg: '#44474e' },
};

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

export default function OrphanedAccountsPage() {
  const t = useTranslations('orphaned_accounts');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<OrphanedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<OrphanedAccount | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      setRows(await apiFetch<OrphanedAccount[]>('/platform/orphaned-accounts'));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (!gymLoading && isSuperadmin) load(); }, [gymLoading, isSuperadmin]);

  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiFetch(`/platform/orphaned-accounts/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      toast(t('deleted', { email: deleting.email ?? deleting.id }), 'success');
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusy(false);
      setDeleting(null);
      load();
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  const columns: Column<OrphanedAccount>[] = [
    // Natural width like the Members list: may only break after the @.
    {
      header: t('col_email'),
      render: (r) => {
        if (!r.email) return '—';
        const at = r.email.indexOf('@');
        return at < 0 ? r.email : <>{r.email.slice(0, at + 1)}<wbr />{r.email.slice(at + 1)}</>;
      },
    },
    { header: t('col_name'), render: (r) => r.name ?? '—' },
    {
      header: t('col_reason'),
      render: (r) => {
        const c = REASON_COLORS[r.reason];
        return (
          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>
            {t(`reason_${r.reason}`)}
          </span>
        );
      },
    },
    { header: t('col_gyms'), render: (r) => (r.gyms.length ? r.gyms.map((g) => g.gym_name ?? g.gym_id).join(', ') : '—') },
    { header: t('col_created'), width: 110, render: (r) => fmtDate(r.created_at) },
    { header: t('col_last_sign_in'), width: 110, render: (r) => fmtDate(r.last_sign_in_at) },
    {
      header: t('col_actions'),
      width: 110,
      render: (r) => (
        <button
          onClick={() => setDeleting(r)}
          disabled={!r.deletable}
          title={r.deletable ? undefined : t('in_progress_hint')}
          style={{ ...btnSmall('#c0392b'), ...(r.deletable ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }}
        >
          {t('delete')}
        </button>
      ),
    },
  ];

  return (
    <div>
      <h1 style={{ margin: '0 0 8px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 24px', color: 'var(--gd-text-muted, #6b7280)', maxWidth: 760 }}>{t('intro')}</p>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
      />

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete', { email: deleting?.email ?? deleting?.id ?? '' })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
        busy={busy}
      />
    </div>
  );
}
