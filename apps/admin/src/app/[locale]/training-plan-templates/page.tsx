'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
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
const emptyEditForm = { name: '', description: '', status: 'active' };

export default function TrainingPlanTemplatesPage() {
  const t = useTranslations();
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

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyEditForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Inline editing state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Unsaved-changes guard
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Details dialog
  const [detailsTemplate, setDetailsTemplate] = useState<TrainingPlanTemplate | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<TrainingPlanTemplate | null>(null);

  // Assign to member
  const [assigning, setAssigning] = useState<TrainingPlanTemplate | null>(null);

  // Row expansion + per-template lazy-loaded, cached hierarchy
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  // Warn before browser navigation while editing
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
      const res = await apiFetch<ListResponse>(`/training-plan-templates?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
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

  // Guard: if there's an active unsaved edit, show confirm dialog before proceeding.
  function guardUnsaved(action: () => void) {
    if (editingId !== null) {
      setPendingAction(() => action);
    } else {
      action();
    }
  }

  function startEdit(tpl: TrainingPlanTemplate) {
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
    setEditForm(emptyEditForm);
    setEditError(null);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('training_plan_templates.error_required')); return; }
    setEditSaving(true); setEditError(null);
    const body = { name: editForm.name.trim(), description: editForm.description.trim() || null, status: editForm.status };
    try {
      await apiFetch(`/training-plan-templates/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditingId(null);
      setEditForm(emptyEditForm);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('training_plan_templates.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  async function saveAdd() {
    if (!addForm.name.trim()) { setAddError(t('training_plan_templates.error_required')); return; }
    setAddSaving(true); setAddError(null);
    const body = { name: addForm.name.trim(), description: addForm.description.trim() || null, status: addForm.status };
    try {
      await apiFetch('/training-plan-templates', { method: 'POST', body: JSON.stringify(body) });
      setAddOpen(false); setAddForm(emptyEditForm); load();
    } catch (err: any) { setAddError(err.message ?? t('training_plan_templates.error_generic')); }
    finally { setAddSaving(false); }
  }

  async function handleDuplicate(tpl: TrainingPlanTemplate) {
    try {
      await apiFetch(`/training-plan-templates/${tpl.id}/duplicate`, { method: 'POST' });
      toast(t('training_plan_templates.duplicated'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/training-plan-templates/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('training_plan_templates.error_generic')); }
  }

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: TrainingPlanTemplate) {
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

  if (gymLoading || !canWrite) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('training_plan_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('training_plan_templates.filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('training_plan_templates.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button
            onClick={() => guardUnsaved(() => { setAddForm(emptyEditForm); setAddError(null); setAddOpen(true); })}
            style={btnStyle()}
          >
            {t('training_plan_templates.add')}
          </button>
        </div>
      </div>

      {/* Sort controls */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 12, fontSize: 13, color: '#666' }}>
        {(['name', 'status', 'created_at'] as SortKey[]).map((key) => (
          <button key={key} onClick={() => toggleSort(key)} style={sortBtnStyle(sortKey === key)}>
            {t(`training_plan_templates.col_${key}`)}
            {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>

      {/* Template card list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('training_plan_templates.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('training_plan_templates.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              onDelete={() => guardUnsaved(() => setDeleting(row))}
              onAssign={() => guardUnsaved(() => setAssigning(row))}
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

      {/* Add modal */}
      <CrudModal
        open={addOpen}
        title={t('training_plan_templates.modal_add')}
        error={addError}
        saving={addSaving}
        cancelLabel={t('training_plan_templates.cancel')}
        saveLabel={addSaving ? t('training_plan_templates.saving') : t('training_plan_templates.modal_add')}
        onCancel={() => { setAddOpen(false); setAddForm(emptyEditForm); setAddError(null); }}
        onSave={saveAdd}
      >
        <FormLabel>{t('training_plan_templates.label_name')} *</FormLabel>
        <FormInput value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} autoFocus />
        <FormLabel>{t('training_plan_templates.label_description')}</FormLabel>
        <FormInput value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })} />
        <FormLabel>{t('training_plan_templates.label_status')}</FormLabel>
        <select value={addForm.status} onChange={(e) => setAddForm({ ...addForm, status: e.target.value })} style={modalSelectStyle}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      {/* Details dialog */}
      <DetailsDialog template={detailsTemplate} locale={locale} t={t} onClose={() => setDetailsTemplate(null)} />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('training_plan_templates.confirm_delete')}
        confirmLabel={t('training_plan_templates.delete')}
        cancelLabel={t('training_plan_templates.cancel')}
        onConfirm={del}
        onCancel={() => setDeleting(null)}
      />

      {/* Unsaved changes guard */}
      <ConfirmDialog
        open={pendingAction !== null}
        message={t('training_plan_templates.unsaved_changes')}
        confirmLabel={t('training_plan_templates.unsaved_discard')}
        cancelLabel={t('training_plan_templates.cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
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

interface EditForm { name: string; description: string; status: string }

function TemplateCard({
  template, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t,
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
  const menuItems = [
    ...(canWrite ? [{ label: t('training_plan_templates.edit'), onClick: onEdit }] : []),
    { label: t('training_plan_templates.details'), onClick: onDetails },
    ...(canWrite ? [{ label: t('training_plan_templates.duplicate'), onClick: onDuplicate }] : []),
    ...(template.status === 'active' ? [{ label: t('training_plans.assign_to_member'), onClick: onAssign }] : []),
    ...(canWrite ? [{ label: t('training_plan_templates.delete'), onClick: onDelete, danger: true }] : []),
  ];

  return (
    <div style={cardStyle(editing)}>
      {/* Edit mode header */}
      {editing ? (
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={inlineLabelStyle}>{t('training_plan_templates.label_name')} *</label>
              <input
                value={editForm.name}
                onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus
                style={inlineInputStyle}
              />
              {editError && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{editError}</p>}
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('training_plan_templates.label_description')}</label>
              <textarea
                value={editForm.description}
                onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2}
                style={{ ...inlineInputStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('training_plan_templates.label_status')}</label>
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
        /* Collapsed / expanded non-editing header */
        <div
          onClick={onToggleExpand}
          style={headerRowStyle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}
        >
          <span style={{ fontSize: 12, color: '#aaa', userSelect: 'none', flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
          <span style={nameCellStyle}>{template.name}</span>
          <span style={descCellStyle}>{template.description ?? '—'}</span>
          <StatusBadge status={template.status} label={t(`status.${template.status}`)} />
          <span style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {template.workout_count} {t('training_plan_templates.col_workout_count').toLowerCase()}
          </span>
          <span onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('training_plan_templates.col_actions')} items={menuItems} />
          </span>
        </div>
      )}

      {/* Expanded workout tree */}
      {expanded && (
        <>
          <div style={{ borderTop: '1px solid #ececf0' }} />
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>
              {t('training_plan_templates.loading')}
            </p>
          ) : (
            <TrainingPlanTree
              templateId={template.id}
              hierarchy={hierarchy}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          )}
        </>
      )}

      {/* Save / Cancel footer (edit mode only) */}
      {editing && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 14px', borderTop: '1px solid #ececf0', marginTop: 12 }}>
          <button onClick={onCancel} style={cancelBtnStyle}>{t('training_plan_templates.cancel')}</button>
          <button onClick={onSave} disabled={editSaving} style={btnStyle()}>
            {editSaving ? t('training_plan_templates.saving') : t('training_plan_templates.save_changes')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- DetailsDialog ---- */

function DetailsDialog({
  template, locale, t, onClose,
}: {
  template: TrainingPlanTemplate | null;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  if (!template) return null;
  return (
    <CrudModal
      open
      title={t('training_plan_templates.details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('training_plan_templates.cancel')}
      saveLabel=""
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('training_plan_templates.label_name')} value={template.name} />
        <DetailRow label={t('training_plan_templates.label_description')} value={template.description ?? '—'} />
        <DetailRow label={t('training_plan_templates.label_status')} value={<StatusBadge status={template.status} label={t(`status.${template.status}`)} />} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('training_plan_templates.label_created_at')} value={formatDate(template.created_at, locale)} />
        <DetailRow label={t('training_plan_templates.label_created_by')} value={template.created_by_name ?? '—'} />
        {template.modified_at && (
          <>
            <DetailRow label={t('training_plan_templates.label_modified_at')} value={formatDate(template.modified_at, locale)} />
            <DetailRow label={t('training_plan_templates.label_modified_by')} value={template.modified_by_name ?? '—'} />
          </>
        )}
        {template.deleted_at && (
          <>
            <DetailRow label={t('training_plan_templates.label_deleted_at')} value={formatDate(template.deleted_at, locale)} />
            <DetailRow label={t('training_plan_templates.label_deleted_by')} value={template.deleted_by_name ?? '—'} />
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

const filterInputStyle: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff',
};
const modalSelectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 15, boxSizing: 'border-box', background: '#fff',
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
const cardStyle = (editing: boolean): React.CSSProperties => ({
  border: editing ? '1.5px solid #4b45c6' : '1px solid #ececf0',
  borderRadius: 10,
  background: '#fff',
  overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
  cursor: 'pointer', userSelect: 'none',
};
const nameCellStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 15, flexShrink: 0, maxWidth: 220,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const descCellStyle: React.CSSProperties = {
  color: '#888', fontSize: 13.5, flex: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};
const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
const cancelBtnStyle: React.CSSProperties = {
  background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6,
  padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500,
};
