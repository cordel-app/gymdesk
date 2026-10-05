'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess, useReadOnlyTitle } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { NutritionPlanTree, Hierarchy } from '../nutrition-plan-templates/NutritionPlanTree';
import { NewNutritionPlanDialog } from '../NewNutritionPlanDialog';

interface MemberNutritionPlan {
  id: number;
  name: string;
  description: string | null;
  member_id: number;
  member_name: string;
  template_id: number | null;
  status: 'active' | 'completed' | 'deleted';
  start_date: string | null;
  day_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
}

interface MemberOption { id: number; name: string }

interface EditForm { name: string; description: string; start_date: string }
const emptyEditForm: EditForm = { name: '', description: '', start_date: '' };

function formatDate(iso: string, locale: string) {
  return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
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
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'name', width: 140, grow: 2, mobile: 'name' },
  { key: 'member', width: 120, grow: 1, mobile: 'keep' },
  { key: 'days', width: 80, mobile: 'secondary' },
  { key: 'created_at', width: 100, mobile: 'secondary' },
  { key: 'created_by', width: 140, mobile: 'secondary' },
  { key: 'status', width: 90, mobile: 'keep' },
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
  const [memberFilter, setMemberFilter] = useState(searchParams.get('member_id') ?? '');
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [deleting, setDeleting] = useState<MemberNutritionPlan | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

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
      if (memberFilter) params.set('member_id', memberFilter);
      const data = await apiFetch<MemberNutritionPlan[]>(`/member-nutrition-plans?${params.toString()}`);
      setRows(data);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, memberFilter]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<MemberOption[]>('/members').then(setMemberOptions).catch(() => {});
  }, [activeGymId, gymLoading]);

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  function startEdit(plan: MemberNutritionPlan) {
    setEditingId(plan.id);
    setEditForm({ name: plan.name, description: plan.description ?? '', start_date: plan.start_date?.slice(0, 10) ?? '' });
    setEditError(null);
    if (!expanded.has(plan.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(plan.id); return next; });
      loadHierarchy(plan.id);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyEditForm);
    setEditError(null);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('nutrition_plans.error_required')); return; }
    setEditSaving(true); setEditError(null);
    const body = { name: editForm.name.trim(), description: editForm.description.trim() || null, start_date: editForm.start_date || null };
    try {
      await apiFetch(`/member-nutrition-plans/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditingId(null); setEditForm(emptyEditForm); load();
    } catch (err: any) {
      setEditError(err.message ?? t('nutrition_plans.error_generic'));
    } finally { setEditSaving(false); }
  }

  async function handleDuplicate(plan: MemberNutritionPlan) {
    try {
      await apiFetch(`/member-nutrition-plans/${plan.id}/duplicate`, { method: 'POST' });
      toast(t('nutrition_plans.duplicated'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
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
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            style={filterInputStyle}
          >
            <option value="">{t('nutrition_plans.filter_all_members')}</option>
            {memberOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button onClick={() => guardUnsaved(() => router.push(`/${locale}/nutrition/nutrition-plan-templates`))} style={btnStyle()}>
            {t('nutrition_plans.assign_from_template')}
          </button>
          <button onClick={() => guardUnsaved(() => setNewOpen(true))} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle(), !canWrite)}>
            {t('nutrition_plans.new_plan')}
          </button>
        </div>
      </div>

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
              onEdit={() => guardUnsaved(() => startEdit(row))}
              onDetails={() => guardUnsaved(() => setDetailsPlan(row))}
              onDuplicate={() => guardUnsaved(() => handleDuplicate(row))}
              onComplete={() => guardUnsaved(() => setCompleting(row))}
              onDelete={() => guardUnsaved(() => setDeleting(row))}
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
  onToggleExpand, onEdit, onDetails, onDuplicate, onComplete, onDelete,
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
  onDuplicate: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const isActive = plan.status === 'active';
  const canEditPlan = canWrite && isActive;
  const roTitle = useReadOnlyTitle(canWrite);
  const menuItems = [
    ...(isActive ? [{ label: t('nutrition_plans.edit'), onClick: onEdit, disabled: !canWrite, title: roTitle }] : []),
    { label: t('nutrition_plans.details'), onClick: onDetails },
    { label: t('nutrition_plans.duplicate'), onClick: onDuplicate, disabled: !canWrite, title: roTitle },
    ...(isActive ? [{ label: t('nutrition_plans.complete'), onClick: onComplete, disabled: !canWrite, title: roTitle }] : []),
    { label: t('nutrition_plans.delete'), onClick: onDelete, danger: true, disabled: !canWrite, title: roTitle },
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
              <label style={inlineLabelStyle}>{t('nutrition_plans.label_start_date')}</label>
              <input
                type="date"
                value={editForm.start_date}
                onChange={(e) => onEditFormChange({ ...editForm, start_date: e.target.value })}
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
          <span className={CELL_CLASS.name} title={`${plan.name} · ${plan.member_name}`} style={nameCellStyle}>{plan.name}</span>
          {/* #810: the assigned member reads at the plan name's own size and weight. */}
          <span className={CELL_CLASS.member} title={plan.member_name} style={memberCellStyle}>{plan.member_name}</span>
          <span className={CELL_CLASS.days} style={metaCellStyle}>
            {t('nutrition_plans.day_count', { count: plan.day_count })}
          </span>
          <span className={CELL_CLASS.created_at} style={metaCellStyle}>
            {formatDate(plan.created_at, locale)}
          </span>
          <span className={CELL_CLASS.created_by} style={{ ...metaCellStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {plan.created_by_name ?? '—'}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 14px', borderTop: '1px solid #ececf0', marginTop: 12 }}>
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
        <DetailRow label={t('nutrition_plans.label_name')} value={plan.name} />
        <DetailRow label={t('nutrition_plans.label_description')} value={plan.description ?? '—'} />
        <DetailRow label={t('nutrition_plans.label_member')} value={plan.member_name} />
        <DetailRow label={t('nutrition_plans.label_status')} value={<StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />} />
        <DetailRow label={t('nutrition_plans.label_start_date')} value={plan.start_date ? formatDate(plan.start_date, locale) : '—'} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('nutrition_plans.label_created_at')} value={formatDate(plan.created_at, locale)} />
        <DetailRow label={t('nutrition_plans.label_created_by')} value={plan.created_by_name ?? '—'} />
        {plan.modified_at && (
          <>
            <DetailRow label={t('nutrition_plans.label_modified_at')} value={formatDate(plan.modified_at, locale)} />
            <DetailRow label={t('nutrition_plans.label_modified_by')} value={plan.modified_by_name ?? '—'} />
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

const filterInputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, background: '#fff', minWidth: 160,
};

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
const metaCellStyle: React.CSSProperties = {
  fontSize: 13, color: '#888', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
