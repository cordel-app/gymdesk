'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { formActionsRowStyle } from '@/components/formChrome';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { SourceChip } from '@/components/SourceChip';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { btnStyle, cardSurfaceStyle, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { NutritionPlanTree, Hierarchy } from './NutritionPlanTree';
import { AssignNutritionPlanDialog, AssignedNutritionPlan } from '../AssignNutritionPlanDialog';
import { ImportNutritionPlanTemplatesModal, type ImportTemplatesResult } from './ImportNutritionPlanTemplatesModal';
import { NutritionPlanTemplateCard } from './NutritionPlanTemplateCard';
import {
  EMPTY_TEMPLATE_FORM, NUM_DAYS_OPTIONS, canResyncWithSystem, templateFormFromRow,
  templatePayload, templateSource, toNumDays, type TemplateForm,
} from './nutritionPlanTemplateList';

export interface NutritionPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  member_notes?: string | null;
  status: 'active' | 'inactive' | 'draft';
  day_count: number;
  /** #3333: the number of days the plan covers, 0..7. */
  num_days: number;
  /** #3333: derived by the API — 'system' for a copy of a System template, else 'custom'. */
  source?: 'system' | 'custom';
  cloned_from_id?: number | null;
  gym_id?: string | null;
  created_by: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface ListResponse {
  items: NutritionPlanTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive', 'draft'] as const;
const LIMIT = 20;
const emptyForm: TemplateForm = EMPTY_TEMPLATE_FORM;

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 4 — the row is laid out from one declaration rather than from
 * per-cell `flex`/`maxWidth` guesses (#637's shape, which stage 3's eight card
 * lists already adopted). The name cell was `flexShrink: 0` and the description
 * `flex: 1`, so on a narrow viewport the description was taken to zero and the
 * rest of the row overflowed — the defect one cell over from the ticket's own
 * screenshot.
 *
 * This list carries no header band, so there is nothing for the tracks to fall
 * out of line *with* — adding one would be a desktop change §4 rules out — but
 * the row still needs each cell to say what it is on a phone. The template's
 * name is the row's identity and its status is the one state worth seeing
 * without tapping; the description, the author and the date are read in the
 * expanded tree.
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `nutrition_plan_templates` namespace. Absent = no title. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

// #3333 stage 2: the Exercises list's columns, with Days in place of Primary Muscles.
const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'days', labelKey: 'col_days', width: 60, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 90, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 120, mobile: 'secondary' },
  { key: 'source', labelKey: 'col_source', width: 110, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 80, mobile: 'keep' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 13, mobile: 'keep' },
  { key: 'actions', width: 32, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 20;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

export default function NutritionPlanTemplatesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<NutritionPlanTemplate[]>([]);
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

  // Pending new (inline temp row)
  const [pendingNew, setPendingNew] = useState(false);
  const [pendingNewForm, setPendingNewForm] = useState(emptyForm);
  const [pendingNewSaving, setPendingNewSaving] = useState(false);
  const [pendingNewError, setPendingNewError] = useState<string | null>(null);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Unsaved-changes guard
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Details dialog
  const [detailsTemplate, setDetailsTemplate] = useState<NutritionPlanTemplate | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<NutritionPlanTemplate | null>(null);

  // Assign to member
  const [assigning, setAssigning] = useState<NutritionPlanTemplate | null>(null);

  // #3333 stage 2: Cards by default, the saved choice afterwards (the Exercises toggle).
  const [viewMode, setViewMode] = useExerciseViewMode();
  const [importOpen, setImportOpen] = useState(false);

  // Row expansion + lazy hierarchy cache
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('NUTRITION');
  useEffect(() => { if (!gymLoading && !canRead) router.replace(`/${locale}`); }, [gymLoading, canRead]);

  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

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
      const res = await apiFetch<ListResponse>(`/nutrition-plan-templates?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/nutrition-plan-templates/created-by-options')
      .then(setCreatedByOptions)
      .catch(() => {});
  }, [activeGymId, gymLoading]);

  function guardUnsaved(action: () => void) {
    if (editingId !== null || pendingNew) setPendingAction(() => action);
    else action();
  }

  function cancelPendingNew() {
    setPendingNew(false);
    setPendingNewForm(emptyForm);
    setPendingNewError(null);
  }

  function startEdit(tpl: NutritionPlanTemplate) {
    // The editor and the plan tree live in the List view.
    if (viewMode !== 'list') setViewMode('list');
    setEditingId(tpl.id);
    setEditForm(templateFormFromRow(tpl));
    setEditError(null);
    if (!expanded.has(tpl.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(tpl.id); return next; });
      loadHierarchy(tpl.id);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyForm);
    setEditError(null);
  }

  async function saveEdit() {
    const payload = templatePayload(editForm);
    if (!payload.ok) { setEditError(t(`nutrition_plan_templates.${payload.errorKey}`)); return; }
    setEditSaving(true); setEditError(null);
    const body = payload.body;
    try {
      await apiFetch(`/nutrition-plan-templates/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditingId(null); setEditForm(emptyForm); load();
    } catch (err: any) {
      setEditError(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setEditSaving(false); }
  }

  async function savePendingNew() {
    const payload = templatePayload(pendingNewForm);
    if (!payload.ok) { setPendingNewError(t(`nutrition_plan_templates.${payload.errorKey}`)); return; }
    setPendingNewSaving(true); setPendingNewError(null);
    const body = payload.body;
    try {
      await apiFetch('/nutrition-plan-templates', { method: 'POST', body: JSON.stringify(body) });
      setPendingNew(false); setPendingNewForm(emptyForm); load();
    } catch (err: any) { setPendingNewError(err.message ?? t('nutrition_plan_templates.error_generic')); }
    finally { setPendingNewSaving(false); }
  }

  async function handleDuplicate(tpl: NutritionPlanTemplate) {
    try {
      await apiFetch(`/nutrition-plan-templates/${tpl.id}/duplicate`, { method: 'POST' });
      toast(t('nutrition_plan_templates.duplicated'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  // ─── Resync with System (#3333, the Exercises' #2302) ─────────────────────
  async function handleResync(tpl: NutritionPlanTemplate) {
    try {
      const res = await apiFetch<{ updated: string[] }>(`/nutrition-plan-templates/${tpl.id}/resync-with-system`, { method: 'POST' });
      toast(res.updated.length > 0 ? t('nutrition_plan_templates.resync_done') : t('nutrition_plan_templates.resync_up_to_date'),
        res.updated.length > 0 ? 'success' : 'info');
      load();
    } catch (err: any) {
      const code = err?.body?.code;
      toast(code === 'base_unavailable' ? t('nutrition_plan_templates.resync_base_gone')
        : code === 'name_taken' ? t('nutrition_plan_templates.resync_name_taken')
        : (err.message ?? t('nutrition_plan_templates.error_generic')));
    }
  }

  function handleImported(result: ImportTemplatesResult) {
    setImportOpen(false);
    const parts = [t('nutrition_plan_templates.imported', { n: result.imported.length })];
    if (result.skipped.length > 0) parts.push(t('nutrition_plan_templates.imported_skipped', { n: result.skipped.length }));
    toast(parts.join(' '), 'success');
    load();
  }

  /** The `⋮` actions of one template — shared by the list row and the card. */
  function templateMenuItems(row: NutritionPlanTemplate): ContextMenuItem[] {
    const roTitle = canWrite ? undefined : readOnlyTitle;
    return [
      { kind: 'edit' as const, label: t('nutrition_plan_templates.edit'), onClick: () => guardUnsaved(() => startEdit(row)), disabled: !canWrite, title: roTitle },
      { kind: 'details' as const, label: t('nutrition_plan_templates.details'), onClick: () => guardUnsaved(() => setDetailsTemplate(row)) },
      { label: t('nutrition_plan_templates.duplicate'), onClick: () => guardUnsaved(() => handleDuplicate(row)), disabled: !canWrite, title: roTitle },
      ...(canResyncWithSystem(row)
        ? [{ label: t('nutrition_plan_templates.resync_with_system'), onClick: () => guardUnsaved(() => handleResync(row)), disabled: !canWrite, title: roTitle }]
        : []),
      ...(row.status === 'active' ? [{ label: t('nutrition_plan_templates.assign_to_member'), onClick: () => guardUnsaved(() => setAssigning(row)), disabled: !canWrite, title: roTitle }] : []),
      { kind: 'delete' as const, label: t('nutrition_plan_templates.delete'), onClick: () => guardUnsaved(() => setDeleting(row)), danger: true, disabled: !canWrite, title: roTitle },
    ];
  }

  async function del() {
    if (!deleting) return;
    try {
      await apiFetch(`/nutrition-plan-templates/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  function handleAssigned(_plan: AssignedNutritionPlan) {
    setAssigning(null);
    toast(t('nutrition_plans.assigned'), 'success');
    router.push(`/${locale}/nutrition/nutrition-plans`);
  }

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<Hierarchy>(`/nutrition-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<Hierarchy>(`/nutrition-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: NutritionPlanTemplate) {
    const isExpanded = expanded.has(row.id);
    if (isExpanded && editingId === row.id) {
      guardUnsaved(() => {
        cancelEdit();
        setExpanded((prev) => { const next = new Set(prev); next.delete(row.id); return next; });
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
    if (!isExpanded) loadHierarchy(row.id);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  if (gymLoading || !canRead) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      {/* Header (#3333 stage 2: the Exercises page's title + actions) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('nutrition_plan_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => guardUnsaved(() => setImportOpen(true))}
            disabled={!canWrite}
            title={readOnlyTitle}
            style={readOnlyStyle(primaryBtnStyle(), !canWrite)}
          >
            {t('nutrition_plan_templates.import_system_templates')}
          </button>
          <button
            onClick={() => guardUnsaved(() => {
              if (viewMode !== 'list') setViewMode('list');
              setPendingNewForm(emptyForm); setPendingNewError(null); setPendingNew(true);
            })}
            disabled={!canWrite}
            title={readOnlyTitle}
            style={readOnlyStyle(primaryBtnStyle(), !canWrite)}
          >
            {t('nutrition_plan_templates.add_new')}
          </button>
        </div>
      </div>

      <FilterBar>
        <FilterField label={t('nutrition_plan_templates.filter_search')} htmlFor="npt-search">
          <input
            id="npt-search"
            type="search"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('nutrition_plan_templates.filter_name')}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('nutrition_plan_templates.label_created_by')} htmlFor="npt-created-by">
          <select id="npt-created-by" value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('nutrition_plan_templates.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('nutrition_plan_templates.label_status')} htmlFor="npt-status">
          <StatusFilter
            id="npt-status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
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
            {t(`nutrition_plan_templates.col_${key}`)}
            {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>

      {/* Template list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('nutrition_plan_templates.loading')}</p>
      ) : rows.length === 0 && !pendingNew ? (
        <p style={{ color: '#888' }}>{t('nutrition_plan_templates.empty')}</p>
      ) : viewMode === 'cards' ? (
        <CardGrid>
          {rows.map((row) => (
            <NutritionPlanTemplateCard key={row.id} template={row} menuItems={templateMenuItems(row)} />
          ))}
        </CardGrid>
      ) : (
        /* The header band and the cards share LIST_GRID_COLUMNS and scroll
           together, so a narrow viewport scrolls the list instead of the page (#1011). */
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
        <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
        <div className={LIST_GRID_ROW_CLASS} style={headerBandStyle}>
          {LIST_COLUMNS.map((col) => (
            <span key={col.key} className={CELL_CLASS[col.key]}>
              {col.labelKey ? t(`nutrition_plan_templates.${col.labelKey}`) : null}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pendingNew && (
            <PendingNewCard
              form={pendingNewForm}
              error={pendingNewError}
              saving={pendingNewSaving}
              t={t}
              onFormChange={setPendingNewForm}
              onSave={savePendingNew}
              onCancel={cancelPendingNew}
            />
          )}
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
              t={t}
              menuItems={templateMenuItems(row)}
              onToggleExpand={() => toggleExpand(row)}
              onEditFormChange={(f) => setEditForm(f)}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onChanged={() => refetchBranch(row.id)}
            />
          ))}
        </div>
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

      <ImportNutritionPlanTemplatesModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={handleImported}
      />

      {/* Assign to member dialog */}
      <AssignNutritionPlanDialog
        open={assigning !== null}
        template={assigning}
        onClose={() => setAssigning(null)}
        onAssigned={handleAssigned}
      />

      {/* Details dialog */}
      <DetailsDialog template={detailsTemplate} locale={locale} t={t} onClose={() => setDetailsTemplate(null)} />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('nutrition_plan_templates.confirm_delete')}
        confirmLabel={t('nutrition_plan_templates.delete')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={del}
        onCancel={() => setDeleting(null)}
      />

      {/* Unsaved changes guard */}
      <ConfirmDialog
        open={pendingAction !== null}
        message={t('nutrition_plan_templates.unsaved_changes')}
        confirmLabel={t('nutrition_plan_templates.unsaved_discard')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          cancelPendingNew();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

/* ---- TemplateCard ---- */

type EditForm = TemplateForm;

function TemplateCard({
  template, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, t, menuItems,
  onToggleExpand,
  onEditFormChange, onSave, onCancel, onChanged,
}: {
  template: NutritionPlanTemplate;
  expanded: boolean;
  editing: boolean;
  editForm: EditForm;
  editError: string | null;
  editSaving: boolean;
  hierarchy: Hierarchy | null;
  hierLoading: boolean;
  canWrite: boolean;
  t: ReturnType<typeof useTranslations>;
  menuItems: ContextMenuItem[];
  onToggleExpand: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  const system = templateSource(template) === 'system';

  return (
    <div style={cardStyle(editing)}>
      {/* Edit mode header */}
      {editing ? (
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_name')} *</label>
              <input
                value={editForm.name}
                onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus
                style={inlineInputStyle}
              />
              {editError && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{editError}</p>}
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_description')}</label>
              <textarea
                value={editForm.description}
                onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_member_notes')}</label>
              <textarea
                value={editForm.member_notes}
                onChange={(e) => onEditFormChange({ ...editForm, member_notes: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_status')}</label>
              <select
                value={editForm.status}
                onChange={(e) => onEditFormChange({ ...editForm, status: e.target.value })}
                style={{ ...inlineInputStyle, width: 'auto' }}
              >
                {(['active', 'inactive', 'draft'] as const).map((s) => (
                  <option key={s} value={s}>{t(`status.${s}`)}</option>
                ))}
              </select>
            </div>
            <NumDaysField value={editForm.num_days} t={t} onChange={(n) => onEditFormChange({ ...editForm, num_days: n })} />
          </div>
        </div>
      ) : (
        <div
          onClick={onToggleExpand}
          className={LIST_GRID_ROW_CLASS}
          style={headerRowStyle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
        >
          <span className={CELL_CLASS.name} title={template.name} style={nameCellStyle}>{template.name}</span>
          <span className={CELL_CLASS.description} style={descCellStyle}>{template.description ?? '—'}</span>
          <span className={CELL_CLASS.days} style={{ fontSize: 13, color: '#555' }}>{toNumDays(template.num_days)}</span>
          <span className={CELL_CLASS.created_at} style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>
            {formatDate(template.created_at, gymFmt)}
          </span>
          <span className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {template.created_by ?? '—'}
          </span>
          <span className={CELL_CLASS.source}>
            <SourceChip system={system} label={system ? t('nutrition_plan_templates.source_system') : t('nutrition_plan_templates.source_custom')} />
          </span>
          <span className={CELL_CLASS.status}>
            <StatusBadge status={template.status} label={t(`status.${template.status}`)} />
          </span>
          <span className={CELL_CLASS.expand} style={{ fontSize: 13, color: '#aaa', display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', userSelect: 'none' }}>▾</span>
          <span className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('nutrition_plan_templates.col_actions')} items={menuItems} />
          </span>
        </div>
      )}

      {/* Expanded nutrition tree */}
      {expanded && (
        <>
          <div style={{ borderTop: '1px solid #ececf0' }} />
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>
              {t('nutrition_plan_templates.loading')}
            </p>
          ) : (
            <NutritionPlanTree
              templateId={template.id}
              hierarchy={hierarchy}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          )}
        </>
      )}

      {/* Save / Cancel footer (edit mode) */}
      {editing && (
        <div style={editorActionsRowStyle}>
          <button onClick={onCancel} style={cancelBtnStyle}>{t('nutrition_plan_templates.cancel')}</button>
          <button onClick={onSave} disabled={editSaving} style={btnStyle()}>
            {editSaving ? t('nutrition_plan_templates.saving') : t('nutrition_plan_templates.save_changes')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- PendingNewCard ---- */

function PendingNewCard({
  form, error, saving, t, onFormChange, onSave, onCancel,
}: {
  form: TemplateForm;
  error: string | null;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
  onFormChange: (f: TemplateForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ ...cardSurfaceStyle, border: '1.5px solid #4b45c6', overflow: 'hidden' }}>
      <div style={{ padding: '16px 16px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_name')} *</label>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
              style={inlineInputStyle}
            />
            {error && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}
          </div>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_description')}</label>
            <textarea
              value={form.description}
              onChange={(e) => onFormChange({ ...form, description: e.target.value })}
              rows={2}
              style={{ ...inlineInputStyle, resize: 'vertical' }}
            />
          </div>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_member_notes')}</label>
            <textarea
              value={form.member_notes}
              onChange={(e) => onFormChange({ ...form, member_notes: e.target.value })}
              rows={2}
              style={{ ...inlineInputStyle, resize: 'vertical' }}
            />
          </div>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_status')}</label>
            <select
              value={form.status}
              onChange={(e) => onFormChange({ ...form, status: e.target.value })}
              style={{ ...inlineInputStyle, width: 'auto' }}
            >
              {(['active', 'inactive', 'draft'] as const).map((s) => (
                <option key={s} value={s}>{t(`status.${s}`)}</option>
              ))}
            </select>
          </div>
          <NumDaysField value={form.num_days} t={t} onChange={(n) => onFormChange({ ...form, num_days: n })} />
        </div>
      </div>
      <div style={editorActionsRowStyle}>
        <button onClick={onCancel} style={cancelBtnStyle}>{t('nutrition_plan_templates.cancel')}</button>
        <button onClick={onSave} disabled={saving} style={btnStyle()}>
          {saving ? t('nutrition_plan_templates.saving') : t('nutrition_plan_templates.save_changes')}
        </button>
      </div>
    </div>
  );
}

/* ---- DetailsDialog ---- */

function DetailsDialog({
  template, locale, t, onClose,
}: {
  template: NutritionPlanTemplate | null;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  if (!template) return null;
  return (
    <CrudModal
      open
      title={t('nutrition_plan_templates.details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('nutrition_plan_templates.cancel')}
      saveLabel=""
      extraFooter={<ViewAuditLogButton entityType="nutrition_plan_template" entityId={template.id} onNavigate={onClose} />}
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('nutrition_plan_templates.label_name')} value={template.name} />
        <DetailRow label={t('nutrition_plan_templates.label_description')} value={template.description ?? '—'} />
        <DetailRow label={t('nutrition_plan_templates.label_member_notes')} value={template.member_notes ?? '—'} />
        <DetailRow label={t('nutrition_plan_templates.label_status')} value={<StatusBadge status={template.status} label={t(`status.${template.status}`)} />} />
        <DetailRow label={t('nutrition_plan_templates.label_num_days')} value={toNumDays(template.num_days)} />
        <DetailRow label={t('nutrition_plan_templates.col_source')} value={templateSource(template) === 'system' ? t('nutrition_plan_templates.source_system') : t('nutrition_plan_templates.source_custom')} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('nutrition_plan_templates.label_created_at')} value={formatDate(template.created_at, gymFmt)} />
        <DetailRow label={t('nutrition_plan_templates.label_created_by')} value={template.created_by ?? '—'} />
        {template.modified_at && (
          <>
            <DetailRow label={t('nutrition_plan_templates.label_modified_at')} value={formatDate(template.modified_at, gymFmt)} />
            <DetailRow label={t('nutrition_plan_templates.label_modified_by')} value={template.modified_by ?? '—'} />
          </>
        )}
      </div>
    </CrudModal>
  );
}

/** #3333: the template's number of days — a choice of 0..7, so an out-of-range value cannot be entered. */
function NumDaysField({ value, t, onChange }: {
  value: number;
  t: ReturnType<typeof useTranslations>;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <label style={inlineLabelStyle}>{t('nutrition_plan_templates.label_num_days')}</label>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ...inlineInputStyle, width: 'auto' }}>
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

function formatDate(value: string, settings: GymFormatSettings): string {
  return formatGymDate(value, settings);
}

const headerBandStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP, marginBottom: 4,
  color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
};
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});
const sortBtnStyle = (active: boolean): React.CSSProperties => ({
  background: 'none', border: 'none', padding: '2px 8px', cursor: 'pointer',
  fontSize: 13, color: active ? '#4b45c6' : '#666', fontWeight: active ? 600 : 400, borderRadius: 4,
});
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
const nameCellStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 15, minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const descCellStyle: React.CSSProperties = {
  color: '#888', fontSize: 13.5, minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
// #3473: the editor's Cancel/Save pair is the app's card-level action row (Cancel, then Save,
// left-aligned), padded to the card's own inset.
const editorActionsRowStyle: React.CSSProperties = { ...formActionsRowStyle, alignItems: 'center', marginTop: 12, padding: '12px 16px 14px' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
