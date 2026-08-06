'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { btnStyle, btnSmall } from '@/components/ui';
import { TrainingPlanTree, Hierarchy } from './TrainingPlanTree';
import { NewTrainingPlanDialog } from '../training-plans/NewTrainingPlanDialog';

export interface TrainingPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  workout_count: number;
  created_by_name: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface ListResponse {
  items: TrainingPlanTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { membership_id: number; name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive', 'draft'] as const;
const LIMIT = 20;
const emptyEditForm = { name: '', description: '', status: 'active' as TrainingPlanTemplate['status'] };
type EditForm = typeof emptyEditForm;

type InlineNew = { name: string; description: string; saving: boolean; error: string | null };

export default function TrainingPlanTemplatesPage() {
  const t = useTranslations('training_plan_templates');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<TrainingPlanTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState('');
  const [createdByOptions, setCreatedByOptions] = useState<CreatedByOption[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Inline new row
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Details dialog
  const [detailsTemplate, setDetailsTemplate] = useState<TrainingPlanTemplate | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<TrainingPlanTemplate | null>(null);

  // Assign to member
  const [assigning, setAssigning] = useState<TrainingPlanTemplate | null>(null);

  // Row expansion + per-template lazy-loaded hierarchy
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  useEffect(() => {
    const id = setTimeout(() => setNameQuery(nameInput.trim()), 300);
    return () => clearTimeout(id);
  }, [nameInput]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (nameQuery) params.set('name', nameQuery);
      if (createdByFilter) params.set('created_by', createdByFilter);
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const res = await apiFetch<ListResponse>(`/training-plan-templates?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/training-plan-templates/created-by-options')
      .then(setCreatedByOptions)
      .catch(() => {});
  }, [activeGymId, gymLoading]);

  // Warn before browser navigation while editing
  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({ name: '', description: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setInlineNew(null);
  }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_required') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<TrainingPlanTemplate>('/training-plan-templates', {
        method: 'POST',
        body: JSON.stringify({ name: inlineNew.name.trim(), description: inlineNew.description.trim() || null }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  function startEdit(tpl: TrainingPlanTemplate) {
    setEditingId(tpl.id);
    setEditForm({ name: tpl.name, description: tpl.description ?? '', status: tpl.status });
    setEditError(null);
    setExpanded((prev) => new Set([...prev, tpl.id]));
    loadHierarchy(tpl.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/training-plan-templates/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), description: editForm.description.trim() || null, status: editForm.status }),
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

  async function handleDuplicate(tpl: TrainingPlanTemplate) {
    try {
      const dup = await apiFetch<TrainingPlanTemplate>(`/training-plan-templates/${tpl.id}/duplicate`, { method: 'POST' });
      await load();
      startEdit(dup);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/training-plan-templates/${deleting.id}`, { method: 'DELETE' });
      if (editingId === deleting.id) setEditingId(null);
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Hierarchy ───────────────────────────────────────────────────────────────

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: TrainingPlanTemplate) {
    if (editingId === row.id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
    if (!expanded.has(row.id)) loadHierarchy(row.id);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  if (gymLoading || !canWrite) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={openInlineNew} disabled={inlineNew !== null} style={btnStyle()}>
            {t('add')}
          </button>
        </div>
      </div>

      {/* Sort controls */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 12, fontSize: 13, color: '#666' }}>
        {(['name', 'status', 'created_at'] as SortKey[]).map((key) => (
          <button key={key} onClick={() => toggleSort(key)} style={sortBtnStyle(sortKey === key)}>
            {t(`col_${key}`)}
            {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>

      {/* Column headers */}
      {(rows.length > 0 || inlineNew !== null) && (
        <div style={colHeaderStyle}>
          <div style={{ width: 20, flexShrink: 0 }} />
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('col_description')}</div>
          <div style={{ minWidth: 90 }}>{t('col_workout_count')}</div>
          <div style={{ minWidth: 100 }}>{t('col_created_at')}</div>
          <div style={{ minWidth: 110 }}>{t('col_created_by')}</div>
          <div style={{ minWidth: 80 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new row */}
      {inlineNew !== null && (
        <div style={{ ...cardStyle(false), marginBottom: 8 }}>
          <div style={{ padding: '16px 20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  ref={newNameRef}
                  value={inlineNew.name}
                  onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
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
            </div>
            {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall()}>
                {inlineNew.saving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : rows.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row) => (
            <TemplateCard
              key={row.id}
              template={row}
              expanded={expanded.has(row.id)}
              editing={editingId === row.id}
              editForm={editForm}
              editError={editError}
              editSaving={editSaving}
              hierarchy={hierarchies[row.id] ?? null}
              hierLoading={hierLoading.has(row.id)}
              canWrite={!!canWrite}
              locale={locale}
              t={t}
              tStatus={tStatus}
              fmtDate={fmtDate}
              onToggleExpand={() => toggleExpand(row)}
              onEdit={() => startEdit(row)}
              onDetails={() => setDetailsTemplate(row)}
              onDuplicate={() => handleDuplicate(row)}
              onDelete={() => setDeleting(row)}
              onAssign={() => setAssigning(row)}
              onEditFormChange={(f) => setEditForm(f)}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onChanged={() => refetchBranch(row.id)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{pageStart}–{pageEnd} / {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      {/* Details dialog */}
      <DetailsDialog template={detailsTemplate} locale={locale} t={t} tStatus={tStatus} onClose={() => setDetailsTemplate(null)} />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {/* Assign to member */}
      <NewTrainingPlanDialog
        open={assigning !== null}
        presetTemplate={assigning ? { id: assigning.id, name: assigning.name } : null}
        onClose={() => setAssigning(null)}
        onCreated={(plan) => { setAssigning(null); router.push(`/${locale}/training-plans/${plan.id}`); }}
      />
    </div>
  );
}

/* ---- TemplateCard ---- */

function TemplateCard({
  template, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t, tStatus, fmtDate,
  onToggleExpand, onEdit, onDetails, onDuplicate, onDelete, onAssign,
  onEditFormChange, onSave, onCancel, onChanged,
}: {
  template: TrainingPlanTemplate;
  expanded: boolean;
  editing: boolean;
  editForm: EditForm;
  editError: string | null;
  editSaving: boolean;
  hierarchy: Hierarchy | null;
  hierLoading: boolean;
  canWrite: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  fmtDate: (iso: string) => string;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDetails: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAssign: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const menuItems: ContextMenuItem[] = [
    { label: t('details'), onClick: onDetails },
    ...(canWrite ? [{ label: t('edit'), onClick: onEdit }] : []),
    ...(canWrite ? [{ label: t('duplicate'), onClick: onDuplicate }] : []),
    ...(template.status === 'active' ? [{ label: t('assign_to_member'), onClick: onAssign }] : []),
    ...(canWrite ? [{ label: t('delete'), onClick: onDelete, danger: true }] : []),
  ];

  const descText = template.description
    ? template.description.length > 60 ? template.description.slice(0, 60) + '…' : template.description
    : '—';

  return (
    <div style={cardStyle(editing)}>
      {/* Collapsed header — always visible */}
      <div
        style={headerRowStyle}
        onClick={onToggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
      >
        <span style={{ fontSize: 13, color: '#aaa', flexShrink: 0, display: 'inline-block', width: 14, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        <span style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {template.name}
        </span>
        <span style={{ flex: 3, fontSize: 13.5, color: '#888', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {descText}
        </span>
        <span style={{ minWidth: 90, fontSize: 13, color: '#666', flexShrink: 0 }}>
          {t('n_workouts', { count: template.workout_count })}
        </span>
        <span style={{ minWidth: 100, fontSize: 13, color: '#888', flexShrink: 0 }}>
          {fmtDate(template.created_at)}
        </span>
        <span style={{ minWidth: 110, fontSize: 13, color: '#888', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {template.created_by_name ?? '—'}
        </span>
        <span style={{ minWidth: 80, flexShrink: 0 }}>
          <StatusBadge status={template.status} label={tStatus(template.status)} />
        </span>
        <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
          <ContextMenu ariaLabel={t('col_actions')} items={menuItems} />
        </span>
      </div>

      {/* Inline edit form — shown when editing */}
      {editing && (
        <div style={{ padding: '0 20px 4px', borderTop: '1px solid var(--gd-border, #ececf0)' }}>
          <SectionHeader title={t('section_general')} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                value={editForm.name}
                onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_status')}</label>
              <select
                value={editForm.status}
                onChange={(e) => onEditFormChange({ ...editForm, status: e.target.value as TrainingPlanTemplate['status'] })}
                style={inlineSelectStyle}
              >
                {(['active', 'inactive', 'draft'] as const).map((s) => (
                  <option key={s} value={s}>{tStatus(s)}</option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <textarea
                value={editForm.description}
                onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
          </div>
          {editError && <p style={errorStyle}>{editError}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, marginBottom: 12 }}>
            <button onClick={onCancel} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={onSave} disabled={editSaving} style={btnSmall()}>
              {editSaving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      )}

      {/* Expanded workout tree — shown when expanded (editing or read-only) */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--gd-border, #ececf0)' }}>
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>
              {t('loading')}
            </p>
          ) : (
            <TrainingPlanTree
              templateId={template.id}
              hierarchy={hierarchy}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ---- DetailsDialog ---- */

function DetailsDialog({
  template, locale, t, tStatus, onClose,
}: {
  template: TrainingPlanTemplate | null;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  if (!template) return null;
  function fmtDate(value: string) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return (
    <CrudModal
      open
      title={t('details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('cancel')}
      saveLabel=""
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('label_name')} value={template.name} />
        <DetailRow label={t('label_description')} value={template.description ?? '—'} />
        <DetailRow label={t('label_status')} value={<StatusBadge status={template.status} label={tStatus(template.status)} />} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('label_created_at')} value={fmtDate(template.created_at)} />
        <DetailRow label={t('label_created_by')} value={template.created_by_name ?? '—'} />
        {template.modified_at && (
          <>
            <DetailRow label={t('label_modified_at')} value={fmtDate(template.modified_at)} />
            <DetailRow label={t('label_modified_by')} value={template.modified_by_name ?? '—'} />
          </>
        )}
        {template.deleted_at && (
          <>
            <DetailRow label={t('label_deleted_at')} value={fmtDate(template.deleted_at)} />
            <DetailRow label={t('label_deleted_by')} value={template.deleted_by_name ?? '—'} />
          </>
        )}
      </div>
    </CrudModal>
  );
}

/* ---- Shared sub-components ---- */

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#888', margin: '16px 0 10px' }}>
      {title}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13.5, width: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

/* ---- Styles ---- */

const filterInputStyle: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff',
};
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});
const sortBtnStyle = (active: boolean): React.CSSProperties => ({
  background: 'none', border: 'none', padding: '2px 8px', cursor: 'pointer',
  fontSize: 13, color: active ? '#4b45c6' : '#666', fontWeight: active ? 600 : 400,
  borderRadius: 4,
});
const colHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '4px 14px 6px',
  fontSize: 11, fontWeight: 700, color: '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase',
};
const cardStyle = (editing: boolean): React.CSSProperties => ({
  border: editing ? '1.5px solid #4b45c6' : '1px solid #ececf0',
  borderRadius: 10,
  background: 'var(--gd-card-bg, #ffffff)',
  overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
  cursor: 'pointer', userSelect: 'none',
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
const errorStyle: React.CSSProperties = {
  color: '#c00', fontSize: 13, margin: '4px 0 0',
};
