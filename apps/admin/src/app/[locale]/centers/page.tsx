'use client';

import { useEffect, useRef, useState } from 'react';
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
import { CrudModal } from '@/components/CrudModal';
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

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
  background: '#fff',
};

const selectStyle: React.CSSProperties = { ...fieldStyle, cursor: 'pointer' };

function formatDate(locale: string, iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function InlineField({
  label, value, onChange, onSave, type = 'text', inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  type?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSave}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }}
        style={fieldStyle}
      />
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ margin: '20px 0 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#aaa' }}>
      {children}
    </h3>
  );
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
  const [editForm, setEditForm] = useState({ name: '', code: '', address: '', phone: '', email: '' });
  const nameRef = useRef<HTMLInputElement | null>(null);

  const [themes, setThemes] = useState<Theme[]>([]);

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
      const rows = await apiFetch<Theme[]>('/system/themes');
      setThemes(rows);
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    if (!gymLoading && isAdmin) { load(); loadThemes(); }
  }, [activeGymId, gymLoading, statusFilter]);

  async function saveField(centerId: number, patch: Record<string, unknown>) {
    try {
      await apiFetch(`/centers/${centerId}`, { method: 'PUT', body: JSON.stringify(patch) });
      load();
      refreshCenters();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  function openExpand(center: Center) {
    if (expandedId === center.id) { setExpandedId(null); return; }
    setExpandedId(center.id);
    setEditForm({
      name: center.name,
      code: center.code ?? '',
      address: center.address ?? '',
      phone: center.phone ?? '',
      email: center.email ?? '',
    });
  }

  async function handleAdd() {
    try {
      const row = await apiFetch<Center>('/centers', {
        method: 'POST',
        body: JSON.stringify({ name: t('new_center_name') }),
      });
      await load();
      refreshCenters();
      setExpandedId(row.id);
      setEditForm({ name: row.name, code: '', address: '', phone: '', email: '' });
      setTimeout(() => nameRef.current?.select(), 80);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
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

    const save = (patch: Record<string, unknown>) => saveField(center.id, patch);

    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>

          {/* General */}
          <div>
            <SectionHeading>{t('section_general')}</SectionHeading>
            <InlineField
              label={t('label_name')}
              value={editForm.name}
              onChange={(v) => setEditForm({ ...editForm, name: v })}
              onSave={() => { if (editForm.name.trim()) save({ name: editForm.name.trim() }); }}
              inputRef={nameRef}
            />
            <InlineField
              label={t('label_code')}
              value={editForm.code}
              onChange={(v) => setEditForm({ ...editForm, code: v })}
              onSave={() => save({ code: editForm.code.trim() || null })}
            />
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('label_status')}</div>
              <select
                value={center.status}
                onChange={(e) => save({ status: e.target.value })}
                style={selectStyle}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
              </select>
            </div>
          </div>

          {/* Contact */}
          <div>
            <SectionHeading>{t('section_contact')}</SectionHeading>
            <InlineField
              label={t('label_email')}
              value={editForm.email}
              type="email"
              onChange={(v) => setEditForm({ ...editForm, email: v })}
              onSave={() => save({ email: editForm.email.trim() || null })}
            />
            <InlineField
              label={t('label_phone')}
              value={editForm.phone}
              onChange={(v) => setEditForm({ ...editForm, phone: v })}
              onSave={() => save({ phone: editForm.phone.trim() || null })}
            />
          </div>

          {/* Address */}
          <div>
            <SectionHeading>{t('section_location')}</SectionHeading>
            <InlineField
              label={t('label_address')}
              value={editForm.address}
              onChange={(v) => setEditForm({ ...editForm, address: v })}
              onSave={() => save({ address: editForm.address.trim() || null })}
            />
          </div>

          {/* Theme */}
          <div>
            <SectionHeading>{t('section_theme')}</SectionHeading>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('label_theme')}</div>
              <select
                value={center.theme_id ?? ''}
                onChange={(e) => save({ theme_id: e.target.value || null })}
                style={selectStyle}
              >
                <option value="">{center.gym_theme_name ? `${center.gym_theme_name} ${t('theme_inherited_suffix')}` : t('theme_none')}</option>
                {themes.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
              </select>
            </div>
            {center.theme_id && (
              <button
                type="button"
                onClick={() => save({ theme_id: null })}
                style={{ background: 'none', border: 'none', color: '#6c63ff', fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
              >
                {t('restore_inheritance')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderRow(center: Center) {
    const isExpanded = expandedId === center.id;
    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailsCenter(center) },
      { label: t('delete'), onClick: () => setDeleting(center), danger: true },
    ];

    return (
      <div key={center.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 8, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: 'pointer' }}
          onClick={() => openExpand(center)}
        >
          <span style={{ fontSize: 13, color: '#aaa', marginRight: 2, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>

          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{center.name}</span>
          </div>

          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {center.email ?? '—'}
          </div>

          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#666' }}>
            {center.theme_id
              ? center.theme_name ?? '—'
              : <span>{center.gym_theme_name ?? '—'} <span style={{ color: '#aaa', fontSize: 12 }}>{t('theme_inherited_suffix')}</span></span>}
          </div>

          <div onClick={(e) => e.stopPropagation()}>
            <select
              value={center.status}
              onChange={async (e) => {
                e.stopPropagation();
                await saveField(center.id, { status: e.target.value });
              }}
              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, cursor: 'pointer', background: '#fff' }}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>

          <div style={{ minWidth: 90, fontSize: 13, color: '#aaa', textAlign: 'right' }}>
            {new Date(center.created_at).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>

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

      {/* Header row */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 16px 6px 44px', fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        <div style={{ flex: 2 }}>{t('col_name')}</div>
        <div style={{ flex: 2 }}>{t('col_email')}</div>
        <div style={{ flex: 2 }}>{t('col_theme')}</div>
        <div style={{ minWidth: 90 }}>{t('col_status')}</div>
        <div style={{ minWidth: 90, textAlign: 'right' }}>{t('col_created_at')}</div>
        <div style={{ minWidth: 36 }} />
      </div>

      {loading ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('loading')}</p>
      ) : centers.length === 0 ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('empty')}</p>
      ) : (
        centers.map(renderRow)
      )}

      {/* Details modal — audit info only */}
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
          <div style={{ marginTop: 20 }} />
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

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 14 }}>
      <span style={{ minWidth: 120, color: '#888', fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#333' }}>{value ?? '—'}</span>
    </div>
  );
}
