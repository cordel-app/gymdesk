'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';

interface Speciality {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

const STATUSES = ['active', 'inactive'] as const;

const emptyEditForm = { name: '', description: '', status: 'active' as 'active' | 'inactive' };
const emptyAddForm = { name: '', description: '', status: 'active' as 'active' | 'inactive' };

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
  background: '#fff', cursor: 'pointer',
};

function formatDate(locale: string, iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function formatDateShort(locale: string, iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

export default function SpecialitiesPage() {
  const t = useTranslations('specialities');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [rows, setRows] = useState<Speciality[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  // Details / delete
  const [details, setDetails] = useState<Speciality | null>(null);
  const [deleting, setDeleting] = useState<Speciality | null>(null);

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows(await apiFetch<Speciality[]>('/specialities'));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openEdit(row: Speciality) {
    setEditingId(row.id);
    setEditForm({ name: row.name, description: row.description ?? '', status: row.status });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyEditForm);
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/specialities/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          status: editForm.status,
        }),
      });
      setEditingId(null);
      setEditForm(emptyEditForm);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd() {
    if (!addForm.name.trim()) { setAddError(t('error_required')); return; }
    setAddSaving(true);
    setAddError(null);
    try {
      await apiFetch('/specialities', {
        method: 'POST',
        body: JSON.stringify({
          name: addForm.name.trim(),
          description: addForm.description.trim() || null,
          status: addForm.status,
        }),
      });
      setAddOpen(false);
      setAddForm(emptyAddForm);
      load();
    } catch (err: any) {
      setAddError(err.message ?? t('error_generic'));
    } finally {
      setAddSaving(false);
    }
  }

  async function handleDuplicate(row: Speciality) {
    try {
      await apiFetch(`/specialities/${row.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/specialities/${deleting.id}`, { method: 'DELETE' });
      if (editingId === deleting.id) cancelEdit();
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function renderRow(row: Speciality) {
    const isEditing = editingId === row.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(row) },
      { label: t('edit'), onClick: () => openEdit(row) },
      { label: t('duplicate'), onClick: () => handleDuplicate(row) },
      { label: t('delete'), onClick: () => setDeleting(row), danger: true },
    ];

    return (
      <div key={row.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 8, overflow: 'hidden', background: '#fff' }}>
        {/* Row summary */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12 }}>
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{row.name}</span>
          </div>
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.description ?? '—'}
          </div>
          <div style={{ minWidth: 110, fontSize: 13, color: '#666', flexShrink: 0 }}>
            {formatDateShort(locale, row.created_at)}
          </div>
          <div style={{ flex: 1, minWidth: 80, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={row.status} label={tStatus(row.status)} />
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${row.name}`} />
          </div>
        </div>

        {/* Inline edit panel */}
        {isEditing && (
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid #eee', background: '#fafafa' }}>
            {editError && (
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>
            )}
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              autoFocus
            />
            <FormLabel>{t('label_description')}</FormLabel>
            <FormInput
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
            />
            <FormLabel>{t('label_status')}</FormLabel>
            <select
              value={editForm.status}
              onChange={(e) => setEditForm({ ...editForm, status: e.target.value as 'active' | 'inactive' })}
              style={selectStyle}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{tStatus(s)}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={handleSaveEdit} disabled={saving} style={btnSmall('#6c63ff')}>
                {saving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button
          onClick={() => { setAddForm(emptyAddForm); setAddError(null); setAddOpen(true); }}
          style={btnStyle('#6c63ff')}
        >
          {t('add')}
        </button>
      </div>

      {/* Column headers */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 16px 6px 16px', fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        <div style={{ flex: 2 }}>{t('col_name')}</div>
        <div style={{ flex: 2 }}>{t('col_description')}</div>
        <div style={{ minWidth: 110 }}>{t('col_created_at')}</div>
        <div style={{ flex: 1, minWidth: 80 }}>{t('col_created_by')}</div>
        <div style={{ minWidth: 90 }}>{t('col_status')}</div>
        <div style={{ minWidth: 36 }} />
      </div>

      {loading ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('empty')}</p>
      ) : (
        rows.map(renderRow)
      )}

      {/* Add modal */}
      <CrudModal
        open={addOpen}
        title={t('modal_add')}
        error={addError}
        saving={addSaving}
        cancelLabel={t('cancel')}
        saveLabel={addSaving ? t('saving') : t('modal_add')}
        onCancel={() => { setAddOpen(false); setAddError(null); }}
        onSave={handleAdd}
      >
        <FormLabel>{t('label_name')}</FormLabel>
        <FormInput
          value={addForm.name}
          onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
          autoFocus
        />
        <FormLabel>{t('label_description')}</FormLabel>
        <FormInput
          value={addForm.description}
          onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
        />
        <FormLabel>{t('label_status')}</FormLabel>
        <select
          value={addForm.status}
          onChange={(e) => setAddForm({ ...addForm, status: e.target.value as 'active' | 'inactive' })}
          style={selectStyle}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{tStatus(s)}</option>
          ))}
        </select>
      </CrudModal>

      {/* Details modal */}
      {details && (
        <CrudModal
          open
          title={t('details_title')}
          error={null}
          saving={false}
          hideSave
          cancelLabel={t('cancel')}
          saveLabel=""
          onCancel={() => setDetails(null)}
          onSave={() => setDetails(null)}
        >
          <DetailRow label={t('col_name')} value={details.name} />
          <DetailRow label={t('col_description')} value={details.description} />
          <DetailRow label={t('col_status')} value={tStatus(details.status)} />
          <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 16 }} />
          <DetailRow label={t('created_at')} value={formatDate(locale, details.created_at)} />
          <DetailRow label={t('created_by')} value={details.created_by_name} />
          <DetailRow label={t('modified_at')} value={formatDate(locale, details.modified_at)} />
          <DetailRow label={t('modified_by')} value={details.modified_by_name} />
          {details.deleted_at && (
            <>
              <DetailRow label={t('deleted_at')} value={formatDate(locale, details.deleted_at)} />
              <DetailRow label={t('deleted_by')} value={details.deleted_by_name} />
            </>
          )}
        </CrudModal>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 14 }}>
      <span style={{ minWidth: 120, color: '#888', fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#333' }}>{value ?? '—'}</span>
    </div>
  );
}
