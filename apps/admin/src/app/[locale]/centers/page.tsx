'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { btnStyle } from '@/components/ui';

interface Center {
  id: number;
  name: string;
  code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: 'active' | 'inactive';
  theme_id: string | null;
  theme_name: string | null;
  gym_theme_name: string | null;
  active_member_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface Theme { id: string; name: string }

const STATUSES = ['active', 'inactive'] as const;

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

export default function CentersPage() {
  const t = useTranslations('centers');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { refreshCenters } = useCenter();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [centers, setCenters] = useState<Center[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);

  // Edit modal
  const [editCenter, setEditCenter] = useState<Center | null>(null);
  const [editForm, setEditForm] = useState({
    name: '', code: '', address: '', phone: '', email: '',
    status: 'active' as 'active' | 'inactive', theme_id: '',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Details / delete
  const [detailsCenter, setDetailsCenter] = useState<Center | null>(null);
  const [deleting, setDeleting] = useState<Center | null>(null);

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setCenters(await apiFetch<Center[]>(`/centers${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setCenters([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadThemes() {
    try {
      setThemes(await apiFetch<Theme[]>('/system/themes'));
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    if (!gymLoading && isAdmin) { load(); loadThemes(); }
  }, [activeGymId, gymLoading, statusFilter]);

  async function handleAdd() {
    try {
      const row = await apiFetch<Center>('/centers', {
        method: 'POST',
        body: JSON.stringify({ name: t('new_center_name') }),
      });
      await load();
      refreshCenters();
      openEdit(row);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  function openEdit(center: Center) {
    setEditCenter(center);
    setEditForm({
      name: center.name,
      code: center.code ?? '',
      address: center.address ?? '',
      phone: center.phone ?? '',
      email: center.email ?? '',
      status: center.status,
      theme_id: center.theme_id ?? '',
    });
    setFormError(null);
  }

  async function handleSaveEdit() {
    if (!editCenter) return;
    if (!editForm.name.trim()) { setFormError(t('error_generic')); return; }
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch(`/centers/${editCenter.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          code: editForm.code.trim() || null,
          address: editForm.address.trim() || null,
          phone: editForm.phone.trim() || null,
          email: editForm.email.trim() || null,
          status: editForm.status,
          theme_id: editForm.theme_id || null,
        }),
      });
      setEditCenter(null);
      load();
      refreshCenters();
    } catch (err: any) {
      setFormError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/centers/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) setExpandedId(null);
      setDeleting(null);
      load();
      refreshCenters();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function themeLabel(center: Center): string {
    if (center.theme_id && center.theme_name) return center.theme_name;
    return `${center.gym_theme_name ?? '—'} ${t('theme_inherited_suffix')}`;
  }

  function renderExpanded(center: Center) {
    if (expandedId !== center.id) return null;
    return (
      <div style={{ padding: '16px 24px 20px', borderTop: '1px solid #eee', background: '#fafafa', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px 32px' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#aaa', marginBottom: 6 }}>{t('section_contact')}</div>
          <DetailItem label={t('label_email')} value={center.email} />
          <DetailItem label={t('label_phone')} value={center.phone} />
          <DetailItem label={t('label_address')} value={center.address} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#aaa', marginBottom: 6 }}>{t('section_theme')}</div>
          <DetailItem label={t('label_theme')} value={themeLabel(center)} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#aaa', marginBottom: 6 }}>{t('section_general')}</div>
          <DetailItem label={t('label_code')} value={center.code} />
          <DetailItem label={t('col_created_by')} value={center.created_by_name} />
        </div>
      </div>
    );
  }

  function renderRow(center: Center) {
    const isExpanded = expandedId === center.id;
    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailsCenter(center) },
      { label: t('edit'), onClick: () => openEdit(center) },
      {
        label: t('view_members'),
        onClick: () => router.push(`/${locale}/members?centerId=${center.id}`),
      },
      { label: t('delete'), onClick: () => setDeleting(center), danger: true },
    ];

    return (
      <div key={center.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 8, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: 'pointer' }}
          onClick={() => setExpandedId(isExpanded ? null : center.id)}
        >
          <span style={{ fontSize: 13, color: '#aaa', marginRight: 2, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block', flexShrink: 0 }}>▶</span>

          {/* Name */}
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{center.name}</span>
          </div>

          {/* Description */}
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#aaa' }}>—</div>

          {/* Created By */}
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {center.created_by_name ?? '—'}
          </div>

          {/* Created At */}
          <div style={{ minWidth: 110, fontSize: 13, color: '#666', flexShrink: 0 }}>
            {formatDateShort(locale, center.created_at)}
          </div>

          {/* Status badge */}
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={center.status} label={tStatus(center.status)} />
          </div>

          {/* Actions */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${center.name}`} />
          </div>
        </div>

        {isExpanded && renderExpanded(center)}
      </div>
    );
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleAdd} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      {/* Column header */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 16px 6px 44px', fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        <div style={{ flex: 2 }}>{t('col_name')}</div>
        <div style={{ flex: 2 }}>{t('col_description')}</div>
        <div style={{ flex: 2 }}>{t('col_created_by')}</div>
        <div style={{ minWidth: 110 }}>{t('col_created_at')}</div>
        <div style={{ minWidth: 90 }}>{t('col_status')}</div>
        <div style={{ minWidth: 36 }} />
      </div>

      {loading ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('loading')}</p>
      ) : centers.length === 0 ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('empty')}</p>
      ) : (
        centers.map(renderRow)
      )}

      {/* Edit modal */}
      {editCenter && (
        <CrudModal
          open
          title={t('modal_edit')}
          error={formError}
          saving={saving}
          cancelLabel={t('cancel')}
          saveLabel={saving ? t('saving') : t('save_changes')}
          onCancel={() => setEditCenter(null)}
          onSave={handleSaveEdit}
        >
          <FormLabel>{t('label_name')}</FormLabel>
          <FormInput
            value={editForm.name}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            autoFocus
          />

          <FormLabel>{t('label_email')}</FormLabel>
          <FormInput
            type="email"
            value={editForm.email}
            onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
          />

          <FormLabel>{t('label_phone')}</FormLabel>
          <FormInput
            value={editForm.phone}
            onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
          />

          <FormLabel>{t('label_address')}</FormLabel>
          <FormInput
            value={editForm.address}
            onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
          />

          <FormLabel>{t('label_status')}</FormLabel>
          <select
            value={editForm.status}
            onChange={(e) => setEditForm({ ...editForm, status: e.target.value as 'active' | 'inactive' })}
            style={selectStyle}
          >
            {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
          </select>

          <FormLabel>{t('label_theme')}</FormLabel>
          <select
            value={editForm.theme_id}
            onChange={(e) => setEditForm({ ...editForm, theme_id: e.target.value })}
            style={selectStyle}
          >
            <option value="">{editCenter.gym_theme_name ? `${editCenter.gym_theme_name} ${t('theme_inherited_suffix')}` : t('theme_none')}</option>
            {themes.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
          </select>
        </CrudModal>
      )}

      {/* Details modal */}
      {detailsCenter && (
        <CrudModal
          open
          title={t('details_title')}
          cancelLabel={t('cancel')}
          saveLabel=""
          hideSave
          onCancel={() => setDetailsCenter(null)}
          onSave={() => setDetailsCenter(null)}
        >
          <DetailRow label={t('col_name')} value={detailsCenter.name} />
          <DetailRow label={t('label_email')} value={detailsCenter.email} />
          <DetailRow label={t('label_phone')} value={detailsCenter.phone} />
          <DetailRow label={t('label_address')} value={detailsCenter.address} />
          <DetailRow label={t('label_theme')} value={themeLabel(detailsCenter)} />
          <DetailRow label={t('col_status')} value={tStatus(detailsCenter.status)} />
          <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 16 }} />
          <DetailRow label={t('created_at')} value={formatDate(locale, detailsCenter.created_at)} />
          <DetailRow label={t('created_by')} value={detailsCenter.created_by_name} />
          <DetailRow label={t('modified_at')} value={formatDate(locale, detailsCenter.modified_at)} />
          <DetailRow label={t('modified_by')} value={detailsCenter.modified_by_name} />
          {detailsCenter.deleted_at && (
            <>
              <DetailRow label={t('deleted_at')} value={formatDate(locale, detailsCenter.deleted_at)} />
              <DetailRow label={t('deleted_by')} value={detailsCenter.deleted_by_name} />
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

function DetailItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ marginBottom: 8, fontSize: 13 }}>
      <span style={{ color: '#aaa', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 2 }}>{label}</span>
      <span style={{ color: '#333' }}>{value ?? '—'}</span>
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
