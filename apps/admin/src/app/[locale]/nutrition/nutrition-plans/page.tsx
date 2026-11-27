'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formActionsRowStyle } from '@/components/formChrome';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { useModuleAccess, useReadOnlyTitle } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { AssignedPlanDateFields } from '@/components/AssignedPlanDateFields';
import { assignedPlanDateTexts } from '@/lib/assignedPlanDates';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { StatusFilter } from '@/components/StatusFilter';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listHeaderCellStyle, listHeaderRowStyle, listScrollerClass,
} from '@/components/listChrome';
import { NutritionPlanTree, Hierarchy } from '../nutrition-plan-templates/NutritionPlanTree';
import { NewNutritionPlanDialog } from '../NewNutritionPlanDialog';
import { displayNutritionPlanName } from '@/lib/nutritionPlanName';

interface MemberNutritionPlan {
  id: number;
  name: string;
  description: string | null;
  /** #3474: the note written for the member, a copy of the template's when assigned from one. */
  member_notes?: string | null;
  member_id: number;
  member_name: string;
  template_id: number | null;
  status: 'active' | 'completed' | 'deleted' | 'draft';
  draft_of_plan_id?: number | null;
  /** #3405: the API's answer — `versioned` edits a Draft copy, `in_place` the plan itself. */
  edit_mode?: 'in_place' | 'versioned' | 'read_only';
  start_date: string | null;
  end_date: string | null;
  day_count: number;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
}

/** The statuses the list may be filtered by (#2661) — the API's listable set. */
const FILTER_STATUSES = ['active', 'draft', 'completed'] as const;

interface EditForm { name: string; description: string; member_notes: string; start_date: string }
const emptyEditForm: EditForm = { name: '', description: '', member_notes: '', start_date: '' };

/** #3474: the activation confirmation — which Draft, the API's current active plan, and whether Save opened it. */
interface ActivationPrompt {
  plan: MemberNutritionPlan;
  currentPlanName: string | null;
  fromSave: boolean;
}

function formatDate(iso: string, settings: GymFormatSettings) {
  return formatGymDate(iso, settings);
}

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 4 — the row is laid out from one declaration rather than from
 * per-cell `flex`/`maxWidth` guesses (#637's shape, which stage 3's eight card
 * lists already adopted). This list carries no header band, so there is nothing
 * for the tracks to fall out of line *with* — adding one would be a desktop
 * change §4 rules out — but the row still needs each cell to say what it is on
 * a phone.
 *
 * The plan's name is the row's identity, and the **Member** rides beside it
 * because this list is member-related, which is `Q1`'s own exception ("Member
 * name, where the list is member-related"). The day count, the author and the
 * date are read in the expanded tree.
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `nutrition_plans` namespace. Absent = no title. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'member', labelKey: 'col_member', width: 120, grow: 1, mobile: 'keep' },
  { key: 'days', labelKey: 'col_days', width: 80, mobile: 'secondary' },
  { key: 'start_date', labelKey: 'col_start_date', width: 110, mobile: 'secondary' },
  { key: 'end_date', labelKey: 'col_end_date', width: 110, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 100, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 140, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 90, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
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

export default function NutritionPlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<MemberNutritionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  // #2661: Member is a free-text, partial name match (debounced, applied by the
  // API), Status the list's closed set. A deep link from the Member card
  // (`?member_id=`) scopes the list to that member until the Member box is edited.
  const [memberIdScope, setMemberIdScope] = useState(searchParams.get('member_id') ?? '');
  const [memberInput, setMemberInput] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deleting, setDeleting] = useState<MemberNutritionPlan | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // #3474: Save on a Draft and ⋮ → Activate both ask before the member's active plan is completed.
  const [activation, setActivation] = useState<ActivationPrompt | null>(null);
  const [activating, setActivating] = useState(false);

  // Unsaved-changes guard
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Details dialog
  const [detailsPlan, setDetailsPlan] = useState<MemberNutritionPlan | null>(null);

  // Complete confirm
  const [completing, setCompleting] = useState<MemberNutritionPlan | null>(null);

  // Row expansion + lazy hierarchy cache
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('NUTRITION');
  useEffect(() => { if (!gymLoading && !canRead) router.replace(`/${locale}`); }, [gymLoading, canRead]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (memberIdScope) params.set('member_id', memberIdScope);
      if (memberQuery) params.set('member', memberQuery);
      if (statusFilter) params.set('status', statusFilter);
      const data = await apiFetch<MemberNutritionPlan[]>(`/member-nutrition-plans?${params.toString()}`);
      setRows(data);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, memberIdScope, memberQuery, statusFilter]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  useEffect(() => {
    const id = setTimeout(() => setMemberQuery(memberInput.trim()), 300);
    return () => clearTimeout(id);
  }, [memberInput]);

  // A deep-linked member is named in the Member box, so the scope is visible.
  useEffect(() => {
    if (!activeGymId || gymLoading || !memberIdScope) return;
    apiFetch<{ name: string }>(`/members/${memberIdScope}`)
      .then((m) => setMemberInput((prev) => prev || m.name))
      .catch(() => {});
  }, [activeGymId, gymLoading]);

  function changeMemberInput(value: string) {
    setMemberIdScope('');
    setMemberInput(value);
  }

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  function startEdit(plan: MemberNutritionPlan) {
    setEditingId(plan.id);
    setEditForm({
      name: plan.name, description: plan.description ?? '', member_notes: plan.member_notes ?? '',
      start_date: plan.start_date?.slice(0, 10) ?? '',
    });
    setEditError(null);
    if (!expanded.has(plan.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(plan.id); return next; });
      loadHierarchy(plan.id);
    }
  }

  // #1970/#3405: Edit on an active plan effective before today works on a Draft copy (created or
  // resumed); the original is untouched until Save Changes is confirmed. A Draft, or an active plan
  // that started today or later, is edited in place.
  async function beginEdit(plan: MemberNutritionPlan) {
    if (plan.edit_mode !== 'versioned') { startEdit(plan); return; }
    try {
      const draft = await apiFetch<MemberNutritionPlan>(`/member-nutrition-plans/${plan.id}/edit-draft`, { method: 'POST' });
      await load();
      startEdit({ ...draft, member_name: plan.member_name });
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  // #2175: ?open=<id> (from Members → Nutrition Plan → Edit) expands that plan and opens it in Edit mode, once.
  const openHandled = useRef(false);
  useEffect(() => {
    const openId = Number(searchParams.get('open'));
    if (openHandled.current || !openId || loading || !canWrite) return;
    const target = rows.find((r) => r.id === openId);
    if (!target) return;
    openHandled.current = true;
    beginEdit(target);
  }, [rows, loading, canWrite]);

  // #3484: Convert to Template writes a working copy and opens it in the templates' inline
  // editor; Save there creates the template, Cancel discards the copy. The plan is untouched.
  async function convertToTemplate(row: MemberNutritionPlan) {
    try {
      const tpl = await apiFetch<{ id: number }>(`/member-nutrition-plans/${row.id}/convert-to-template`, { method: 'POST' });
      router.push(`/${locale}/nutrition/nutrition-plan-templates?convert=${tpl.id}`);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  function cancelEdit() {
    // #3405: Cancel leaves a version Draft as it is, so the next Edit resumes it (it may stay a
    // Draft for days); ⋮ → Delete on the Draft discards it. The active plan is never touched.
    setEditingId(null);
    setEditForm(emptyEditForm);
    setEditError(null);
  }

  /** The PUT body of the inline form. A version Draft's start date is set by its activation, so it is not sent. */
  function editBody(row: MemberNutritionPlan) {
    return {
      name: editForm.name.trim(),
      description: editForm.description.trim() || null,
      member_notes: editForm.member_notes.trim() || null,
      // #3403: a plan always keeps a start date — a blank field leaves the stored one.
      ...(editForm.start_date && !row.draft_of_plan_id ? { start_date: editForm.start_date } : {}),
    };
  }

  /** #3474: asks the API which active plan activating this Draft would complete, then opens the confirmation. */
  async function promptActivation(plan: MemberNutritionPlan, fromSave: boolean) {
    try {
      const info = await apiFetch<{ current_plan: { id: number; name: string } | null }>(`/member-nutrition-plans/${plan.id}/activation`);
      setActivation({ plan, currentPlanName: info.current_plan ? displayNutritionPlanName(info.current_plan.name) : null, fromSave });
    } catch (err: any) {
      if (fromSave) setEditError(err.message ?? t('nutrition_plans.error_generic'));
      else toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('nutrition_plans.error_required')); return; }
    const row = rows.find((r) => r.id === editingId)!;
    // #3474: Save on a Draft never activates it implicitly — it asks: Activate, or Keep as Draft.
    if (row.status === 'draft') { await promptActivation(row, true); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/member-nutrition-plans/${editingId}`, { method: 'PUT', body: JSON.stringify(editBody(row)) });
      setEditingId(null); setEditForm(emptyEditForm); load();
    } catch (err: any) {
      setEditError(err.message ?? t('nutrition_plans.error_generic'));
    } finally { setEditSaving(false); }
  }

  /** #3474: the answer to the confirmation. `activate` false is Keep as Draft (only offered from Save). */
  async function resolveActivation(activate: boolean) {
    if (!activation) return;
    const { plan, fromSave } = activation;
    setActivating(true);
    try {
      if (fromSave) {
        await apiFetch(`/member-nutrition-plans/${plan.id}`, { method: 'PUT', body: JSON.stringify(editBody(plan)) });
      }
      if (activate) await apiFetch(`/member-nutrition-plans/${plan.id}/activate`, { method: 'POST' });
      setActivation(null);
      if (fromSave) { setEditingId(null); setEditForm(emptyEditForm); }
      if (activate) toast(t('nutrition_plans.activated'), 'success');
      load();
    } catch (err: any) {
      setActivation(null);
      if (fromSave) setEditError(err.message ?? t('nutrition_plans.error_generic'));
      else toast(err.message ?? t('nutrition_plans.error_generic'));
    } finally { setActivating(false); }
  }

  async function complete() {
    if (!completing) return;
    try {
      await apiFetch(`/member-nutrition-plans/${completing.id}/complete`, { method: 'POST' });
      setCompleting(null);
      load();
    } catch (err: any) {
      setCompleting(null);
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  async function del() {
    if (!deleting) return;
    try {
      await apiFetch(`/member-nutrition-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<Hierarchy>(`/member-nutrition-plans/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<Hierarchy>(`/member-nutrition-plans/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: MemberNutritionPlan) {
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

  if (gymLoading || !canRead) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('nutrition_plans.title')}</h1>
        <button onClick={() => guardUnsaved(() => setNewOpen(true))} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle(), !canWrite)}>
          {t('nutrition_plans.new_plan')}
        </button>
      </div>

      {/* #2661: left-aligned filters above the list, the labelled bar every list wears (#724). */}
      <FilterBar>
        <FilterField label={t('nutrition_plans.filter_label_member')} htmlFor="np-filter-member">
          <input
            id="np-filter-member"
            type="search"
            value={memberInput}
            onChange={(e) => changeMemberInput(e.target.value)}
            placeholder={t('nutrition_plans.filter_member_placeholder')}
            style={{ ...filterControlStyle, minWidth: 200 }}
          />
        </FilterField>
        <FilterField label={t('nutrition_plans.filter_label_status')} htmlFor="np-filter-status">
          <StatusFilter
            id="np-filter-status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={FILTER_STATUSES.map((st) => ({ value: st, label: t(`status.${st}`) }))}
            allLabel={t('status.all')}
            style={filterControlStyle}
          />
        </FilterField>
      </FilterBar>

      {loading ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.empty')}</p>
      ) : (
        /* The cards share LIST_GRID_COLUMNS and scroll together, so a narrow
           viewport scrolls the list instead of the page (#1011). */
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
        <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
            {LIST_COLUMNS.map((col) => (
              <div key={col.key} className={CELL_CLASS[col.key]} style={colHeaderCellStyle}>
                {col.labelKey ? t(`nutrition_plans.${col.labelKey}`) : null}
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <PlanCard
              key={row.id}
              plan={row}
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
              onToggleExpand={() => toggleExpand(row)}
              onEdit={() => guardUnsaved(() => beginEdit(row))}
              onDetails={() => guardUnsaved(() => setDetailsPlan(row))}
              onActivate={() => guardUnsaved(() => promptActivation(row, false))}
              onComplete={() => guardUnsaved(() => setCompleting(row))}
              onDelete={() => guardUnsaved(() => setDeleting(row))}
              onConvertToTemplate={() => guardUnsaved(() => convertToTemplate(row))}
              onEditFormChange={setEditForm}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onChanged={() => refetchBranch(row.id)}
            />
          ))}
        </div>
        </div>
        </div>
      )}

      {/* Details dialog */}
      <DetailsDialog plan={detailsPlan} locale={locale} t={t} onClose={() => setDetailsPlan(null)} />

      {/* Complete confirm */}
      <ConfirmDialog
        open={completing !== null}
        message={t('nutrition_plans.confirm_complete')}
        confirmLabel={t('nutrition_plans.complete')}
        cancelLabel={t('nutrition_plans.cancel')}
        onConfirm={complete}
        onCancel={() => setCompleting(null)}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('nutrition_plans.confirm_delete')}
        confirmLabel={t('nutrition_plans.delete')}
        cancelLabel={t('nutrition_plans.cancel')}
        onConfirm={del}
        onCancel={() => setDeleting(null)}
      />

      {/* #3474: one confirmation for ⋮ → Activate and for Save on a Draft (which adds Keep as Draft). */}
      <ConfirmDialog
        open={activation !== null}
        title={t('nutrition_plans.activate_title')}
        message={activation?.currentPlanName
          ? t('nutrition_plans.activate_confirm_replace', { name: activation.currentPlanName })
          : t('nutrition_plans.activate_confirm_none')}
        confirmLabel={t('nutrition_plans.activate')}
        cancelLabel={t('nutrition_plans.cancel')}
        secondaryLabel={activation?.fromSave ? t('nutrition_plans.keep_as_draft') : undefined}
        onSecondary={activation?.fromSave ? () => resolveActivation(false) : undefined}
        onConfirm={() => resolveActivation(true)}
        onCancel={() => setActivation(null)}
        busy={activating}
      />

      {/* Unsaved changes guard */}
      <ConfirmDialog
        open={pendingAction !== null}
        message={t('nutrition_plans.unsaved_changes')}
        confirmLabel={t('nutrition_plans.unsaved_discard')}
        cancelLabel={t('nutrition_plans.cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />

      <NewNutritionPlanDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); load(); }}
      />
    </div>
  );
}

/* ---- PlanCard ---- */

function PlanCard({
  plan, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t,
  onToggleExpand, onEdit, onDetails, onActivate, onComplete, onDelete, onConvertToTemplate,
  onEditFormChange, onSave, onCancel, onChanged,
}: {
  plan: MemberNutritionPlan;
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
  onToggleExpand: () => void;
  onEdit: () => void;
  onDetails: () => void;
  onActivate: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onConvertToTemplate: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  const dates = assignedPlanDateTexts(plan, gymFmt, t('nutrition_plans.open_ended'));
  const isActive = plan.status === 'active';
  // #3405: the plan's structure is read-only until Edit is pressed, and an active snapshot
  // (`versioned`) is never edited itself — its Draft copy is.
  const canEditPlan = canWrite && editing && plan.edit_mode === 'in_place';
  const roTitle = useReadOnlyTitle(canWrite);
  const menuItems = [
    ...(isActive || plan.status === 'draft' ? [{ kind: 'edit' as const, label: t('nutrition_plans.edit'), onClick: onEdit, disabled: !canWrite, title: roTitle }] : []),
    { kind: 'details' as const, label: t('nutrition_plans.details'), onClick: onDetails },
    // #3474: an assigned plan is not duplicated from this list; a Draft is activated explicitly.
    ...(plan.status === 'draft' ? [{ label: t('nutrition_plans.activate'), onClick: onActivate, disabled: !canWrite, title: roTitle }] : []),
    ...(isActive ? [{ label: t('nutrition_plans.complete'), onClick: onComplete, disabled: !canWrite, title: roTitle }] : []),
    // #3484: offered in every status; the plan itself is only read.
    { label: t('nutrition_plans.convert_to_template'), onClick: onConvertToTemplate, disabled: !canWrite, title: roTitle },
    // #2201: a completed plan is read-only — no Edit, no Delete.
    ...(plan.status !== 'completed' ? [{ kind: 'delete' as const, label: t('nutrition_plans.delete'), onClick: onDelete, danger: true, disabled: !canWrite, title: roTitle }] : []),
  ];

  return (
    <div style={cardStyle(editing)}>
      {editing ? (
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plans.label_name')} *</label>
              <input
                value={editForm.name}
                onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus
                style={inlineInputStyle}
              />
              {editError && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{editError}</p>}
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plans.label_description')}</label>
              <textarea
                value={editForm.description}
                onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plans.label_member_notes')}</label>
              <textarea
                value={editForm.member_notes}
                onChange={(e) => onEditFormChange({ ...editForm, member_notes: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('nutrition_plans.label_start_date')}</label>
              <input
                type="date"
                value={editForm.start_date}
                onChange={(e) => onEditFormChange({ ...editForm, start_date: e.target.value })}
                required
                style={{ ...inlineInputStyle, width: 'auto' }}
              />
            </div>
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
          <span className={CELL_CLASS.expand} style={{ fontSize: 12, color: '#aaa', userSelect: 'none' }}>{expanded ? '▼' : '▶'}</span>
          <span className={CELL_CLASS.name} title={`${displayNutritionPlanName(plan.name)} · ${plan.member_name}`} style={nameCellStyle}>{displayNutritionPlanName(plan.name)}</span>
          {/* #810: the assigned member reads at the plan name's own size and weight. */}
          <span className={CELL_CLASS.member} title={plan.member_name} style={memberCellStyle}>{plan.member_name}</span>
          <span className={CELL_CLASS.days} style={metaCellStyle}>
            {t('nutrition_plans.day_count', { count: plan.day_count })}
          </span>
          <span className={CELL_CLASS.start_date} style={metaCellStyle}>{dates.start}</span>
          <span className={CELL_CLASS.end_date} style={metaCellStyle}>{dates.end}</span>
          <span className={CELL_CLASS.created_at} style={metaCellStyle}>
            {formatDate(plan.created_at, gymFmt)}
          </span>
          <span className={CELL_CLASS.created_by} style={{ ...metaCellStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {plan.created_by ?? '—'}
          </span>
          <span className={CELL_CLASS.status}>
            <StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />
          </span>
          <span className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('nutrition_plans.col_actions')} items={menuItems} />
          </span>
        </div>
      )}

      {expanded && (
        <>
          <div style={{ borderTop: '1px solid #ececf0' }} />
          <AssignedPlanDateFields
            startLabel={t('nutrition_plans.label_start_date')}
            endLabel={t('nutrition_plans.label_end_date')}
            start={dates.start}
            end={dates.end}
          />
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>
              {t('nutrition_plans.loading')}
            </p>
          ) : (
            <NutritionPlanTree
              templateId={plan.id}
              apiBase="/member-nutrition-plans"
              hierarchy={hierarchy}
              canWrite={canEditPlan}
              onChanged={onChanged}
            />
          )}
        </>
      )}

      {editing && (
        <div style={editorActionsRowStyle}>
          <button onClick={onCancel} style={cancelBtnStyle}>{t('nutrition_plans.cancel')}</button>
          <button onClick={onSave} disabled={editSaving} style={btnStyle()}>
            {editSaving ? t('nutrition_plans.saving') : t('nutrition_plans.save_changes')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- DetailsDialog ---- */

function DetailsDialog({
  plan, locale, t, onClose,
}: {
  plan: MemberNutritionPlan | null;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  const gymFmt = useGymFormatSettings();
  if (!plan) return null;
  return (
    <CrudModal
      open
      title={t('nutrition_plans.details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('nutrition_plans.cancel')}
      saveLabel=""
      extraFooter={<ViewAuditLogButton entityType="member_nutrition_plan" entityId={plan.id} onNavigate={onClose} />}
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('nutrition_plans.label_name')} value={displayNutritionPlanName(plan.name)} />
        <DetailRow label={t('nutrition_plans.label_description')} value={plan.description ?? '—'} />
        <DetailRow label={t('nutrition_plans.label_member_notes')} value={plan.member_notes ?? '—'} />
        <DetailRow label={t('nutrition_plans.label_member')} value={plan.member_name} />
        <DetailRow label={t('nutrition_plans.label_status')} value={<StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />} />
        <DetailRow label={t('nutrition_plans.label_start_date')} value={plan.start_date ? formatGymDateOnly(plan.start_date, gymFmt) : '—'} />
        <DetailRow label={t('nutrition_plans.label_end_date')} value={plan.end_date ? formatGymDateOnly(plan.end_date, gymFmt) : t('nutrition_plans.open_ended')} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('nutrition_plans.label_created_at')} value={formatDate(plan.created_at, gymFmt)} />
        <DetailRow label={t('nutrition_plans.label_created_by')} value={plan.created_by ?? '—'} />
        {plan.modified_at && (
          <>
            <DetailRow label={t('nutrition_plans.label_modified_at')} value={formatDate(plan.modified_at, gymFmt)} />
            <DetailRow label={t('nutrition_plans.label_modified_by')} value={plan.modified_by ?? '—'} />
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

const cardStyle = (editing: boolean): React.CSSProperties => ({
  ...cardSurfaceStyle,
  ...(editing ? { border: '1.5px solid #4b45c6' } : {}),
  overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `14px ${ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};
// #810: the plan name and the member it is assigned to share one typography
// declaration, so the two halves of the header title cannot drift apart.
const headerTitleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 15 };
const nameCellStyle: React.CSSProperties = {
  ...headerTitleStyle,
  minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const memberCellStyle: React.CSSProperties = {
  ...headerTitleStyle,
  minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
// The header band: the shared list header type on this list's own grid, inset
// like a row so each title sits over its column.
const colHeaderStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center',
  gap: LIST_COLUMN_GAP,
  ...listHeaderRowStyle, ...listHeaderCellStyle,
  padding: `12px ${ROW_PADDING_X}px`,
};
const colHeaderCellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
/** The end date under the start date, as in Assigned Training Plans. */
const metaCellStyle: React.CSSProperties = {
  fontSize: 13, color: '#888', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
// #3473: the editor's Cancel/Save pair is the app's card-level action row (Cancel, then Save,
// left-aligned), padded to the card's own inset.
const editorActionsRowStyle: React.CSSProperties = { ...formActionsRowStyle, alignItems: 'center', marginTop: 12, padding: '12px 16px 14px' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
