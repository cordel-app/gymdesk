'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess, useReadOnlyTitle } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { NutritionPlanTree, Hierarchy } from './NutritionPlanTree';
import { AssignNutritionPlanDialog, AssignedNutritionPlan } from '../AssignNutritionPlanDialog';

export interface NutritionPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  day_count: number;
  created_by_name: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface ListResponse {
  items: NutritionPlanTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { membership_id: number; name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive', 'draft'] as const;
const LIMIT = 20;
const emptyForm = { name: '', description: '', status: 'active' };

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
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'name', width: 160, grow: 2, mobile: 'name' },
  { key: 'description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'status', width: 90, mobile: 'keep' },
  { key: 'created_by', width: 120, mobile: 'secondary' },
  { key: 'created_at', width: 100, mobile: 'secondary' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 14;

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
    setEditingId(tpl.id);
    setEditForm({ name: tpl.name, description: tpl.description ?? '', status: tpl.status });
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
    if (!editForm.name.trim()) { setEditError(t('nutrition_plan_templates.error_required')); return; }
    setEditSaving(true); setEditError(null);
    const body = { name: editForm.name.trim(), description: editForm.description.trim() || null, status: editForm.status };
    try {
      await apiFetch(`/nutrition-plan-templates/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditingId(null); setEditForm(emptyForm); load();
    } catch (err: any) {
      setEditError(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setEditSaving(false); }
  }

  async function savePendingNew() {
    if (!pendingNewForm.name.trim()) { setPendingNewError(t('nutrition_plan_templates.error_required')); return; }
    setPendingNewSaving(true); setPendingNewError(null);
    const body = { name: pendingNewForm.name.trim(), description: pendingNewForm.description.trim() || null, status: pendingNewForm.status };
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
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('nutrition_plan_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('nutrition_plan_templates.filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('nutrition_plan_templates.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button
            onClick={() => guardUnsaved(() => { setPendingNewForm(emptyForm); setPendingNewError(null); setPendingNew(true); })}
            disabled={!canWrite}
            title={readOnlyTitle}
            style={readOnlyStyle(btnStyle(), !canWrite)}
          >
            {t('nutrition_plan_templates.add_new')}
          </button>
        </div>
      </div>

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
      ) : (
        /* The cards share LIST_GRID_COLUMNS and scroll together, so a narrow
           viewport scrolls the list instead of the page (#1011). */
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
        <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
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
              locale={locale}
              t={t}
              onToggleExpand={() => toggleExpand(row)}
              onEdit={() => guardUnsaved(() => startEdit(row))}
              onDetails={() => guardUnsaved(() => setDetailsTemplate(row))}
              onDuplicate={() => guardUnsaved(() => handleDuplicate(row))}
              onAssign={() => guardUnsaved(() => setAssigning(row))}
              onDelete={() => guardUnsaved(() => setDeleting(row))}
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

interface EditForm { name: string; description: string; status: string }

function TemplateCard({
  template, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t,
  onToggleExpand, onEdit, onDetails, onDuplicate, onAssign, onDelete,
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
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDetails: () => void;
  onDuplicate: () => void;
  onAssign: () => void;
  onDelete: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const roTitle = useReadOnlyTitle(canWrite);
  const menuItems = [
    { label: t('nutrition_plan_templates.edit'), onClick: onEdit, disabled: !canWrite, title: roTitle },
    { label: t('nutrition_plan_templates.details'), onClick: onDetails },
    { label: t('nutrition_plan_templates.duplicate'), onClick: onDuplicate, disabled: !canWrite, title: roTitle },
    ...(template.status === 'active' ? [{ label: t('nutrition_plan_templates.assign_to_member'), onClick: onAssign, disabled: !canWrite, title: roTitle }] : []),
    { label: t('nutrition_plan_templates.delete'), onClick: onDelete, danger: true, disabled: !canWrite, title: roTitle },
  ];

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
          <span className={CELL_CLASS.name} title={template.name} style={nameCellStyle}>{template.name}</span>
          <span className={CELL_CLASS.description} style={descCellStyle}>{template.description ?? '—'}</span>
          <span className={CELL_CLASS.status}>
            <StatusBadge status={template.status} label={t(`status.${template.status}`)} />
          </span>
          <span className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {template.created_by_name ?? '—'}
          </span>
          <span className={CELL_CLASS.created_at} style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>
            {formatDate(template.created_at, locale)}
          </span>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 14px', borderTop: '1px solid #ececf0', marginTop: 12 }}>
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
  form: { name: string; description: string; status: string };
  error: string | null;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
  onFormChange: (f: { name: string; description: string; status: string }) => void;
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
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 14px', borderTop: '1px solid #ececf0', marginTop: 12 }}>
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
        <DetailRow label={t('nutrition_plan_templates.label_status')} value={<StatusBadge status={template.status} label={t(`status.${template.status}`)} />} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('nutrition_plan_templates.label_created_at')} value={formatDate(template.created_at, locale)} />
        <DetailRow label={t('nutrition_plan_templates.label_created_by')} value={template.created_by_name ?? '—'} />
        {template.modified_at && (
          <>
            <DetailRow label={t('nutrition_plan_templates.label_modified_at')} value={formatDate(template.modified_at, locale)} />
            <DetailRow label={t('nutrition_plan_templates.label_modified_by')} value={template.modified_by_name ?? '—'} />
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

function formatDate(value: string, locale: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

const filterInputStyle: React.CSSProperties = { padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff' };
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
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
