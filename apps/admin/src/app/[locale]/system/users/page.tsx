'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnStyle, btnSmall } from '@/components/ui';

interface Superadmin {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string | null;
}

interface GrantResponse {
  status: 'granted' | 'invited' | 'already_granted';
  user?: Superadmin;
  email?: string;
}

export default function SystemUsersPage() {
  const t = useTranslations('system_users');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Superadmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Superadmin | null>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) {
      router.replace(`/${locale}`);
    }
  }, [gymLoading, isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      setRows(await apiFetch<Superadmin[]>('/platform/superadmins'));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (!gymLoading && isSuperadmin) load(); }, [gymLoading, isSuperadmin]);

  async function grant() {
    if (!email.trim()) { setError(t('error_email_required')); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<GrantResponse>('/platform/superadmins', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setModalOpen(false);
      setEmail('');
      if (res.status === 'invited') toast(t('invited', { email: res.email ?? email }));
      else if (res.status === 'already_granted') toast(t('already_granted'));
      else toast(t('granted'));
      load();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (!revoking) return;
    try {
      await apiFetch(`/platform/superadmins/${revoking.id}`, { method: 'DELETE' });
      setRevoking(null);
      toast(t('revoked'));
      load();
    } catch (err: any) {
      setRevoking(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  const columns: Column<Superadmin>[] = [
    {
      header: t('col_name'),
      render: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || '—',
    },
    { header: t('col_email'), render: (r) => r.email ?? '—' },
    {
      header: t('col_created'),
      width: 140,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'),
    },
    {
      header: t('col_actions'),
      width: 140,
      render: (r) => (
        <button onClick={() => setRevoking(r)} style={btnSmall('#c0392b')}>{t('revoke')}</button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button onClick={() => { setEmail(''); setError(null); setModalOpen(true); }} style={btnStyle()}>
          {t('add')}
        </button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
      />

      <CrudModal
        open={modalOpen}
        title={t('modal_grant')}
        error={error}
        saving={saving}
        cancelLabel={t('cancel')}
        saveLabel={saving ? t('saving') : t('grant')}
        onCancel={() => { setModalOpen(false); setEmail(''); setError(null); }}
        onSave={grant}
      >
        <FormLabel>{t('label_email')}</FormLabel>
        <FormInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          autoFocus
        />
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#666' }}>{t('grant_hint')}</p>
      </CrudModal>

      <ConfirmDialog
        open={revoking !== null}
        message={t('confirm_revoke', { email: revoking?.email ?? '' })}
        confirmLabel={t('revoke')}
        cancelLabel={t('cancel')}
        onConfirm={handleRevoke}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}
