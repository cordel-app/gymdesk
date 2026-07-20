'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

interface Space {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  capacity: number;
  status: 'active' | 'inactive' | 'under_maintenance';
  center_id: number | null;
  center_name: string | null;
  notes: string | null;
  opening_time: string | null;
  closing_time: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  created_by_membership_id: number | null;
  deleted_at: string | null;
  deleted_by_membership_id: number | null;
}

interface Center { id: number; name: string }
interface ActivityType { id: number; name: string; status: string }

type TabKey = 'general' | 'availability' | 'activity_types' | 'notes';

const STATUSES = ['active', 'inactive', 'under_maintenance'] as const;

const emptyForm = {
  name: '',
  description: '',
  capacity: '',
  status: 'active' as Space['status'],
  center_id: '',
  notes: '',
  opening_time: '',
  closing_time: '',
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};

export default function SpacesPage() {
  const t = useTranslations('spaces');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [centerFilter, setCenterFilter] = useState('');
  const [centers, setCenters] = useState<Center[]>([]);

  // Inline editor state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [editTab, setEditTab] = useState<TabKey>('general');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [selectedATs, setSelectedATs] = useState<Set<number>>(new Set());
  const [savingATs, setSavingATs] = useState(false);
  const newRowNameRef = useRef<HTMLInputElement>(null);

  // Details modal
  const [details, setDetails] = useState<Space | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<Space | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
    loadCenters();
    loadActivityTypes();
  }, [gymLoading, isAdmin]);

  useEffect(() => { if (!gymLoading && isAdmin) load(); }, [activeGymId, gymLoading, statusFilter, centerFilter]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (centerFilter) params.set('center_id', centerFilter);
      const qs = params.toString();
      setSpaces(await apiFetch<Space[]>(`/spaces${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadCenters() {
    try {
      setCenters(await apiFetch<Center[]>('/centers'));
    } catch { /* non-fatal */ }
  }

  async function loadActivityTypes() {
    try {
      setActivityTypes(await apiFetch<ActivityType[]>('/activity-types'));
    } catch { /* non-fatal */ }
  }

  async function loadSpaceATs(spaceId: number) {
    try {
      const ats = await apiFetch<ActivityType[]>(`/spaces/${spaceId}/activity-types`);
      setSelectedATs(new Set(ats.map((a) => a.id)));
    } catch { setSelectedATs(new Set()); }
  }

  function openExpand(space: Space) {
    if (expandedId === space.id) { setExpandedId(null); return; }
    setExpandedId(space.id);
    setEditForm({
      name: space.name,
      description: space.description ?? '',
      capacity: String(space.capacity),
      status: space.status,
      center_id: space.center_id ? String(space.center_id) : '',
      notes: space.notes ?? '',
      opening_time: space.opening_time ?? '',
      closing_time: space.closing_time ?? '',
    });
    setEditTab('general');
    setEditError(null);
    loadSpaceATs(space.id);
  }

  async function handleCreate() {
    if (!activeGymId) return;
    try {
      const row = await apiFetch<Space>('/spaces', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Space', capacity: 10 }),
      });
      await load();
      setExpandedId(row.id);
      setEditForm({
        name: row.name,
        description: '',
        capacity: String(row.capacity),
        status: row.status,
        center_id: '',
        notes: '',
        opening_time: '',
        closing_time: '',
      });
      setEditTab('general');
      setEditError(null);
      setSelectedATs(new Set());
      setTimeout(() => newRowNameRef.current?.focus(), 50);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleSave(space: Space) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    const cap = parseInt(editForm.capacity, 10);
    if (isNaN(cap) || cap <= 0) { setEditError(t('error_capacity')); return; }
    setSaving(true); setEditError(null);
    try {
      await apiFetch(`/spaces/${space.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          capacity: cap,
          status: editForm.status,
          center_id: editForm.center_id ? parseInt(editForm.center_id, 10) : null,
          notes: editForm.notes.trim() || null,
          opening_time: editForm.opening_time || null,
          closing_time: editForm.closing_time || null,
        }),
      });
      // save activity types
      setSavingATs(true);
      await apiFetch(`/spaces/${space.id}/activity-types`, {
        method: 'PUT',
        body: JSON.stringify({ activity_type_ids: Array.from(selectedATs) }),
      });
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
      setSavingATs(false);
    }
  }

  async function handleDuplicate(space: Space) {
    try {
      await apiFetch(`/spaces/${space.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/spaces/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (expandedId === deleting.id) setExpandedId(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', border: 'none', cursor: 'pointer', borderRadius: 4,
    background: active ? '#6c63ff' : 'transparent',
    color: active ? '#fff' : '#555',
    fontWeight: active ? 600 : 400,
    fontSize: 14,
  });

  function renderInlineEditor(space: Space) {
    if (expandedId !== space.id) return null;
    const tabs: TabKey[] = ['general', 'availability', 'activity_types', 'notes'];

    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {editError && <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>}

        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
          {tabs.map((tab) => (
            <button key={tab} type="button" onClick={() => setEditTab(tab)} style={tabStyle(editTab === tab)}>
              {t(`tab_${tab}` as any)}
            </button>
          ))}
        </div>

        {editTab === 'general' && (
          <div>
            <FormLabel>{t('label_name')}</FormLabel>
            <input
              ref={newRowNameRef}
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              placeholder={t('placeholder_name')}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }}
            />
            <FormLabel>{t('label_description')}</FormLabel>
            <textarea
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              rows={3}
              style={{ ...selectStyle, resize: 'vertical' }}
            />
            <FormLabel>{t('label_center')}</FormLabel>
            <select value={editForm.center_id} onChange={(e) => setEditForm({ ...editForm, center_id: e.target.value })} style={selectStyle}>
              <option value="">—</option>
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <FormLabel>{t('label_capacity')}</FormLabel>
            <FormInput
              type="number" min="1" step="1"
              value={editForm.capacity}
              onChange={(e) => setEditForm({ ...editForm, capacity: e.target.value })}
            />
            <FormLabel>{t('label_status')}</FormLabel>
            <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as Space['status'] })} style={selectStyle}>
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
        )}

        {editTab === 'availability' && (
          <div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#888', fontStyle: 'italic' }}>{t('availability_hint')}</p>
            <FormLabel>{t('label_opening_time')}</FormLabel>
            <FormInput
              type="time"
              value={editForm.opening_time}
              onChange={(e) => setEditForm({ ...editForm, opening_time: e.target.value })}
            />
            <FormLabel>{t('label_closing_time')}</FormLabel>
            <FormInput
              type="time"
              value={editForm.closing_time}
              onChange={(e) => setEditForm({ ...editForm, closing_time: e.target.value })}
            />
          </div>
        )}

        {editTab === 'activity_types' && (
          <div>
            {activityTypes.length === 0 ? (
              <p style={{ color: '#888', fontSize: 14 }}>{t('no_activity_types')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activityTypes.map((at) => (
                  <label key={at.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedATs.has(at.id)}
                      onChange={(e) => {
                        const next = new Set(selectedATs);
                        if (e.target.checked) next.add(at.id); else next.delete(at.id);
                        setSelectedATs(next);
                      }}
                      style={{ width: 16, height: 16 }}
                    />
                    <span style={{ fontSize: 14 }}>{at.name}</span>
                    {at.status !== 'active' && (
                      <span style={{ fontSize: 11, color: '#aaa' }}>({tStatus(at.status)})</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {editTab === 'notes' && (
          <div>
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={5}
              placeholder={t('notes_placeholder')}
              style={{ ...selectStyle, resize: 'vertical' }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(space)} disabled={saving || savingATs} style={btnSmall('#6c63ff')}>
            {saving || savingATs ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  function renderSpaceRow(space: Space) {
    const isExpanded = expandedId === space.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(space) },
      { label: t('duplicate'), onClick: () => handleDuplicate(space) },
      { label: t('delete'), onClick: () => setDeleting(space), danger: true },
    ];

    const descTruncated = space.description
      ? space.description.length > 80
        ? space.description.slice(0, 80) + '…'
        : space.description
      : '—';

    return (
      <div key={space.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: 'pointer' }}
          onClick={() => openExpand(space)}
        >
          {/* Name */}
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{space.name}</span>
          </div>

          {/* Description truncated */}
          <div style={{ flex: 3, minWidth: 0, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descTruncated}
          </div>

          {/* Center */}
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#555' }}>
            {space.center_name ?? '—'}
          </div>

          {/* Capacity */}
          <div style={{ minWidth: 60, textAlign: 'right', fontSize: 14 }}>
            {space.capacity}
          </div>

          {/* Created */}
          <div style={{ minWidth: 90, fontSize: 13, color: '#888' }}>
            {new Date(space.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>

          {/* Status — inline selector, stops propagation so clicking it doesn't expand */}
          <div onClick={(e) => e.stopPropagation()}>
            <select
              value={space.status}
              onChange={async (e) => {
                const newStatus = e.target.value as Space['status'];
                try {
                  await apiFetch(`/spaces/${space.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ status: newStatus }),
                  });
                  load();
                } catch (err: any) {
                  toast(err.message ?? t('error_generic'));
                }
              }}
              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 13, cursor: 'pointer', background: '#fff' }}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>

          {/* Expand chevron */}
          <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>

          {/* Context menu */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isExpanded && renderInlineEditor(space)}
      </div>
    );
  }

  if (gymLoading || !isAdmin) return null;

  const visibleSpaces = spaces.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q) ||
      (s.center_name ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, minWidth: 220 }}
          />
          <select
            value={centerFilter}
            onChange={(e) => setCenterFilter(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' }}
          >
            <option value="">{t('filter_center')}</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleCreate} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      {/* Table header */}
      {visibleSpaces.length > 0 && (
        <div style={{ display: 'flex', padding: '6px 16px', gap: 12, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('col_description')}</div>
          <div style={{ flex: 2 }}>{t('col_center')}</div>
          <div style={{ minWidth: 60, textAlign: 'right' }}>{t('col_capacity')}</div>
          <div style={{ minWidth: 90 }}>{t('col_created')}</div>
          <div style={{ minWidth: 160 }}>{t('col_status')}</div>
          <div style={{ minWidth: 48 }} />
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : visibleSpaces.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        visibleSpaces.map(renderSpaceRow)
      )}

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_name')}</span>
              <p style={{ margin: '4px 0 0', fontSize: 15 }}>{details.name}</p>
            </div>
            {details.description && (
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_description')}</span>
                <p style={{ margin: '4px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{details.description}</p>
              </div>
            )}
            <hr style={{ margin: 0, borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_created_at')}</span>
                <p style={{ margin: '4px 0 0', fontSize: 14 }}>{new Date(details.created_at).toLocaleString()}</p>
              </div>
              {details.modified_at && (
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_modified_at')}</span>
                  <p style={{ margin: '4px 0 0', fontSize: 14 }}>{new Date(details.modified_at).toLocaleString()}</p>
                </div>
              )}
              {details.deleted_at && (
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_deleted_at')}</span>
                  <p style={{ margin: '4px 0 0', fontSize: 14 }}>{new Date(details.deleted_at).toLocaleString()}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={`${t('confirm_delete_title')}\n\n${t('confirm_delete_body')}`}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
