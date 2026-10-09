'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnSmall, cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import { inlineActionsRowStyle } from '@/components/formChrome';

// #801: a Space has no ACTIVITIES section. The Space form used to carry a
// checkbox list writing `PUT /spaces/:id/activity-types`; both the section and
// that route are gone (migration 197 dropped the join table). Which Space an
// activity runs in is configured on the **Activity Type** — its own
// `default_space_id`, edited on the Activity Types page — and this page must not
// grow a second, Space-side copy of that relation.

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

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 3 — the row and the header band are laid out from one declaration
 * rather than restating widths at each other (#637's shape). The header folded
 * the chevron and the `⋮` into one 68px cell while the row rendered two.
 *
 * `mobile` says what each column is on a phone. The Space's name is the row's
 * identity and its status is the one state worth seeing without tapping; the
 * capacity, the author and the date are read in the expanded card.
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `spaces` namespace. Absent = no title. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
  /** A numeric column centres its title over its values. */
  align?: 'center';
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'capacity', labelKey: 'col_capacity', width: 70, align: 'center', mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 90, mobile: 'keep' },
  { key: 'created_by', labelKey: 'col_created_by', width: 100, mobile: 'secondary' },
  { key: 'created', labelKey: 'col_created', width: 90, mobile: 'secondary' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 10;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 16;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

export default function SpacesPage() {
  const t = useTranslations('spaces');
  const gymFmt = useGymFormatSettings();
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [centerFilter, setCenterFilter] = useState('');
  const [centers, setCenters] = useState<Center[]>([]);
  const [centersError, setCentersError] = useState(false);

  // Accordion: which rows are expanded (read-only view)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Inline new space
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  // Details modal
  const [details, setDetails] = useState<Space | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<Space | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!canRead) { router.replace(`/${locale}`); return; }
    loadCenters();
  }, [gymLoading, canRead]);

  useEffect(() => { if (!gymLoading && canRead) load(); }, [activeGymId, gymLoading, statusFilter, centerFilter]);

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

  function openEdit(space: Space) {
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
          <div style={inlineActionsRowStyle}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving || saveBlocked} style={primaryBtnSmall()}>
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
      { label: t('edit'), onClick: () => openEdit(space), disabled: !canWrite, title: readOnlyTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(space), disabled: !canWrite, title: readOnlyTitle },
      { label: t('delete'), onClick: () => setDeleting(space), danger: true, disabled: !canWrite, title: readOnlyTitle },
    ];

    return (
      <div key={space.id} style={cardStyle}>
        {/* Collapsed row */}
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => toggleExpand(space.id)}>
          <div className={CELL_CLASS.name} title={space.name} style={{ fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {space.name}
          </div>
          <div className={CELL_CLASS.description} style={{ fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descText}
          </div>
          <div className={CELL_CLASS.capacity} style={{ textAlign: 'center', fontSize: 14 }}>
            {space.capacity}
          </div>
          <div className={CELL_CLASS.status}>
            <StatusBadge status={space.status} label={tStatus(space.status)} />
          </div>
          <div className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {space.created_by_name ?? '—'}
          </div>
          <div className={CELL_CLASS.created} style={{ fontSize: 13, color: '#888' }}>
            {fmtDate(space.created_at)}
          </div>
          <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
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
            <div style={{ ...inlineActionsRowStyle, marginTop: 16 }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(space)} disabled={editSaving} style={primaryBtnSmall()}>
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

            <SectionHeader title={t('section_notes')} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: space.notes ? '#333' : '#aaa', whiteSpace: 'pre-wrap' }}>
              {space.notes ?? '—'}
            </p>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !canRead) return null;

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
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : visibleSpaces.length === 0 && !inlineNew ? (
        <>
          {renderInlineNewRow()}
          <p style={{ color: '#888' }}>{t('empty')}</p>
        </>
      ) : (
        /* The header band and the cards share LIST_GRID_COLUMNS and scroll
           together, so they cannot fall out of line, and a narrow viewport
           scrolls the list instead of the page (#1011). */
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
            {/* Column headers */}
            <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
              {LIST_COLUMNS.map((col) => (
                <div key={col.key} className={CELL_CLASS[col.key]} style={col.align ? { textAlign: col.align } : undefined}>
                  {col.labelKey ? t(col.labelKey) : null}
                </div>
              ))}
            </div>

            {/* Inline new row */}
            {renderInlineNewRow()}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibleSpaces.map(renderSpaceRow)}
            </div>
          </div>
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
        extraFooter={<ViewAuditLogButton entityType="space" entityId={details?.id} onNavigate={() => setDetails(null)} />}
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
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{formatGymDateTime(details.created_at, gymFmt)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_at ? formatGymDateTime(details.modified_at, gymFmt) : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_at ? formatGymDateTime(details.deleted_at, gymFmt) : '—'}</p>
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

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP,
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
