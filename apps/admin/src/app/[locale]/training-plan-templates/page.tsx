'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { type ContextMenuItem } from '@/components/ContextMenu';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { btnSmall, cardSurfaceStyle, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS,
  listScrollerClass,
} from '@/components/listChrome';
import { inlineActionsRowStyle, secondaryBtnSmall } from '@/components/formChrome';
import { TrainingPlanTree, Hierarchy } from './TrainingPlanTree';
import { NewTrainingPlanDialog } from '../training-plans/NewTrainingPlanDialog';
import { ImportTrainingPlanTemplatesModal, type ImportTemplatesResult } from './ImportTrainingPlanTemplatesModal';
import { TrainingPlanTemplateCard } from './TrainingPlanTemplateCard';
import {
  EMPTY_TEMPLATE_FORM, NUM_DAYS_OPTIONS, canResyncWithSystem, templateFormFromRow, templatePayload,
  templateSource, toNumDays, type TemplateForm,
} from './trainingPlanTemplateList';
import {
  CELL_CLASS, LIST_COLUMNS, LIST_COLUMN_GAP, LIST_GRID_COLUMNS, LIST_MIN_WIDTH, ROW_PADDING_X, TemplateRowCells,
} from './TemplateRowCells';

export interface TrainingPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  workout_count: number;
  /** #3334: the number of days the plan covers, 0..7. */
  num_days: number;
  /** #3334: derived by the API — 'system' for a copy of a System template, else 'custom'. */
  source?: 'system' | 'custom';
  cloned_from_id?: number | null;
  gym_id: string | null;
  created_by: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface ListResponse {
  items: TrainingPlanTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive', 'draft'] as const;
const LIMIT = 20;
const emptyEditForm: TemplateForm = EMPTY_TEMPLATE_FORM;
type EditForm = TemplateForm;

type InlineNew = { form: TemplateForm; saving: boolean; error: string | null };

export default function TrainingPlanTemplatesPage() {
  const t = useTranslations('training_plan_templates');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const gymFmt = useGymFormatSettings();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
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

  // #3334 stage 2: Cards by default, the saved choice afterwards (the Exercises toggle).
  const [viewMode, setViewMode] = useExerciseViewMode();
  const [importOpen, setImportOpen] = useState(false);

  // Row expansion + per-template lazy-loaded hierarchy
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());
  // #966: a failed expand used to leave the row on `Loading…` for ever, because
  // the body renders the tree only once `hierarchy` arrives. The failure is kept
  // per template so the row can say so and offer Retry.
  const [hierError, setHierError] = useState<Record<number, string>>({});

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('TRAINING');
  useEffect(() => { if (!gymLoading && !canRead) router.replace(`/${locale}`); }, [gymLoading, canRead]);

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
    if (viewMode !== 'list') setViewMode('list');
    setInlineNew({ form: emptyEditForm, saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setInlineNew(null);
  }

  async function saveInlineNew() {
    if (!inlineNew) return;
    const payload = templatePayload(inlineNew.form);
    if (!payload.ok) {
      setInlineNew({ ...inlineNew, error: t(payload.errorKey) });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<TrainingPlanTemplate>('/training-plan-templates', {
        method: 'POST',
        body: JSON.stringify(payload.body),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  function startEdit(tpl: TrainingPlanTemplate) {
    // The editor and the workout tree live in the List view.
    if (viewMode !== 'list') setViewMode('list');
    setEditingId(tpl.id);
    setEditForm(templateFormFromRow(tpl));
    setEditError(null);
    setExpanded((prev) => new Set([...prev, tpl.id]));
    loadHierarchy(tpl.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit() {
    const payload = templatePayload(editForm);
    if (!payload.ok) { setEditError(t(payload.errorKey)); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/training-plan-templates/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify(payload.body),
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

  // ─── Resync with System (#3334, the Exercises' #2302) ──────────────────────

  async function handleResync(tpl: TrainingPlanTemplate) {
    try {
      const res = await apiFetch<{ updated: string[] }>(`/training-plan-templates/${tpl.id}/resync-with-system`, { method: 'POST' });
      toast(res.updated.length > 0 ? t('resync_done') : t('resync_up_to_date'), res.updated.length > 0 ? 'success' : 'info');
      load();
    } catch (err: any) {
      const code = err?.body?.code;
      toast(code === 'base_unavailable' ? t('resync_base_gone')
        : code === 'name_taken' ? t('resync_name_taken')
        : (err.message ?? t('error_generic')));
    }
  }

  function handleImported(result: ImportTemplatesResult) {
    setImportOpen(false);
    const parts = [t('imported', { n: result.imported.length })];
    if (result.skipped.length > 0) parts.push(t('imported_skipped', { n: result.skipped.length }));
    toast(parts.join(' '), 'success');
    load();
  }

  /** The `⋮` actions of one template — shared by the list row and the card. */
  function templateMenuItems(row: TrainingPlanTemplate): ContextMenuItem[] {
    const roTitle = canWrite ? undefined : readOnlyTitle;
    return [
      { kind: 'details' as const, label: t('details'), onClick: () => setDetailsTemplate(row) },
      { kind: 'edit' as const, label: t('edit'), onClick: () => startEdit(row), disabled: !canWrite, title: roTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(row), disabled: !canWrite, title: roTitle },
      ...(canResyncWithSystem(row)
        ? [{ label: t('resync_with_system'), onClick: () => handleResync(row), disabled: !canWrite, title: roTitle }]
        : []),
      ...(row.status === 'active' ? [{ label: t('assign_to_member'), onClick: () => setAssigning(row), disabled: !canWrite, title: roTitle }] : []),
      { kind: 'delete' as const, label: t('delete'), onClick: () => setDeleting(row), danger: true, disabled: !canWrite, title: roTitle },
    ];
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

  async function loadHierarchy(id: number, opts: { retry?: boolean } = {}) {
    if (hierLoading.has(id)) return;
    if (hierarchies[id] && !opts.retry) return;
    setHierError((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev }; delete next[id]; return next;
    });
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      setHierError((prev) => ({ ...prev, [id]: err.message ?? t('hierarchy_error') }));
      toast(err.message ?? t('hierarchy_error'));
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
    return formatGymDate(iso, gymFmt);
  }

  if (gymLoading || !canRead) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      {/* Header (#3334 stage 2: the Exercises page's title + actions) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setImportOpen(true)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)}>
            {t('import_system_templates')}
          </button>
          <button onClick={openInlineNew} disabled={!canWrite || inlineNew !== null} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)}>
            {t('add')}
          </button>
        </div>
      </div>

      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="tpt-search">
          <input
            id="tpt-search"
            type="search"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('label_created_by')} htmlFor="tpt-created-by">
          <select id="tpt-created-by" value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('label_status')} htmlFor="tpt-status">
          <StatusFilter
            id="tpt-status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
            style={filterControlStyle}
          />
        </FilterField>
        <div style={{ marginLeft: 'auto' }}>
          <ExerciseViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </FilterBar>

      {/* Sort controls */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 12, fontSize: 13, color: '#666' }}>
        {(['name', 'status', 'created_at'] as SortKey[]).map((key) => (
          <button key={key} onClick={() => toggleSort(key)} style={sortBtnStyle(sortKey === key)}>
            {t(`col_${key}`)}
            {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: '#888' }}>{t('loading')}</p>}
      {!loading && rows.length === 0 && inlineNew === null && (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      )}

      {/* The header band, the inline new card and the cards share
          LIST_GRID_COLUMNS and scroll together, so they cannot fall out of
          line, and a narrow viewport scrolls the list instead of the page
          (#1011). The wrapper exists only when there is a list to lay out, so
          an empty state is not pinned to the track sum. */}
      {viewMode === 'cards' && rows.length > 0 && inlineNew === null && (
        <CardGrid>
          {rows.map((row) => (
            <TrainingPlanTemplateCard key={row.id} template={row} menuItems={templateMenuItems(row)} />
          ))}
        </CardGrid>
      )}

      {viewMode === 'list' && (rows.length > 0 || inlineNew !== null) && (
      <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
      <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>

      {/* Column headers */}
      <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
        {LIST_COLUMNS.map((col) => (
          <div key={col.key} className={CELL_CLASS[col.key]}>
            {col.labelKey ? t(col.labelKey) : null}
          </div>
        ))}
      </div>

      {/* Inline new row */}
      {inlineNew !== null && (
        <div style={{ ...cardStyle(false), marginBottom: 8 }}>
          <div style={{ padding: '16px 20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  ref={newNameRef}
                  value={inlineNew.form.name}
                  onChange={(e) => setInlineNew({ ...inlineNew, form: { ...inlineNew.form, name: e.target.value } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
                  placeholder={t('placeholder_name')}
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <input
                  value={inlineNew.form.description}
                  onChange={(e) => setInlineNew({ ...inlineNew, form: { ...inlineNew.form, description: e.target.value } })}
                  style={inlineInputStyle}
                />
              </div>
              <NumDaysField
                value={inlineNew.form.num_days}
                label={t('label_num_days')}
                onChange={(n) => setInlineNew({ ...inlineNew, form: { ...inlineNew.form, num_days: n } })}
              />
            </div>
            {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
            <div style={inlineActionsRowStyle}>
              <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall()}>
                {inlineNew.saving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template list */}
      {rows.length > 0 && (
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
              hierError={hierError[row.id] ?? null}
              onRetryHierarchy={() => loadHierarchy(row.id, { retry: true })}
              canWrite={!!canWrite}
              locale={locale}
              t={t}
              tStatus={tStatus}
              fmtDate={fmtDate}
              onToggleExpand={() => toggleExpand(row)}
              menuItems={templateMenuItems(row)}
              onEditFormChange={(f) => setEditForm(f)}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onChanged={() => refetchBranch(row.id)}
            />
          ))}
        </div>
      )}

      </div>
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

      <ImportTrainingPlanTemplatesModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={handleImported}
      />

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
  hierarchy, hierLoading, hierError, canWrite, locale, t, tStatus, fmtDate, menuItems,
  onToggleExpand,
  onEditFormChange, onSave, onCancel, onChanged, onRetryHierarchy,
}: {
  template: TrainingPlanTemplate;
  expanded: boolean;
  editing: boolean;
  editForm: EditForm;
  editError: string | null;
  editSaving: boolean;
  hierarchy: Hierarchy | null;
  hierLoading: boolean;
  hierError: string | null;
  canWrite: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  fmtDate: (iso: string) => string;
  menuItems: ContextMenuItem[];
  onToggleExpand: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
  onRetryHierarchy: () => void;
}) {
  return (
    <div style={cardStyle(editing)}>
      {/* Collapsed header — always visible */}
      <div
        className={LIST_GRID_ROW_CLASS}
        style={headerRowStyle}
        onClick={onToggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
      >
        <TemplateRowCells template={template} expanded={expanded} menuItems={menuItems} fmtDate={fmtDate} />
      </div>

      {/* Inline edit form — shown when editing */}
      {editing && (
        <div style={{ padding: '0 20px 4px', borderTop: '1px solid var(--gd-card-border, #ececf0)' }}>
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
                onChange={(e) => onEditFormChange({ ...editForm, status: e.target.value as EditForm['status'] })}
                style={inlineSelectStyle}
              >
                {(['active', 'inactive', 'draft'] as const).map((s) => (
                  <option key={s} value={s}>{tStatus(s)}</option>
                ))}
              </select>
            </div>
            <NumDaysField
              value={editForm.num_days}
              label={t('label_num_days')}
              onChange={(n) => onEditFormChange({ ...editForm, num_days: n })}
            />
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
          <div style={{ ...inlineActionsRowStyle, marginTop: 12, marginBottom: 12 }}>
            <button onClick={onCancel} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={onSave} disabled={editSaving} style={btnSmall()}>
              {editSaving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      )}

      {/* Expanded workout tree — shown when expanded (editing or read-only) */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--gd-card-border, #ececf0)' }}>
          {hierarchy ? (
            <TrainingPlanTree
              templateId={template.id}
              hierarchy={hierarchy}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          ) : hierLoading || !hierError ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>
              {t('loading')}
            </p>
          ) : (
            /* #966: an application-level failure with a way out, instead of a
               row stuck on `Loading…` for ever. */
            <div style={{ padding: '12px 20px 12px 44px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <p style={{ ...errorStyle, margin: 0 }}>{t('hierarchy_error')}</p>
              <button onClick={onRetryHierarchy} style={secondaryBtnSmall}>{t('retry')}</button>
            </div>
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
  const gymFmt = useGymFormatSettings();
  if (!template) return null;
  function fmtDate(value: string) {
    return formatGymDate(value, gymFmt);
  }
  return (
    <CrudModal
      open
      title={t('details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('cancel')}
      saveLabel=""
      extraFooter={<ViewAuditLogButton entityType="training_plan_template" entityId={template.id} onNavigate={onClose} />}
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('label_name')} value={template.name} />
        <DetailRow label={t('label_description')} value={template.description ?? '—'} />
        <DetailRow label={t('label_status')} value={<StatusBadge status={template.status} label={tStatus(template.status)} />} />
        <DetailRow label={t('label_num_days')} value={toNumDays(template.num_days)} />
        <DetailRow label={t('col_source')} value={templateSource(template) === 'system' ? t('source_system') : t('source_custom')} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('label_created_at')} value={fmtDate(template.created_at)} />
        <DetailRow label={t('label_created_by')} value={template.created_by ?? '—'} />
        {template.modified_at && (
          <>
            <DetailRow label={t('label_modified_at')} value={fmtDate(template.modified_at)} />
            <DetailRow label={t('label_modified_by')} value={template.modified_by ?? '—'} />
          </>
        )}
        {template.deleted_at && (
          <>
            <DetailRow label={t('label_deleted_at')} value={fmtDate(template.deleted_at)} />
            <DetailRow label={t('label_deleted_by')} value={template.deleted_by ?? '—'} />
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

/** #3334: the template's number of days — a choice of 0..7, so an out-of-range value cannot be entered. */
function NumDaysField({ value, label, onChange }: { value: number; label: string; onChange: (n: number) => void }) {
  return (
    <div>
      <label style={inlineLabelStyle}>{label}</label>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ...inlineSelectStyle, width: 'auto' }}>
        {NUM_DAYS_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
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
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `4px ${ROW_PADDING_X}px 6px`,
  fontSize: 11, fontWeight: 700, color: '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase',
};
const cardStyle = (editing: boolean): React.CSSProperties => ({
  ...cardSurfaceStyle,
  ...(editing ? { border: '1.5px solid #4b45c6' } : {}),
  overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
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
