'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { displayTrainingPlanName } from '@/lib/trainingPlanName';
import { useModuleAccess, useReadOnlyTitle } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { AssignedPlanDateFields } from '@/components/AssignedPlanDateFields';
import { assignedPlanDateTexts } from '@/lib/assignedPlanDates';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, LIST_PADDING_X, type ListGridColumn,
  listCellClasses, listCellStyle, listExpandedStyle, listHeaderCellStyle,
  listHeaderRowStyle, listRowDividerStyle, listScrollerClass, listSurfaceStyle,
} from '@/components/listChrome';
import { primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import {
  formActionsRowStyle, formControlStyle, formFieldErrorStyle, formFieldLabelStyle,
  secondaryBtnStyle,
} from '@/components/formChrome';
import { NewTrainingPlanDialog } from './NewTrainingPlanDialog';
import { PlanWorkoutTree, type Workout } from './PlanWorkoutTree';

/* ---- Types ---- */

interface TrainingPlanRow {
  id: number;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'expired' | 'completed';
  start_date: string;
  end_date: string | null;
  member_id: number;
  member_name: string;
  draft_of_plan_id?: number | null;
  template_id: number | null;
  template_name: string | null;
  created_by: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by: string | null;
  workouts?: Workout[] | null;
  /** #3403: the plan's training days (its workouts). */
  day_count?: number;
}
interface ListResponse { items: TrainingPlanRow[]; total: number; limit: number; offset: number }
interface CreatedByOption { name: string }
interface MemberOption { id: number; name: string }
interface TemplateOption { id: number; name: string }

type SortKey = 'name' | 'member' | 'template' | 'status' | 'start_date' | 'end_date' | 'created_by' | 'created_at' | 'modified_at';

const STATUSES = ['draft', 'active', 'expired', 'completed'] as const;
const LIMIT = 20;

/* ---- List columns (#724) ----
 *
 * The list header and every plan row are laid out on one grid built from this
 * list, so a column title cannot drift away from the values underneath it. The
 * columns themselves are the ones the page already had: the ticket is a layout
 * change, not a column change. Member and description ride along in the Name
 * column and the end date under the start date, the way Assigned Plans puts a
 * member's document number under their name.
 */

interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `training_plans` namespace. Absent = no title. */
  labelKey?: string;
  /** Selecting the title sorts by this key. Absent = not sortable. */
  sortKey?: SortKey;
  /** Fixed track width in px — also the minimum for the flexible column. */
  width: number;
  /** Set on the one flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

// #1011 stage 2: `mobile` says what each column is on a phone, in the one
// vocabulary `listChrome` declares. The plan's name is the row's identity;
// the member column is secondary on a phone and is read
// in the expanded card, like the three dates.
const LIST_COLUMNS: ListColumn[] = [
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 20, mobile: 'keep' },
  { key: 'name', labelKey: 'col_name', sortKey: 'name', width: 180, grow: 2, mobile: 'name' },
  { key: 'member', labelKey: 'col_member', sortKey: 'member', width: 160, mobile: 'secondary' },
  // #3403: the Assigned Nutrition Plans list's own columns, in its order.
  { key: 'days', labelKey: 'col_days', width: 80, mobile: 'secondary' },
  { key: 'start_date', labelKey: 'col_start_date', sortKey: 'start_date', width: 120, mobile: 'secondary' },
  { key: 'end_date', labelKey: 'col_end_date', sortKey: 'end_date', width: 120, mobile: 'secondary' },
  // Wide enough for the longest translated title plus its sort arrow.
  { key: 'created_at', labelKey: 'col_created_at', sortKey: 'created_at', width: 120, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', sortKey: 'created_by', width: 140, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', sortKey: 'status', width: 100, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 10;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + LIST_PADDING_X * 2;

/* ---- Page ---- */

export default function TrainingPlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const openPlanId = searchParams.get('open');
  const autoExpandRef = useRef<number | null>(null);

  const [rows, setRows] = useState<TrainingPlanRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState(searchParams.get('member_id') ?? '');
  const [templateFilter, setTemplateFilter] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState('');
  const [createdByOptions, setCreatedByOptions] = useState<CreatedByOption[]>([]);
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<TrainingPlanRow | null>(null);
  const [detailsPlan, setDetailsPlan] = useState<TrainingPlanRow | null>(null);
  const [completingPlan, setCompletingPlan] = useState<TrainingPlanRow | null>(null);
  const [completeEndDate, setCompleteEndDate] = useState('');
  const [completeSaving, setCompleteSaving] = useState(false);

  // Expand/hierarchy state
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, TrainingPlanRow>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', status: 'active', start_date: '', end_date: '' });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  // #3477: the one Activate confirmation, from ⋮ → Activate or from Save & Activate (#3547) on a
  // Draft; `fromSave` saves the editor's changes before activating.
  const [activation, setActivation] = useState<{ row: TrainingPlanRow; currentPlanName: string | null; fromSave: boolean; versionDraft: boolean } | null>(null);
  const [activationBusy, setActivationBusy] = useState(false);
  // #3547: the Draft copy this Edit session created (not resumed) — the one Cancel discards.
  const [createdDraftId, setCreatedDraftId] = useState<number | null>(null);
  // #3477: a Draft saved with Save Draft in this Edit session holds the user's work, so a later
  // Cancel must not discard it.
  const [savedDraftId, setSavedDraftId] = useState<number | null>(null);

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('TRAINING');
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
      if (memberFilter) params.set('member_id', memberFilter);
      if (templateFilter) params.set('template_id', templateFilter);
      if (createdByFilter) params.set('created_by', createdByFilter);
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const res = await apiFetch<ListResponse>(`/training-plans?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, memberFilter, templateFilter, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, memberFilter, templateFilter, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/training-plans/created-by-options').then(setCreatedByOptions).catch(() => {});
    apiFetch<MemberOption[]>('/members').then(setMemberOptions).catch(() => {});
    apiFetch<{ items: TemplateOption[] }>('/training-plan-templates?limit=100')
      .then((r) => setTemplateOptions(r.items)).catch(() => {});
  }, [activeGymId, gymLoading]);

  useEffect(() => {
    if (!openPlanId || loading || rows.length === 0) return;
    const id = parseInt(openPlanId, 10);
    if (isNaN(id) || autoExpandRef.current === id) return;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    autoExpandRef.current = id;
    if (row.status !== 'completed') {
      beginEdit(row);
    } else if (!expanded.has(row.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(row.id); return next; });
      loadHierarchy(row.id);
    }
    setTimeout(() => {
      document.querySelector(`[data-plan-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, openPlanId, loading]);

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const plan = await apiFetch<TrainingPlanRow>(`/training-plans/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: plan }));
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchHierarchy = useCallback(async (id: number) => {
    try {
      const plan = await apiFetch<TrainingPlanRow>(`/training-plans/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: plan }));
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: TrainingPlanRow) {
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

  function startEdit(row: TrainingPlanRow) {
    setEditingId(row.id);
    setEditForm({
      name: row.name,
      description: row.description ?? '',
      status: row.status, // #3477: read-only in the form; changed only through ⋮ actions
      start_date: (row.start_date ?? '').slice(0, 10),
      end_date: row.end_date ? row.end_date.slice(0, 10) : '',
    });
    setEditError(null);
    if (!expanded.has(row.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(row.id); return next; });
      loadHierarchy(row.id);
    }
  }

  // #1969: Edit on an active plan works on a Draft copy; the original is untouched until Save.
  // #3409: a plan that started today comes back as itself (no draft_of_plan_id), so it is edited
  // in place: Save is the ordinary PUT with no confirmation and Cancel deletes nothing.
  // #3547: Edit on a Completed plan creates (or resumes) a Draft copy the same way; the Completed
  // plan is never edited itself.
  async function beginEdit(row: TrainingPlanRow) {
    if (row.status !== 'active' && row.status !== 'completed') { startEdit(row); return; }
    try {
      const resumed = rows.some((r) => r.draft_of_plan_id === row.id && r.status === 'draft');
      const draft = await apiFetch<TrainingPlanRow>(`/members/${row.member_id}/training-plans/${row.id}/edit-draft`, { method: 'POST' });
      setCreatedDraftId(draft.id !== row.id && !resumed ? draft.id : null);
      await load();
      startEdit({ ...draft, member_name: row.member_name, template_name: row.template_name });
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  function cancelEdit() {
    // #1969: Cancel on a version draft discards it; the original stays as it was.
    // #3547: a Draft copy of a Completed plan is discarded only when this Edit created it — a
    // resumed one holds changes saved earlier with Save Draft.
    const draftRow = rows.find((r) => r.id === editingId);
    const source = draftRow?.draft_of_plan_id ? rows.find((r) => r.id === draftRow.draft_of_plan_id) : undefined;
    const discard = !!draftRow?.draft_of_plan_id
      && draftRow.id !== savedDraftId
      && (draftRow.id === createdDraftId || source?.status === 'active');
    setCreatedDraftId(null);
    setSavedDraftId(null);
    if (discard && draftRow) {
      apiFetch(`/members/${draftRow.member_id}/training-plans/${draftRow.id}`, { method: 'DELETE' })
        .then(() => { load(); })
        .catch((err: any) => toast(err.message ?? t('training_plans.error_generic')));
    }
    setEditingId(null);
    setEditForm({ name: '', description: '', status: 'active', start_date: '', end_date: '' });
    setEditError(null);
  }

  // #3477: what Activate would complete, for the confirmation's wording.
  async function openActivation(row: TrainingPlanRow, fromSave: boolean) {
    try {
      const preview = await apiFetch<{ current_plan: { id: number; name: string } | null; version_draft?: boolean }>(
        `/members/${row.member_id}/training-plans/${row.id}/activation`);
      // #3547: a Draft copy of a Completed plan is not a new version of the active plan — it
      // replaces it as a plain Draft does; the API says which.
      const versionDraft = preview.version_draft ?? !!row.draft_of_plan_id;
      setActivation({ row, currentPlanName: preview.current_plan?.name ?? null, fromSave, versionDraft });
    } catch (err: any) {
      if (fromSave) setEditError(err.message ?? t('training_plans.error_generic'));
      else toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  async function putEdit(row: TrainingPlanRow) {
    // #3477: the status is never sent — it changes only through Activate / Complete.
    // A version draft (#1969) keeps the plan's dates, so only name and description go.
    await apiFetch(`/members/${row.member_id}/training-plans/${row.id}`, {
      method: 'PUT',
      body: JSON.stringify(row.draft_of_plan_id
        ? { name: editForm.name.trim(), description: editForm.description.trim() || null }
        : {
            name: editForm.name.trim(),
            description: editForm.description.trim() || null,
            start_date: editForm.start_date || null,
            end_date: editForm.end_date || null,
          }),
    });
  }

  // Save on an Active plan: the changes are persisted and the plan keeps its status.
  // #3477: Save on a Draft asks first — Cancel, Save Draft or Save and Activate — in one dialog
  // that also says what activating would complete.
  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('training_plans.error_required')); return; }
    const row = rows.find((r) => r.id === editingId)!;
    if (row.status === 'draft') { setEditError(null); await openActivation(row, true); return; }
    setEditSaving(true); setEditError(null);
    try {
      await putEdit(row);
      setEditingId(null);
      setCreatedDraftId(null);
      load();
      refetchHierarchy(editingId!);
    } catch (err: any) {
      setEditError(err.message ?? t('training_plans.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // #3477: Save Draft from the Save dialog — the changes are persisted, the plan stays a Draft
  // and the editor stays open so the user can keep working on it. Nothing is activated.
  async function saveDraftFromDialog() {
    if (!activation) return;
    const { row } = activation;
    setActivationBusy(true);
    try {
      await putEdit(row);
      setActivation(null);
      setSavedDraftId(row.id);
      toast(t('training_plans.draft_saved'), 'success');
      load();
      refetchHierarchy(row.id);
    } catch (err: any) {
      setActivation(null);
      setEditError(err.message ?? t('training_plans.error_generic'));
    } finally {
      setActivationBusy(false);
    }
  }

  // #3477: Activate — from Save, the changes are saved first; then the one activation route.
  async function confirmActivation() {
    if (!activation) return;
    const { row, fromSave } = activation;
    setActivationBusy(true);
    try {
      if (fromSave) await putEdit(row);
      await apiFetch(`/members/${row.member_id}/training-plans/${row.id}/activate`, { method: 'POST' });
      setActivation(null);
      if (fromSave || editingId === row.id) { setEditingId(null); setEditError(null); setCreatedDraftId(null); setSavedDraftId(null); }
      load();
      refetchHierarchy(row.id);
    } catch (err: any) {
      setActivation(null);
      if (fromSave) setEditError(err.message ?? t('training_plans.error_generic'));
      else toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setActivationBusy(false);
    }
  }

  async function handleDuplicate(row: TrainingPlanRow) {
    try {
      await apiFetch(`/members/${row.member_id}/training-plans/${row.id}/duplicate`, { method: 'POST' });
      toast(t('training_plan_templates.duplicated'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  async function handleComplete() {
    if (!completingPlan) return;
    setCompleteSaving(true);
    try {
      await apiFetch(`/members/${completingPlan.member_id}/training-plans/${completingPlan.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ end_date: completeEndDate || null }),
      });
      setCompletingPlan(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setCompleteSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/members/${deleting.member_id}/training-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) {
      setDeleting(null); toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'created_at' || key === 'modified_at' || key === 'start_date' || key === 'end_date' ? 'desc' : 'asc'); }
  }

  if (gymLoading || !canRead) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortBtn = (key: SortKey, label: string) => (
    <button onClick={() => toggleSort(key)} style={sortBtnStyle(sortKey === key)}>
      {label}{sortArrow(key)}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('training_plans.title')}</h1>
        <button onClick={() => guardUnsaved(() => setNewOpen(true))} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)}>{t('training_plans.new_plan')}</button>
      </div>

      {/* Filters — the same labelled bar Assigned Plans uses (#724). Same five
          filters as before, same behaviour; each one now carries its label. */}
      <FilterBar>
        <FilterField label={t('training_plans.filter_label_name')} htmlFor="tp-filter-name">
          <input
            id="tp-filter-name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('training_plans.filter_name')}
            style={{ ...filterControlStyle, minWidth: 180 }}
          />
        </FilterField>
        <FilterField label={t('training_plans.filter_label_member')} htmlFor="tp-filter-member">
          <select id="tp-filter-member" value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('training_plans.filter_member_all')}</option>
            {memberOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('training_plans.filter_label_source')} htmlFor="tp-filter-source">
          <select id="tp-filter-source" value={templateFilter} onChange={(e) => setTemplateFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('training_plans.filter_template_all')}</option>
            <option value="custom">{t('training_plans.custom')}</option>
            {templateOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('training_plans.filter_label_author')} htmlFor="tp-filter-author">
          <select id="tp-filter-author" value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('training_plans.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('training_plans.filter_label_status')} htmlFor="tp-filter-status">
          <StatusFilter id="tp-filter-status" value={statusFilter} onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))} allLabel={t('status.all')}
            style={filterControlStyle} />
        </FilterField>
      </FilterBar>

      {loading ? (
        <p style={{ color: '#888' }}>{t('training_plans.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('training_plans.empty')}</p>
      ) : (
        /* The header band and the rows are one list surface (#724): they share
           LIST_GRID_COLUMNS and scroll together, so they cannot fall out of
           line, and a narrow viewport scrolls the list instead of the page. */
        <div style={listSurfaceStyle}>
          <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
            <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
              <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
                {LIST_COLUMNS.map((col) => (
                  <div key={col.key} className={CELL_CLASS[col.key]} style={cellStyle}>
                    {col.labelKey && col.sortKey
                      ? sortBtn(col.sortKey, t(`training_plans.${col.labelKey}`))
                      : null}
                  </div>
                ))}
              </div>

              {rows.map((row) => (
                <PlanCard
                  key={row.id}
                  row={row}
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
                  onToggleExpand={() => guardUnsaved(() => toggleExpand(row))}
                  onEdit={() => guardUnsaved(() => beginEdit(row))}
                  onDetails={() => guardUnsaved(() => setDetailsPlan(row))}
                  onDuplicate={() => guardUnsaved(() => handleDuplicate(row))}
                  onActivate={() => guardUnsaved(() => openActivation(row, false))}
                  onComplete={() => guardUnsaved(() => { setCompletingPlan(row); setCompleteEndDate(new Date().toISOString().slice(0, 10)); })}
                  onDelete={() => guardUnsaved(() => setDeleting(row))}
                  onEditFormChange={setEditForm}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                  apiFetch={apiFetch}
                  toast={toast}
                  onChanged={() => refetchHierarchy(row.id)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{pageStart}–{pageEnd} / {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      <NewTrainingPlanDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); load(); }}
      />

      <ConfirmDialog open={deleting !== null} message={t('training_plans.confirm_delete')}
        confirmLabel={t('training_plans.delete')} cancelLabel={t('training_plans.cancel')}
        onConfirm={handleDelete} onCancel={() => setDeleting(null)} />

      <ConfirmDialog
        open={activation !== null}
        title={activation?.fromSave ? t('training_plans.save_draft_title') : t('training_plans.activate_title')}
        message={activation?.versionDraft
          ? t('training_plans.version_confirm')
          : activation?.currentPlanName
            ? t('training_plans.activate_confirm_replace', { name: displayTrainingPlanName(activation.currentPlanName) })
            : t('training_plans.activate_confirm')}
        question={activation?.fromSave ? t('training_plans.save_draft_question') : undefined}
        confirmLabel={activation?.fromSave ? t('training_plans.save_and_activate') : t('training_plans.activate')}
        cancelLabel={t('training_plans.cancel')}
        secondaryLabel={activation?.fromSave ? t('training_plans.save_draft') : undefined}
        onSecondary={activation?.fromSave ? saveDraftFromDialog : undefined}
        onConfirm={confirmActivation}
        onCancel={() => setActivation(null)}
        busy={activationBusy}
        tone="primary"
      />

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('training_plans.unsaved_changes')}
        confirmLabel={t('training_plans.unsaved_discard')}
        cancelLabel={t('training_plans.cancel')}
        onConfirm={() => { const a = pendingAction!; setPendingAction(null); cancelEdit(); a(); }}
        onCancel={() => setPendingAction(null)}
      />

      {/* Complete dialog */}
      {completingPlan && (
        <CrudModal
          open
          title={t('training_plans.complete_dialog_title')}
          error={null}
          saving={completeSaving}
          cancelLabel={t('training_plans.cancel')}
          saveLabel={completeSaving ? t('training_plans.saving') : t('training_plans.complete_confirm_btn')}
          onCancel={() => setCompletingPlan(null)}
          onSave={handleComplete}
        >
          <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: '#555' }}>
            {t('training_plans.confirm_complete')}
          </p>
          <FormLabel>{t('training_plans.complete_end_date_label')}</FormLabel>
          <input
            type="date"
            value={completeEndDate}
            onChange={(e) => setCompleteEndDate(e.target.value)}
            style={modalInputStyle}
          />
        </CrudModal>
      )}

      {/* Details dialog */}
      {detailsPlan && (
        <DetailsDialog plan={detailsPlan} locale={locale} t={t} onClose={() => setDetailsPlan(null)} />
      )}
    </div>
  );
}

/* ---- PlanCard ---- */

type EditForm = { name: string; description: string; status: string; start_date: string; end_date: string };

function PlanCard({
  row, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t,
  onToggleExpand, onEdit, onDetails, onDuplicate, onActivate, onComplete, onDelete,
  onEditFormChange, onSave, onCancel,
  apiFetch, toast, onChanged,
}: {
  row: TrainingPlanRow;
  expanded: boolean;
  editing: boolean;
  editForm: EditForm;
  editError: string | null;
  editSaving: boolean;
  hierarchy: TrainingPlanRow | null;
  hierLoading: boolean;
  canWrite: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDetails: () => void;
  onDuplicate: () => void;
  onActivate: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  apiFetch: ReturnType<typeof useApiClient>['apiFetch'];
  toast: (msg: string) => void;
  onChanged: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  const dates = assignedPlanDateTexts(row, gymFmt, t('training_plans.open_ended'));
  const isCompleted = row.status === 'completed';

  const roTitle = useReadOnlyTitle(canWrite);
  const menuItems = [
    // #3547: Edit on a Completed plan opens a Draft copy; the Completed plan stays read-only.
    { kind: 'edit' as const, label: t('training_plan_templates.edit'), onClick: onEdit, disabled: !canWrite, title: roTitle },
    { kind: 'details' as const, label: t('training_plans.details'), onClick: onDetails },
    { label: t('training_plans.duplicate'), onClick: onDuplicate, disabled: !canWrite, title: roTitle },
    ...(row.status === 'draft' ? [{ label: t('training_plans.activate'), onClick: onActivate, disabled: !canWrite, title: roTitle }] : []),
    ...(row.status === 'active' ? [{ label: t('training_plans.complete'), onClick: onComplete, disabled: !canWrite, title: roTitle }] : []),
    { kind: 'delete' as const, label: t('training_plans.delete'), onClick: onDelete, danger: true, disabled: !canWrite, title: roTitle },
  ];

  return (
    <div data-plan-id={row.id} style={rowContainerStyle(editing)}>
      {/* Editing mode header */}
      {editing ? (
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={formFieldLabelStyle}>{t('training_plans.label_name')} *</label>
              <input value={editForm.name} onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus style={formControlStyle} />
              {editError && <p style={formFieldErrorStyle}>{editError}</p>}
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={formFieldLabelStyle}>{t('training_plans.label_description')}</label>
              <textarea value={editForm.description} onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2} style={{ ...formControlStyle, resize: 'vertical' }} />
            </div>
            {/* #3477: the status is shown, never edited — it changes through ⋮ → Activate / Complete. */}
            <div>
              <span style={formFieldLabelStyle}>{t('training_plans.label_status')}</span>
              <div style={{ padding: '8px 0' }}><StatusBadge status={row.status} label={t(`status.${row.status}`)} /></div>
            </div>
            {!row.draft_of_plan_id && (<>
            <div>
              <label style={formFieldLabelStyle}>{t('training_plans.label_start_date')}</label>
              <input type="date" value={editForm.start_date} onChange={(e) => onEditFormChange({ ...editForm, start_date: e.target.value })}
                style={formControlStyle} />
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('training_plans.label_end_date')}</label>
              <input type="date" value={editForm.end_date} onChange={(e) => onEditFormChange({ ...editForm, end_date: e.target.value })}
                style={formControlStyle} />
            </div>
            </>)}
          </div>
        </div>
      ) : (
        /* Normal row — one cell per LIST_COLUMNS entry, same order */
        <div onClick={onToggleExpand} className={LIST_GRID_ROW_CLASS} style={headerRowStyle} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}>
          <span className={CELL_CLASS.expand} style={{ ...cellStyle, fontSize: 12, color: '#aaa', userSelect: 'none' }}>{expanded ? '▼' : '▶'}</span>
          <div className={CELL_CLASS.name} style={cellStyle} title={displayTrainingPlanName(row.name)}>
            <div style={nameCellStyle}>{displayTrainingPlanName(row.name)}</div>
            {row.description && <div style={subCellStyle}>{row.description}</div>}
          </div>
          <div className={CELL_CLASS.member} style={cellStyle} title={row.member_name}>
            <div style={nameCellStyle}>{row.member_name || '—'}</div>
          </div>
          <div className={CELL_CLASS.days} style={{ ...cellStyle, ...dateCellStyle }}>
            {row.day_count != null ? t('training_plans.day_count', { count: Number(row.day_count) }) : '—'}
          </div>
          <div className={CELL_CLASS.start_date} style={{ ...cellStyle, ...dateCellStyle }}>{dates.start}</div>
          <div className={CELL_CLASS.end_date} style={{ ...cellStyle, ...dateCellStyle }}>{dates.end}</div>
          <div className={CELL_CLASS.created_at} style={{ ...cellStyle, ...dateCellStyle }}>{formatDate(row.created_at, gymFmt)}</div>
          <div className={CELL_CLASS.created_by} style={cellStyle} title={row.created_by ?? undefined}>
            <div style={nameCellStyle}>{row.created_by ?? '—'}</div>
          </div>
          <div className={CELL_CLASS.status} style={badgeCellStyle}>
            <StatusBadge status={row.status} label={t(`status.${row.status}`)} />
          </div>
          <div className={CELL_CLASS.actions} style={actionsCellStyle} onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('training_plans.col_actions')} items={menuItems} />
          </div>
        </div>
      )}

      {/* Expanded content — recessed, like an expanded DataTable row */}
      {expanded && (
        <div style={listExpandedStyle}>
          <AssignedPlanDateFields
            startLabel={t('training_plans.label_start_date')}
            endLabel={t('training_plans.label_end_date')}
            start={dates.start}
            end={dates.end}
          />
          {isCompleted && (
            <div style={{ padding: '8px 20px', fontSize: 13, color: '#888' }}>
              {t('training_plans.completed_read_only')}
            </div>
          )}
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px', margin: 0 }}>
              {t('training_plans.loading')}
            </p>
          ) : (
            <PlanWorkoutTree
              plan={hierarchy}
              /* #971 §4/§5: expanding reads, `⋮ → Edit` writes. The tree's own
                 controls belong to Edit mode, exactly as a section-level editor
                 does elsewhere in the app — so a reader sees the whole
                 structure and none of the affordances that change it. */
              canWrite={canWrite && editing && !isCompleted}
              apiFetch={apiFetch}
              toast={toast}
              onChanged={onChanged}
            />
          )}
        </div>
      )}

      {/* Save/cancel footer (edit mode only) */}
      {editing && (
        <div style={{ ...formActionsRowStyle, padding: '14px 16px', marginTop: 12 }}>
          <button onClick={onCancel} style={secondaryBtnStyle}>{t('training_plans.cancel')}</button>
          {/* #3477: one Save; on a Draft it opens the Cancel / Save Draft / Save and Activate
              dialog, on an Active plan it saves. */}
          <button onClick={onSave} disabled={editSaving} style={primaryBtnStyle()}>
            {editSaving ? t('training_plans.saving') : t('training_plans.save_changes')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- DetailsDialog ---- */

function DetailsDialog({ plan, locale, t, onClose }: {
  plan: TrainingPlanRow;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  return (
    <CrudModal
      open
      title={t('training_plans.details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('training_plans.cancel')}
      saveLabel=""
      extraFooter={<ViewAuditLogButton entityType="training_plan" entityId={plan.id} onNavigate={onClose} />}
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('training_plans.label_name')} value={displayTrainingPlanName(plan.name)} />
        <DetailRow label={t('training_plans.label_description')} value={plan.description ?? '—'} />
        <DetailRow label={t('training_plans.label_member')} value={plan.member_name} />
        <DetailRow label={t('training_plans.label_source')} value={plan.template_name ?? t('training_plans.custom')} />
        <DetailRow label={t('training_plans.col_status')} value={<StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('training_plans.label_start_date')} value={formatDay(plan.start_date, gymFmt)} />
        <DetailRow label={t('training_plans.label_end_date')} value={plan.end_date ? formatDay(plan.end_date, gymFmt) : t('training_plans.open_ended')} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('training_plans.label_created_by')} value={plan.created_by ?? '—'} />
        <DetailRow label={t('training_plans.label_created_at')} value={formatDate(plan.created_at, gymFmt)} />
        {plan.modified_at && (
          <>
            <DetailRow label={t('training_plans.label_modified_by')} value={plan.modified_by ?? '—'} />
            <DetailRow label={t('training_plans.label_modified_at')} value={formatDate(plan.modified_at, gymFmt)} />
          </>
        )}
      </div>
    </CrudModal>
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

/* ---- Helpers & Styles ---- */

// #1246: the gym's own date format. `start_date`/`end_date` are calendar dates
// (never moved across a time zone); `created_at`/`modified_at` are instants.
function formatDay(value: string, settings: GymFormatSettings): string {
  return formatGymDateOnly(value, settings);
}

function formatDate(value: string, settings: GymFormatSettings): string {
  return formatGymDate(value, settings);
}

const modalInputStyle: React.CSSProperties = { ...formControlStyle, padding: '10px 12px', fontSize: 15 };
/**
 * A column title: the header band's own type, accented while it sorts.
 *
 * #971: that accent is the Theme's link colour rather than a lilac literal — a
 * sorted title is a text link, and `--gd-link` is the token a text link reads
 * (`formChrome`'s `cardTextLinkStyle`). The literal stays as the `var()`
 * fallback for the frames before `applyTokens()` has run.
 */
const sortBtnStyle = (active: boolean): React.CSSProperties => ({
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
  fontFamily: 'inherit', fontSize: 15, fontWeight: 600,
  color: active ? 'var(--gd-link, #4b45c6)' : 'inherit',
});
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});

// The grid the column headers and every plan row share (#724).
const listGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  gap: LIST_COLUMN_GAP,
};
const colHeaderStyle: React.CSSProperties = {
  ...listGridStyle, ...listHeaderRowStyle, ...listHeaderCellStyle,
};
/** A plan's own band inside the list surface, divided from the one above it. */
const rowContainerStyle = (editing: boolean): React.CSSProperties => ({
  ...listRowDividerStyle,
  // Being edited used to widen the card's border, which would now shift every
  // column by 1.5px; an inset accent leaves the grid where it is. #971: that
  // accent follows the Theme (`--brand`, as the Nutrition Library's own tab
  // underline does) instead of being a lilac no Theme setting reaches.
  ...(editing ? { boxShadow: 'inset 3px 0 0 var(--brand, #4b45c6)' } : {}),
});
const headerRowStyle: React.CSSProperties = {
  ...listGridStyle, ...listCellStyle, cursor: 'pointer', userSelect: 'none',
};
/** Keeps an over-long value inside its track instead of widening the row. */
const cellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
/** Badges size themselves, so this cell only needs to not stretch them. */
const badgeCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center',
};
const actionsCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
};
const nameCellStyle: React.CSSProperties = {
  ...cellStyle, fontWeight: 600, fontSize: 15,
};
/** The secondary line under a value (member + description, the end date). */
const subCellStyle: React.CSSProperties = {
  ...cellStyle, fontSize: 12, color: '#6b7280',
};
const dateCellStyle: React.CSSProperties = {
  fontSize: 13, color: '#666', whiteSpace: 'nowrap',
};
