'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { SourceChip } from '@/components/SourceChip';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { cardSurfaceStyle, primaryBtnStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import {
  NutritionPlanTree,
  Hierarchy,
} from '../../nutrition/nutrition-plan-templates/NutritionPlanTree';
import { NutritionPlanTemplateCard } from '../../nutrition/nutrition-plan-templates/NutritionPlanTemplateCard';
import {
  EMPTY_TEMPLATE_FORM, NUM_DAYS_OPTIONS, templateFormFromRow, templatePayload, toNumDays,
  type TemplateForm,
} from '../../nutrition/nutrition-plan-templates/nutritionPlanTemplateList';

const API_BASE = '/platform/nutrition-plan-templates';

interface BaseTemplate {
  id: number;
  gym_id: null;
  name: string;
  description: string | null;
  member_notes?: string | null;
  num_days: number;
  status: 'active' | 'inactive' | 'draft' | 'deleted';
  day_count: number;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
}

/**
 * #3333 stage 2: the Base list wears the Exercises listing — title + actions, a
 * search bar, the Cards/List toggle and the column layout with Days in place of
 * Primary Muscles. Every row here is a System template, so the Source column
 * always reads System sourced.
 */
interface ListColumn extends ListGridColumn {
  labelKey?: string;
  width: number;
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'days', labelKey: 'col_days', width: 60, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 90, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 120, mobile: 'secondary' },
  { key: 'source', labelKey: 'col_source', width: 110, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 80, mobile: 'keep' },
  { key: 'expand', width: 13, mobile: 'keep' },
  { key: 'actions', width: 32, mobile: 'actions' },
];

const CELL_CLASS = listCellClasses(LIST_COLUMNS);
const LIST_COLUMN_GAP = 12;
const ROW_PADDING_X = 20;
const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

const BASE_EMPTY_FORM: TemplateForm = { ...EMPTY_TEMPLATE_FORM, status: 'draft' };

export default function CordelNutritionPlanTemplatesPage() {
  const t = useTranslations('nutrition_plan_templates');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [templates, setTemplates] = useState<BaseTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [viewMode, setViewMode] = useExerciseViewMode();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<TemplateForm>(BASE_EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editing, setEditing] = useState<BaseTemplate | null>(null);
  const [editForm, setEditForm] = useState<TemplateForm>(BASE_EMPTY_FORM);

  const [deleting, setDeleting] = useState<BaseTemplate | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setNameQuery(nameInput.trim()), 300);
    return () => clearTimeout(id);
  }, [nameInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = nameQuery ? `?name=${encodeURIComponent(nameQuery)}` : '';
      setTemplates(await apiFetch<BaseTemplate[]>(`${API_BASE}${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, nameQuery]);

  useEffect(() => { load(); }, [load]);

  async function expand(id: number) {
    if (expandedId === id) { setExpandedId(null); setHierarchy(null); return; }
    setExpandedId(id);
    setHierarchyLoading(true);
    try {
      setHierarchy(await apiFetch<Hierarchy>(`${API_BASE}/${id}/hierarchy`));
    } catch { setHierarchy(null); } finally { setHierarchyLoading(false); }
  }

  async function reloadHierarchy() {
    if (!expandedId) return;
    try { setHierarchy(await apiFetch<Hierarchy>(`${API_BASE}/${expandedId}/hierarchy`)); } catch { /* ignore */ }
  }

  async function handleCreate() {
    const payload = templatePayload(form);
    if (!payload.ok) { setFormError(t(payload.errorKey)); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch(API_BASE, { method: 'POST', body: JSON.stringify(payload.body) });
      setCreating(false); setForm(BASE_EMPTY_FORM);
      toast(t('created'), 'success');
      load();
    } catch (e: any) {
      setFormError(e.message ?? t('error_generic'));
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    const payload = templatePayload(editForm);
    if (!payload.ok) { setFormError(t(payload.errorKey)); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch(`${API_BASE}/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload.body) });
      setEditing(null);
      toast(t('updated'), 'success');
      load();
    } catch (e: any) {
      setFormError(e.message ?? t('error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${API_BASE}/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) { setExpandedId(null); setHierarchy(null); }
      setDeleting(null);
      toast(t('deleted'), 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
    }
  }

  function menuItems(tpl: BaseTemplate): ContextMenuItem[] {
    return [
      {
        kind: 'edit' as const, label: t('edit'),
        onClick: () => {
          setEditing(tpl);
          setEditForm(templateFormFromRow(tpl));
          setFormError(null);
        },
      },
      { kind: 'delete' as const, label: t('delete'), danger: true, onClick: () => setDeleting(tpl) },
    ];
  }

  function renderRow(tpl: BaseTemplate) {
    const isExpanded = expandedId === tpl.id;
    return (
      <div key={tpl.id} style={rowCardStyle}>
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => expand(tpl.id)}>
          <span className={CELL_CLASS.name} title={tpl.name} style={{ fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.name}</span>
          <span className={CELL_CLASS.description} style={{ fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.description ?? '—'}</span>
          <span className={CELL_CLASS.days} style={{ fontSize: 13, color: '#555' }}>{toNumDays(tpl.num_days)}</span>
          <span className={CELL_CLASS.created_at} style={{ fontSize: 13, color: '#888' }}>{tpl.created_at?.slice(0, 10) ?? '—'}</span>
          <span className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#555', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.created_by ?? '—'}</span>
          <span className={CELL_CLASS.source}><SourceChip system label={t('source_system')} /></span>
          <span className={CELL_CLASS.status}><StatusBadge status={tpl.status} label={tStatus(tpl.status as any)} /></span>
          <span className={CELL_CLASS.expand} style={{ fontSize: 13, color: '#aaa', display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <span className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('col_actions')} items={menuItems(tpl)} />
          </span>
        </div>
        {isExpanded && (
          <div style={{ borderTop: '1px solid var(--card-border, #ececf0)' }}>
            {hierarchyLoading ? (
              <p style={{ fontSize: 13, color: '#9ca3af', padding: '12px 20px', margin: 0 }}>{t('loading')}</p>
            ) : hierarchy ? (
              <NutritionPlanTree
                templateId={tpl.id}
                hierarchy={hierarchy}
                canWrite
                onChanged={reloadHierarchy}
                apiBase={API_BASE}
              />
            ) : (
              <p style={{ fontSize: 13, color: '#9ca3af', padding: '12px 20px', margin: 0 }}>{t('hierarchy_failed')}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  function formFields(value: TemplateForm, onChange: (f: TemplateForm) => void) {
    return (
      <>
        <FormLabel>{t('label_name')}</FormLabel>
        <input className="form-input" value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} autoFocus />
        <FormLabel>{t('label_description')}</FormLabel>
        <textarea className="form-input" value={value.description} onChange={e => onChange({ ...value, description: e.target.value })} rows={2} />
        <FormLabel>{t('label_member_notes')}</FormLabel>
        <textarea className="form-input" value={value.member_notes} onChange={e => onChange({ ...value, member_notes: e.target.value })} rows={2} />
        <FormLabel>{t('label_num_days')}</FormLabel>
        <select className="form-input" value={value.num_days} onChange={e => onChange({ ...value, num_days: Number(e.target.value) })}>
          {NUM_DAYS_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <FormLabel>{t('label_status')}</FormLabel>
        <select className="form-input" value={value.status} onChange={e => onChange({ ...value, status: e.target.value })}>
          <option value="draft">{tStatus('draft')}</option>
          <option value="active">{tStatus('active')}</option>
          <option value="inactive">{tStatus('inactive')}</option>
        </select>
      </>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('base_title')}</h1>
        <button style={primaryBtnStyle()} onClick={() => { setForm(BASE_EMPTY_FORM); setFormError(null); setCreating(true); }}>{t('add_new')}</button>
      </div>

      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="base-npt-search">
          <input
            id="base-npt-search"
            type="search"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={filterControlStyle}
          />
        </FilterField>
        <div style={{ marginLeft: 'auto' }}>
          <ExerciseViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </FilterBar>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : templates.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>{t('base_empty')}</p>
      ) : viewMode === 'cards' ? (
        <CardGrid>
          {templates.map((tpl) => (
            <NutritionPlanTemplateCard key={tpl.id} template={tpl} menuItems={menuItems(tpl)} />
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
            {templates.map(renderRow)}
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
        saveLabel={t('create')}
      >
        {formFields(form, setForm)}
      </CrudModal>

      <CrudModal
        open={editing !== null}
        title={t('base_modal_edit')}
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
        saving={saving}
        error={formError}
        cancelLabel={t('cancel')}
        saveLabel={t('save_changes')}
      >
        {formFields(editForm, setEditForm)}
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const rowCardStyle: React.CSSProperties = { ...cardSurfaceStyle, marginBottom: 8, overflow: 'hidden' };
const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center',
  padding: `12px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP, cursor: 'pointer',
};
const headerBandStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center',
  padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP, marginBottom: 4,
  color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
};
