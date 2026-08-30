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

// ─── Types ────────────────────────────────────────────────────────────────────

interface Space {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  capacity: number;
  status: 'active' | 'inactive' | 'under_maintenance' | 'deleted';
  center_id: number | null;
  center_name: string | null;
  notes: string | null;
  opening_time: string | null;
  closing_time: string | null;
  created_at: string;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_membership_id: number | null;
  deleted_by_name: string | null;
}

interface Center { id: number; name: string }
interface ActivityType { id: number; name: string; status: string }

const STATUSES = ['active', 'inactive', 'under_maintenance'] as const;

const emptyEditForm = {
  name: '',
  description: '',
  capacity: '',
  status: 'active' as Space['status'],
  center_id: '',
  notes: '',
  opening_time: '',
  closing_time: '',
};

type EditForm = typeof emptyEditForm;

type InlineNew = {
  name: string;
  description: string;
  capacity: string;
  center_id: string;
  saving: boolean;
  error: string | null;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

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
  const [centersError, setCentersError] = useState(false);
  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);

  // Accordion: which rows are expanded (read-only view)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSelectedATs, setEditSelectedATs] = useState<Set<number>>(new Set());

  // Inline new space
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

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
      setCentersError(false);
    } catch {
      setCentersError(true);
    }
  }

  async function loadActivityTypes() {
    try { setActivityTypes(await apiFetch<ActivityType[]>('/activity-types')); } catch { /* non-fatal */ }
  }

  async function loadSpaceATs(spaceId: number): Promise<Set<number>> {
    try {
      const ats = await apiFetch<ActivityType[]>(`/spaces/${spaceId}/activity-types`);
      return new Set(ats.map((a) => a.id));
    } catch { return new Set(); }
  }

  // ─── Accordion ──────────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    const defaultCenterId = centers.length === 1 ? String(centers[0].id) : '';
    setInlineNew({ name: '', description: '', capacity: '', center_id: defaultCenterId, saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setInlineNew(null);
  }

  async function saveInlineNew() {
    if (!inlineNew || !activeGymId) return;
    if (!inlineNew.name.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_required') });
      return;
    }
    const cap = parseInt(inlineNew.capacity, 10);
    if (isNaN(cap) || cap <= 0) {
      setInlineNew({ ...inlineNew, error: t('error_capacity') });
      return;
    }
    if (centers.length > 1 && !inlineNew.center_id) {
      setInlineNew({ ...inlineNew, error: t('error_center_required') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<Space>('/spaces', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
          capacity: cap,
          ...(inlineNew.center_id ? { center_id: parseInt(inlineNew.center_id, 10) } : {}),
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  async function openEdit(space: Space) {
    const ats = await loadSpaceATs(space.id);
    setEditingId(space.id);
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
    setEditSelectedATs(ats);
    setEditError(null);
    setExpanded((prev) => new Set([...prev, space.id]));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleSave(space: Space) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    const cap = parseInt(editForm.capacity, 10);
    if (isNaN(cap) || cap <= 0) { setEditError(t('error_capacity')); return; }
    setEditSaving(true); setEditError(null);
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
      await apiFetch(`/spaces/${space.id}/activity-types`, {
        method: 'PUT',
        body: JSON.stringify({ activity_type_ids: Array.from(editSelectedATs) }),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  async function handleDuplicate(space: Space) {
    try {
      await apiFetch(`/spaces/${space.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/spaces/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) setEditingId(null);
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    const hasNoCenters = !centersError && centers.length === 0;
    const isMultiCenter = centers.length > 1;
    const saveBlocked = hasNoCenters || centersError;

    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMultiCenter ? '1fr 1fr 120px 1fr' : '1fr 1fr 120px', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('placeholder_name')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_capacity')} *</label>
              <input
                type="number" min="1" step="1"
                value={inlineNew.capacity}
                onChange={(e) => setInlineNew({ ...inlineNew, capacity: e.target.value })}
                style={inlineInputStyle}
              />
            </div>
            {isMultiCenter && (
              <div>
                <label style={inlineLabelStyle}>{t('label_center')} *</label>
                <select
                  value={inlineNew.center_id}
                  onChange={(e) => setInlineNew({ ...inlineNew, center_id: e.target.value })}
                  style={inlineSelectStyle}
                >
                  <option value="">{t('placeholder_center')}</option>
                  {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {centersError && <p style={errorStyle}>{t('error_centers_load')}</p>}
          {hasNoCenters && <p style={errorStyle}>{t('no_centers_available')}</p>}
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving || saveBlocked} style={btnSmall('#6c63ff')}>
              {inlineNew.saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderSpaceRow(space: Space) {
    const isExpanded = expanded.has(space.id);
    const isEditing = editingId === space.id;

    const descText = space.description
      ? space.description.length > 70 ? space.description.slice(0, 70) + '…' : space.description
      : '—';

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(space) },
      { label: t('edit'), onClick: () => openEdit(space) },
      { label: t('duplicate'), onClick: () => handleDuplicate(space) },
      { label: t('delete'), onClick: () => setDeleting(space), danger: true },
    ];

    return (
      <div key={space.id} style={cardStyle}>
        {/* Collapsed row */}
        <div style={rowStyle} onClick={() => toggleExpand(space.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {space.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descText}
          </div>
          <div style={{ minWidth: 70, textAlign: 'center', fontSize: 14, flexShrink: 0 }}>
            {space.capacity}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={space.status} label={tStatus(space.status)} />
          </div>
          <div style={{ minWidth: 100, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {space.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {fmtDate(space.created_at)}
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${space.name}`} />
          </div>
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            {/* General */}
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  autoFocus
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_capacity')} *</label>
                <input
                  type="number" min="1" step="1"
                  value={editForm.capacity}
                  onChange={(e) => setEditForm({ ...editForm, capacity: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={2}
                  style={{ ...inlineInputStyle, resize: 'vertical' }}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_center')}</label>
                <select
                  value={editForm.center_id}
                  onChange={(e) => setEditForm({ ...editForm, center_id: e.target.value })}
                  style={inlineSelectStyle}
                >
                  <option value="">—</option>
                  {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as Space['status'] })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
            </div>

            {/* Availability */}
            <SectionHeader title={t('section_availability')} />
            <p style={{ margin: '0 0 10px', fontSize: 13, color: '#888', fontStyle: 'italic' }}>{t('availability_hint')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_opening_time')}</label>
                <input
                  type="time"
                  value={editForm.opening_time}
                  onChange={(e) => setEditForm({ ...editForm, opening_time: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_closing_time')}</label>
                <input
                  type="time"
                  value={editForm.closing_time}
                  onChange={(e) => setEditForm({ ...editForm, closing_time: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
            </div>

            {/* Activity Types */}
            <SectionHeader title={t('section_activity_types')} />
            {activityTypes.length === 0 ? (
              <p style={{ fontSize: 13, color: '#888', margin: '0 0 12px' }}>{t('no_activity_types')}</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                {activityTypes.map((at) => (
                  <label key={at.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={editSelectedATs.has(at.id)}
                      onChange={(e) => {
                        const next = new Set(editSelectedATs);
                        if (e.target.checked) next.add(at.id); else next.delete(at.id);
                        setEditSelectedATs(next);
                      }}
                      style={{ width: 15, height: 15 }}
                    />
                    {at.name}
                    {at.status !== 'active' && <span style={{ fontSize: 11, color: '#aaa' }}>({tStatus(at.status)})</span>}
                  </label>
                ))}
              </div>
            )}

            {/* Notes */}
            <SectionHeader title={t('section_notes')} />
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              placeholder={t('notes_placeholder')}
              style={{ ...inlineInputStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(space)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded sections */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <DetailRow label={t('label_description')} value={space.description ?? '—'} />
            <DetailRow label={t('label_center')} value={space.center_name ?? '—'} />
            <DetailRow label={t('label_capacity')} value={String(space.capacity)} />
            <DetailRow label={t('label_status')} value={tStatus(space.status)} />

            <SectionHeader title={t('section_availability')} />
            <DetailRow label={t('label_opening_time')} value={space.opening_time ?? '—'} />
            <DetailRow label={t('label_closing_time')} value={space.closing_time ?? '—'} />

            <SectionHeader title={t('section_activity_types')} />
            <SpaceActivityTypes apiFetch={apiFetch} spaceId={space.id} allTypes={activityTypes} noTypesLabel={t('no_activity_types')} tStatus={tStatus} />

            <SectionHeader title={t('section_notes')} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: space.notes ? '#333' : '#aaa', whiteSpace: 'pre-wrap' }}>
              {space.notes ?? '—'}
            </p>
          </div>
        )}
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
      {/* Header */}
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
          <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {/* Column headers */}
      {(visibleSpaces.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('col_description')}</div>
          <div style={{ minWidth: 70, textAlign: 'center' }}>{t('col_capacity')}</div>
          <div style={{ minWidth: 90 }}>{t('col_status')}</div>
          <div style={{ minWidth: 100 }}>{t('col_created_by')}</div>
          <div style={{ minWidth: 90 }}>{t('col_created')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new row */}
      {renderInlineNewRow()}

      {/* Space list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : visibleSpaces.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleSpaces.map(renderSpaceRow)}
        </div>
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
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div>
              <span style={detailLabelStyle}>{t('details_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.name}</p>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('details_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{details.description ?? '—'}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('label_capacity')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.capacity}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('label_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge status={details.status} label={tStatus(details.status)} />
                </div>
              </div>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_availability')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('label_opening_time')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.opening_time ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('label_closing_time')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.closing_time ?? '—'}</p>
              </div>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_notes')}</div>
            <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.notes ? '#333' : '#aaa' }}>
              {details.notes ?? '—'}
            </p>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>Audit</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(details.created_at).toLocaleString()}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_at ? new Date(details.modified_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_at ? new Date(details.deleted_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_by_name ?? '—'}</p>
              </div>
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

// ─── Lazy activity-types loader for expanded read-only view ───────────────────

function SpaceActivityTypes({
  apiFetch, spaceId, allTypes, noTypesLabel, tStatus,
}: {
  apiFetch: <T>(url: string, opts?: any) => Promise<T>;
  spaceId: number;
  allTypes: ActivityType[];
  noTypesLabel: string;
  tStatus: (key: string) => string;
}) {
  const [assigned, setAssigned] = useState<Set<number> | null>(null);

  useEffect(() => {
    apiFetch<ActivityType[]>(`/spaces/${spaceId}/activity-types`)
      .then((ats) => setAssigned(new Set(ats.map((a) => a.id))))
      .catch(() => setAssigned(new Set()));
  }, [spaceId]);

  const list = allTypes.filter((at) => assigned?.has(at.id));

  if (assigned === null) return <p style={{ fontSize: 13, color: '#aaa', margin: '4px 0 12px' }}>Loading…</p>;
  if (list.length === 0) return <p style={{ fontSize: 13, color: '#aaa', margin: '4px 0 12px' }}>{noTypesLabel}</p>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 12px' }}>
      {list.map((at) => (
        <span key={at.id} style={{ background: '#f0f0f0', borderRadius: 4, padding: '3px 8px', fontSize: 13 }}>
          {at.name}
          {at.status !== 'active' && <span style={{ fontSize: 11, color: '#aaa', marginLeft: 4 }}>({tStatus(at.status)})</span>}
        </span>
      ))}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-card-border, #eee)', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1 }}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const errorStyle: React.CSSProperties = {
  margin: '8px 0 0', fontSize: 13, color: '#c0392b',
};
