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

interface TeamMember {
  id: number;
  user_id: string;
  email: string | null;
  name: string | null;
  role: 'admin' | 'coach' | 'staff';
  status?: 'invited' | 'active';
  created_at: string;
}

interface TeamResponse {
  status: 'granted' | 'invited' | 'already_granted';
  membership?: TeamMember;
  email?: string;
  note?: string;
}

export default function TeamPage() {
  const t = useTranslations('team');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'coach' | 'staff'>('coach');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [reinviting, setReinviting] = useState<TeamMember | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'invited'>('all');

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) {
      router.replace(`/${locale}`);
    }
  }, [gymLoading, isAdmin, locale, router]);

  async function load() {
    if (!isAdmin) return;
    setLoading(true);
    try {
      setRows(await apiFetch<TeamMember[]>('/gym-users'));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'), 'error');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (!gymLoading && isAdmin) load(); }, [gymLoading, isAdmin]);

  function openAdd() {
    setEditing(null);
    setEmail('');
    setName('');
    setRole('coach');
    setError(null);
    setModalOpen(true);
  }

  function openEdit(member: TeamMember) {
    setEditing(member);
    setEmail(member.email ?? '');
    setName(member.name ?? '');
    setRole(member.role);
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setEmail('');
    setName('');
    setRole('coach');
    setError(null);
  }

  async function handleSave() {
    if (editing) {
      // Editing role and/or name
      setSaving(true);
      setError(null);
      try {
        const body: any = { role, name: name.trim() || null };
        await apiFetch(`/gym-users/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        closeModal();
        load();
        toast(t('toast_role_changed'), 'success');
      } catch (err: any) {
        const msg = err.message ?? t('error_generic');
        if (msg.includes('Cannot')) {
          setError(msg);
        } else {
          toast(msg, 'error');
          closeModal();
        }
      } finally {
        setSaving(false);
      }
    } else {
      // Adding new member
      if (!email.trim()) {
        setError(t('error_email_required'));
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const res = await apiFetch<TeamResponse>('/gym-users', {
          method: 'POST',
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            name: name.trim() || undefined,
            role
          }),
        });
        closeModal();
        if (res.status === 'invited') {
          const message = res.note === 'Invitation already sent'
            ? t('toast_invited_resent', { email: res.email ?? email })
            : t('toast_invited', { email: res.email ?? email });
          toast(message, 'success');
        } else if (res.status === 'already_granted') {
          toast(t('toast_already_granted'), 'info');
        } else {
          toast(t('toast_granted'), 'success');
        }
        load();
      } catch (err: any) {
        setError(err.message ?? t('error_generic'));
      } finally {
        setSaving(false);
      }
    }
  }

  async function handleRemove() {
    if (!removing) return;
    const wasInvited = removing.status === 'invited';
    try {
      await apiFetch(`/gym-users/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      toast(wasInvited ? t('toast_revoked') : t('toast_removed'), 'success');
      load();
    } catch (err: any) {
      const msg = err.message ?? t('error_generic');
      setRemoving(null);
      toast(msg, 'error');
    }
  }

  async function handleReinvite() {
    if (!reinviting) return;
    try {
      await apiFetch(`/gym-users/${reinviting.id}/reinvite`, { method: 'POST' });
      setReinviting(null);
      toast(t('toast_reinvited', { email: reinviting.email ?? '' }), 'success');
      load();
    } catch (err: any) {
      const msg = err.message ?? t('error_generic');
      setReinviting(null);
      toast(msg, 'error');
    }
  }

  if (gymLoading || !isAdmin) return null;

  const invitedCount = rows.filter(r => r.status === 'invited').length;
  const filteredRows = statusFilter === 'all'
    ? rows
    : rows.filter(r => r.status === statusFilter);

  const columns: Column<TeamMember>[] = [
    {
      header: t('col_name'),
      render: (r) => r.name || r.email || '—',
    },
    { header: t('col_email'), render: (r) => r.email ?? '—' },
    {
      header: t('col_role'),
      render: (r) => t(`role_${r.role}`),
    },
    {
      header: t('col_joined'),
      width: 120,
      render: (r) => new Date(r.created_at).toLocaleDateString(),
    },
    {
      header: t('col_actions'),
      width: 200,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.status === 'invited' && (
            <button
              onClick={() => setReinviting(r)}
              style={btnSmall('#2980b9')}
              title={t('action_reinvite_title')}
            >
              {t('action_reinvite')}
            </button>
          )}
          {r.status !== 'invited' && (
            <button
              onClick={() => openEdit(r)}
              style={btnSmall('#444')}
              title={t('action_edit_title')}
            >
              {t('action_edit')}
            </button>
          )}
          <button
            onClick={() => setRemoving(r)}
            style={btnSmall(r.status === 'invited' ? '#e67e22' : '#c0392b')}
            title={r.status === 'invited' ? t('action_revoke_title') : t('action_remove_title')}
          >
            {r.status === 'invited' ? t('action_revoke') : t('action_remove')}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button onClick={openAdd} style={btnStyle()}>
          {t('add')}
        </button>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <button
          onClick={() => setStatusFilter('all')}
          style={{
            padding: '6px 12px',
            border: statusFilter === 'all' ? '2px solid #2980b9' : '1px solid #ddd',
            borderRadius: 4,
            background: statusFilter === 'all' ? '#ecf0f1' : '#fff',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: statusFilter === 'all' ? 600 : 400,
            color: statusFilter === 'all' ? '#2980b9' : '#666',
          }}
        >
          {t('filter_all')}
        </button>
        <button
          onClick={() => setStatusFilter('invited')}
          style={{
            padding: '6px 12px',
            border: statusFilter === 'invited' ? '2px solid #2980b9' : '1px solid #ddd',
            borderRadius: 4,
            background: statusFilter === 'invited' ? '#ecf0f1' : '#fff',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: statusFilter === 'invited' ? 600 : 400,
            color: statusFilter === 'invited' ? '#2980b9' : '#666',
          }}
        >
          {t('filter_pending')} {invitedCount > 0 && `(${invitedCount})`}
        </button>
      </div>

      <DataTable
        columns={columns}
        rows={filteredRows}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('modal_edit') : t('modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('cancel')}
        saveLabel={saving ? t('saving') : (editing ? t('update') : t('add'))}
        onCancel={closeModal}
        onSave={handleSave}
      >
        {!editing && (
          <>
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('placeholder_name')}
              autoFocus
            />
            <FormLabel>{t('label_email')}</FormLabel>
            <FormInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </>
        )}
        {editing && (
          <>
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('placeholder_name')}
              autoFocus
            />
          </>
        )}
        <FormLabel>{t('label_role')}</FormLabel>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as any)}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            fontSize: '14px',
            marginBottom: '16px',
          }}
        >
          <option value="admin">{t('role_admin')}</option>
          <option value="coach">{t('role_coach')}</option>
          <option value="staff">{t('role_staff')}</option>
        </select>
      </CrudModal>

      <ConfirmDialog
        open={removing !== null}
        message={
          removing?.status === 'invited'
            ? t('confirm_revoke', { email: removing?.email ?? '' })
            : t('confirm_remove', { email: removing?.email ?? '' })
        }
        confirmLabel={removing?.status === 'invited' ? t('confirm_revoke_btn') : t('confirm_remove_btn')}
        cancelLabel={t('cancel')}
        onConfirm={handleRemove}
        onCancel={() => setRemoving(null)}
      />

      <ConfirmDialog
        open={reinviting !== null}
        message={t('confirm_reinvite', { email: reinviting?.email ?? '' })}
        confirmLabel={t('confirm_reinvite_btn')}
        cancelLabel={t('cancel')}
        onConfirm={handleReinvite}
        onCancel={() => setReinviting(null)}
      />
    </div>
  );
}
