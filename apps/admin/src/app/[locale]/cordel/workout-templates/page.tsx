'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useToast } from '@/components/Toast';
import { type ContextMenuItem } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS,
  listScrollerClass,
} from '@/components/listChrome';
import { WorkoutTemplateCard } from '../../workout-templates/WorkoutTemplateCard';
import { WorkoutBlockBuilder } from '../../workout-templates/WorkoutBlockBuilder';
import { type WtHierarchy } from '../../workout-templates/WorkoutTemplateTree';
import { CardSection } from '@/components/CardSection';
import { CardDetailRow } from '@/components/CardDetailRow';
import {
  cardMutedTextStyle, formControlStyle, formErrorStyle, formFieldLabelStyle,
  inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import {
  CELL_CLASS, LIST_COLUMNS, LIST_COLUMN_GAP, LIST_GRID_COLUMNS, LIST_MIN_WIDTH, ROW_PADDING_X,
  WorkoutTemplateRowCells,
} from '../../workout-templates/WorkoutTemplateRowCells';

const API_BASE = '/platform/workout-templates';

type BaseStatus = 'active' | 'inactive';

interface BaseTemplate {
  id: number;
  gym_id: null;
  name: string;
  description: string | null;
  status: BaseStatus | 'deleted';
  notes?: string | null;
  blocks_count: number;
  num_blocks?: number;
  created_at: string;
  created_by: string | null;
}

interface PaginatedResponse {
  items: BaseTemplate[];
  total: number;
}

interface BaseForm { name: string; description: string; status: BaseStatus; notes: string }

const EMPTY_FORM: BaseForm = { name: '', description: '', status: 'active', notes: '' };

/**
 * #3335 stage 2: the Base list wears the Exercises listing — title + action, a
 * search bar, the Cards/List toggle and the gym list's own column declaration
 * (Blocks in place of Primary Muscles). Every row here is a System template, so
 * the Source column always reads System sourced. Base rows have no block tree
 * on this screen, so the chevron cell stays empty.
 *
 * #3485: a row now expands into its General fields and its block tree, both
 * read-only; `⋮ → Edit` opens inline Edit mode (the gym page's), which starts a
 * server-side checkpoint so Cancel restores every block and exercise change and
 * Save keeps them.
 */
export default function CordelWorkoutTemplatesPage() {
  const t = useTranslations('workout_templates');
  const tStatus = useTranslations('status');
  const gymFmt = useGymFormatSettings();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [data, setData] = useState<PaginatedResponse>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [viewMode, setViewMode] = useExerciseViewMode();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<BaseForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<BaseForm>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, WtHierarchy>>({});

  const [deleting, setDeleting] = useState<BaseTemplate | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setNameQuery(nameInput.trim()), 300);
    return () => clearTimeout(id);
  }, [nameInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = nameQuery ? `?name=${encodeURIComponent(nameQuery)}` : '';
      setData(await apiFetch<PaginatedResponse>(`${API_BASE}${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, nameQuery]);

  useEffect(() => { load(); }, [load]);

  function payload(f: BaseForm) {
    return { name: f.name.trim(), description: f.description.trim() || null, status: f.status, notes: f.notes.trim() || null };
  }

  async function handleCreate() {
    if (!form.name.trim()) { setFormError(t('error_required')); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch(API_BASE, { method: 'POST', body: JSON.stringify(payload(form)) });
      setCreating(false); setForm(EMPTY_FORM);
      toast(t('base_created'), 'success');
      load();
    } catch (e: any) {
      setFormError(e.message ?? t('error_generic'));
    } finally { setSaving(false); }
  }

  const refetchHierarchy = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<WtHierarchy>(`${API_BASE}/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!hierarchies[id]) refetchHierarchy(id);
  }

  async function openEdit(tpl: BaseTemplate) {
    if (editingId === tpl.id) return; // re-checkpointing would lose what Cancel restores
    if (editingId !== null) await cancelEdit();
    try {
      await apiFetch(`${API_BASE}/${tpl.id}/edit-session`, { method: 'POST' });
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
      return;
    }
    if (viewMode !== 'list') setViewMode('list');
    setEditingId(tpl.id);
    setEditForm({
      name: tpl.name,
      description: tpl.description ?? '',
      status: tpl.status === 'inactive' ? 'inactive' : 'active',
      notes: tpl.notes ?? '',
    });
    setEditError(null);
    setExpanded((prev) => new Set([...prev, tpl.id]));
    refetchHierarchy(tpl.id);
  }

  async function cancelEdit() {
    const id = editingId;
    setEditingId(null); setEditError(null);
    if (id === null) return;
    try {
      await apiFetch(`${API_BASE}/${id}/edit-session/cancel`, { method: 'POST' });
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
    }
    await refetchHierarchy(id);
    load();
  }

  async function handleEdit(tpl: BaseTemplate) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true); setEditError(null);
    try {
      await apiFetch(`${API_BASE}/${tpl.id}`, { method: 'PUT', body: JSON.stringify(payload(editForm)) });
      await apiFetch(`${API_BASE}/${tpl.id}/edit-session`, { method: 'DELETE' });
      setEditingId(null);
      toast(t('base_updated'), 'success');
      load();
    } catch (e: any) {
      setEditError(e.message ?? t('error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${API_BASE}/${deleting.id}`, { method: 'DELETE' });
      if (editingId === deleting.id) setEditingId(null);
      setDeleting(null);
      toast(t('base_deleted'), 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
    }
  }

  function menuItems(tpl: BaseTemplate): ContextMenuItem[] {
    return [
      {
        kind: 'edit' as const,
        label: t('edit'),
        onClick: () => openEdit(tpl),
      },
      { kind: 'delete' as const, label: t('delete'), danger: true, onClick: () => setDeleting(tpl) },
    ];
  }

  function renderTree(tpl: BaseTemplate, editable: boolean) {
    const h = hierarchies[tpl.id];
    if (!h) return <p style={{ ...cardMutedTextStyle, margin: '4px 0 12px' }}>{t('loading')}</p>;
    return (
      <div style={{ marginTop: 4 }}>
        <WorkoutBlockBuilder
          workoutKey={`base-${tpl.id}`}
          blocksUrl={`${API_BASE}/${tpl.id}/blocks`}
          exercisesUrl="/platform/exercises?status=active"
          allowDuplicate={false}
          blocks={h.blocks ?? []}
          canWrite={editable}
          onChanged={() => refetchHierarchy(tpl.id)}
        />
      </div>
    );
  }

  function renderRow(tpl: BaseTemplate) {
    const isExpanded = expanded.has(tpl.id);
    const isEditing = editingId === tpl.id;
    return (
      <div key={tpl.id} style={rowCardStyle}>
        <div
          className={LIST_GRID_ROW_CLASS}
          style={{ ...rowStyle, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => toggleExpand(tpl.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(tpl.id); }}
        >
          <WorkoutTemplateRowCells template={tpl} expanded={isExpanded} menuItems={menuItems(tpl)} fmtDate={(iso) => formatGymDate(iso, gymFmt)} />
        </div>

        {isEditing && (
          <div style={expandedBodyStyle}>
            <CardSection label={t('section_general')} first>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={formFieldLabelStyle}>{t('label_name')} *</label>
                  <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} autoFocus style={formControlStyle} />
                </div>
                <div>
                  <label style={formFieldLabelStyle}>{t('label_status')}</label>
                  <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BaseStatus })} style={formControlStyle}>
                    <option value="active">{tStatus('active')}</option>
                    <option value="inactive">{tStatus('inactive')}</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={formFieldLabelStyle}>{t('label_notes_for_member')}</label>
                  <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={3} placeholder={t('notes_placeholder')} style={{ ...formControlStyle, resize: 'vertical' }} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={formFieldLabelStyle}>{t('label_description')}</label>
                  <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} style={{ ...formControlStyle, resize: 'vertical' }} />
                </div>
              </div>
            </CardSection>
            <CardSection label={t('section_workout_structure')}>{renderTree(tpl, true)}</CardSection>
            {editError && <p style={formErrorStyle}>{editError}</p>}
            <div style={{ ...inlineActionsRowStyle, marginTop: 16 }}>
              <button onClick={cancelEdit} style={secondaryBtnSmall}>{t('cancel')}</button>
              <button onClick={() => handleEdit(tpl)} disabled={saving} style={primaryBtnSmall()}>
                {saving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {isExpanded && !isEditing && (
          <div style={expandedBodyStyle}>
            <CardSection label={t('section_general')} first>
              <CardDetailRow label={t('label_description')} value={tpl.description ?? '—'} />
              <CardDetailRow label={t('label_status')} value={tStatus(tpl.status)} />
              <CardDetailRow label={t('label_notes_for_member')} value={<span style={{ whiteSpace: 'pre-wrap' }}>{tpl.notes || '—'}</span>} />
            </CardSection>
            <CardSection label={t('section_workout_structure')}>{renderTree(tpl, false)}</CardSection>
          </div>
        )}
      </div>
    );
  }

  function formFields(value: BaseForm, onChange: (f: BaseForm) => void) {
    return (
      <>
        <FormLabel>{t('label_name')} *</FormLabel>
        <input className="form-input" value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} placeholder={t('base_placeholder_name')} autoFocus />
        <FormLabel>{t('label_description')}</FormLabel>
        <textarea className="form-input" value={value.description} onChange={e => onChange({ ...value, description: e.target.value })} rows={2} />
        <FormLabel>{t('label_status')}</FormLabel>
        <select className="form-input" value={value.status} onChange={e => onChange({ ...value, status: e.target.value as BaseStatus })}>
          <option value="active">{tStatus('active')}</option>
          <option value="inactive">{tStatus('inactive')}</option>
        </select>
        {/* #3467: the member-facing notes sit right below Status, as on the gym's own Workout Templates. */}
        <FormLabel>{t('label_notes_for_member')}</FormLabel>
        <textarea className="form-input" value={value.notes} onChange={e => onChange({ ...value, notes: e.target.value })} rows={3} placeholder={t('notes_placeholder')} />
      </>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('base_title')}</h1>
        <button style={primaryBtnStyle()} onClick={() => { setForm(EMPTY_FORM); setFormError(null); setCreating(true); }}>{t('base_add')}</button>
      </div>

      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="base-wt-search">
          <input
            id="base-wt-search"
            type="search"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={{ ...filterControlStyle }}
          />
        </FilterField>
        <div style={{ marginLeft: 'auto' }}>
          <ExerciseViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </FilterBar>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : data.items.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>{t('base_empty')}</p>
      ) : viewMode === 'cards' ? (
        <CardGrid>
          {data.items.map((tpl) => (
            <WorkoutTemplateCard key={tpl.id} template={tpl} menuItems={menuItems(tpl)} />
          ))}
        </CardGrid>
      ) : (
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
            <div className={LIST_GRID_ROW_CLASS} style={headerBandStyle}>
              {LIST_COLUMNS.map((col) => (
                <span key={col.key} className={CELL_CLASS[col.key]}>{col.labelKey ? t(col.labelKey) : null}</span>
              ))}
            </div>
            {data.items.map(renderRow)}
          </div>
        </div>
      )}

      <CrudModal
        open={creating}
        title={t('base_modal_add')}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        error={formError}
        cancelLabel={t('cancel')}
        saveLabel={t('base_create')}
      >
        {formFields(form, setForm)}
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('base_confirm_delete', { name: deleting?.name ?? '' })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const expandedBodyStyle: React.CSSProperties = { padding: '16px 20px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' };
const rowCardStyle: React.CSSProperties = { ...cardSurfaceStyle, marginBottom: 8, overflow: 'hidden' };
const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center',
  padding: `12px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP,
};
const headerBandStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center',
  padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP, marginBottom: 4,
  color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
};
