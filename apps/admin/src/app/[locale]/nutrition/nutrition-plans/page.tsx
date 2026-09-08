'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import { canWriteModule } from '@/config/permissions';
import { NutritionPlanTree, Hierarchy } from '../nutrition-plan-templates/NutritionPlanTree';

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

export default function NutritionPlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<MemberNutritionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [memberFilter, setMemberFilter] = useState(searchParams.get('member_id') ?? '');
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [deleting, setDeleting] = useState<MemberNutritionPlan | null>(null);

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

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'NUTRITION'));
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

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
      toast(t('nutrition_plans.duplicated'));
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

  if (gymLoading || !canWrite) return null;

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
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.empty')}</p>
      ) : (
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
  const canEditPlan = canWrite && plan.status === 'active';
  const menuItems = [
    ...(canEditPlan ? [{ label: t('nutrition_plans.edit'), onClick: onEdit }] : []),
    { label: t('nutrition_plans.details'), onClick: onDetails },
    ...(canWrite ? [{ label: t('nutrition_plans.duplicate'), onClick: onDuplicate }] : []),
    ...(canEditPlan ? [{ label: t('nutrition_plans.complete'), onClick: onComplete }] : []),
    ...(canWrite ? [{ label: t('nutrition_plans.delete'), onClick: onDelete, danger: true }] : []),
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
          style={headerRowStyle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
        >
          <span style={{ fontSize: 12, color: '#aaa', userSelect: 'none', flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
          <span style={nameCellStyle}>{plan.name}</span>
          <span style={{ fontSize: 13, color: '#666', flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {plan.member_name}
          </span>
          <StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />
          <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>
            {t('nutrition_plans.day_count', { count: plan.day_count })}
          </span>
          <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>
            {formatDate(plan.created_at, locale)}
          </span>
          <span onClick={(e) => e.stopPropagation()}>
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
  border: editing ? '1.5px solid #4b45c6' : '1px solid #e0e0e8', borderRadius: 10, background: '#fff', overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer', userSelect: 'none',
};
const nameCellStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, fontWeight: 600, fontSize: 15,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
