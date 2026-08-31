'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

const STATUSES = ['active', 'inactive'] as const;
type TaxStatus = typeof STATUSES[number];

interface TaxRate {
  id: number;
  gym_id: string;
  name: string;
  rate_percent: string;
  is_system: number;
  status: TaxStatus;
  deleted_at: string | null;
  created_at: string;
  modified_at: string | null;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
}

type EditForm = {
  name: string;
  rate_percent: string;
  status: TaxStatus;
};

function emptyEditForm(item: TaxRate): EditForm {
  return {
    name: item.name,
    rate_percent: parseFloat(item.rate_percent).toString(),
    status: item.status,
  };
}

function emptyCreateForm(): EditForm {
  return { name: '', rate_percent: '', status: 'active' };
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TaxesPage() {
  const t = useTranslations('taxes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [items, setItems] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<EditForm>(emptyCreateForm());
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [details, setDetails] = useState<TaxRate | null>(null);
  const [deleting, setDeleting] = useState<TaxRate | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) load();
  }, [activeGymId, gymLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setItems(await apiFetch<TaxRate[]>('/taxes'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  function openCreate() {
    setCreateForm(emptyCreateForm());
    setCreateError(null);
    setCreating(true);
  }

  async function handleCreate() {
    if (!createForm.name.trim()) { setCreateError(t('error_name_required')); return; }
    const rate = parseFloat(createForm.rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) { setCreateError(t('error_rate_invalid')); return; }
    setCreateSaving(true); setCreateError(null);
    try {
      await apiFetch('/taxes', {
        method: 'POST',
        body: JSON.stringify({
          name: createForm.name.trim(),
          rate_percent: rate,
          status: createForm.status,
        }),
      });
      setCreating(false);
      load();
    } catch (err: any) {
      setCreateError(err.message ?? t('error_generic'));
    } finally {
      setCreateSaving(false);
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  function openEdit(item: TaxRate) {
    setEditingId(item.id);
    setEditForm(emptyEditForm(item));
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function handleSave(item: TaxRate) {
    if (!editForm) return;
    if (!editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    const rate = parseFloat(editForm.rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) { setEditError(t('error_rate_invalid')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/taxes/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          rate_percent: rate,
          status: editForm.status,
        }),
      });
      cancelEdit();
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Activate / Deactivate ───────────────────────────────────────────────────

  async function handleActivate(item: TaxRate) {
    try {
      await apiFetch(`/taxes/${item.id}/activate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDeactivate(item: TaxRate) {
    try {
      await apiFetch(`/taxes/${item.id}/deactivate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/taxes/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (gymLoading) return null;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{t('title')}</h1>
        <button onClick={openCreate} style={btnStyle('#6c63ff')}>{t('add')}</button>
      </div>

      {/* Column headers */}
      {items.length > 0 && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ minWidth: 80, textAlign: 'right' }}>{t('col_rate')}</div>
          <div style={{ minWidth: 100 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => {
            const isSystem = Boolean(item.is_system);
            const isEditing = editingId === item.id;

            const menuItems: ContextMenuItem[] = [
              { label: t('details'), onClick: () => setDetails(item) },
              { label: t('edit'), onClick: () => openEdit(item) },
              item.status === 'active'
                ? { label: t('deactivate'), onClick: () => handleDeactivate(item) }
                : { label: t('activate'), onClick: () => handleActivate(item) },
              ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true }] : []),
            ];

            return (
              <div key={item.id} style={cardStyle}>
                {isEditing && editForm ? (
                  <div style={{ padding: '16px 20px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                      <div>
                        <label style={labelStyle}>{t('label_name')} *</label>
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          autoFocus
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>{t('label_rate')}</label>
                        <input
                          type="number" min="0" max="100" step="0.01"
                          value={editForm.rate_percent}
                          onChange={(e) => setEditForm({ ...editForm, rate_percent: e.target.value })}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>{t('label_status')}</label>
                        <select
                          value={editForm.status}
                          onChange={(e) => setEditForm({ ...editForm, status: e.target.value as TaxStatus })}
                          style={inputStyle}
                        >
                          {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                        </select>
                      </div>
                    </div>
                    {editError && <p style={errorStyle}>{editError}</p>}
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
                      <button onClick={() => handleSave(item)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                        {editSaving ? t('saving') : t('save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={rowStyle}>
                    <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                      {isSystem && (
                        <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#888', background: '#f0f0f0', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' }}>
                          {t('system_badge')}
                        </span>
                      )}
                    </div>
                    <div style={{ minWidth: 80, fontSize: 13, color: '#555', flexShrink: 0, textAlign: 'right' }}>
                      {parseFloat(item.rate_percent) === 0 ? '0%' : `${parseFloat(item.rate_percent)}%`}
                    </div>
                    <div style={{ minWidth: 100, flexShrink: 0 }}>
                      <StatusBadge status={item.status} label={tStatus(item.status)} />
                    </div>
                    <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                      <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      <CrudModal
        open={creating}
        title={t('add')}
        error={createError}
        saving={createSaving}
        saveLabel={createSaving ? t('saving') : t('save')}
        cancelLabel={t('cancel')}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>{t('label_name')} *</label>
            <input
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              placeholder={t('placeholder_name')}
              autoFocus
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>{t('label_rate')}</label>
            <input
              type="number" min="0" max="100" step="0.01"
              value={createForm.rate_percent}
              onChange={(e) => setCreateForm({ ...createForm, rate_percent: e.target.value })}
              placeholder="21.00"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>{t('label_status')}</label>
            <select
              value={createForm.status}
              onChange={(e) => setCreateForm({ ...createForm, status: e.target.value as TaxStatus })}
              style={inputStyle}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
        </div>
      </CrudModal>

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <ModalField label={t('label_name')} value={details.name} />
            <ModalField label={t('label_rate')} value={`${parseFloat(details.rate_percent)}%`} />
            <ModalField label={t('label_status')} value={tStatus(details.status)} />
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at)} />
              <ModalField label={t('audit_created_by')} value={details.created_by_name ?? '—'} />
              <ModalField label={t('audit_modified_at')} value={fmtDate(details.modified_at)} />
              <ModalField label={t('audit_modified_by')} value={details.modified_by_name ?? '—'} />
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={(<div><p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('confirm_delete_title')}</p><p style={{ margin: 0 }}>{t('confirm_delete_body')}</p></div>) as any}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14 }}>{value}</p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--gd-card-border, #e2e2e6)',
  borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const errorStyle: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#c0392b' };
