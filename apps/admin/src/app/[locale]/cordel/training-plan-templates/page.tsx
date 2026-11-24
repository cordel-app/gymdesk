'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { type ContextMenuItem } from '@/components/ContextMenu';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { cardSurfaceStyle, primaryBtnStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS,
  listScrollerClass,
} from '@/components/listChrome';
import { TrainingPlanTemplateCard } from '../../training-plan-templates/TrainingPlanTemplateCard';
import {
  CELL_CLASS, LIST_COLUMNS, LIST_COLUMN_GAP, LIST_GRID_COLUMNS, LIST_MIN_WIDTH, ROW_PADDING_X, TemplateRowCells,
} from '../../training-plan-templates/TemplateRowCells';
import {
  EMPTY_TEMPLATE_FORM, NUM_DAYS_OPTIONS, templateFormFromRow, templatePayload,
  type TemplateForm, type TemplateStatus,
} from '../../training-plan-templates/trainingPlanTemplateList';

const API_BASE = '/platform/training-plan-templates';

interface BaseTemplate {
  id: number;
  gym_id: null;
  name: string;
  description: string | null;
  num_days: number;
  status: 'active' | 'inactive' | 'draft' | 'deleted';
  workout_count: number;
  created_at: string;
  created_by: string | null;
}

interface PaginatedResponse {
  items: BaseTemplate[];
  total: number;
}

/**
 * #3334 stage 2: the Base list wears the Exercises listing — title + action, a
 * search bar, the Cards/List toggle and the gym list's own column declaration
 * (Days in place of Primary Muscles). Every row here is a System template, so
 * the Source column always reads System sourced. Base rows have no workout tree
 * on this screen, so the chevron cell stays empty.
 */
export default function CordelTrainingPlanTemplatesPage() {
  const t = useTranslations('training_plan_templates');
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
  const [form, setForm] = useState<TemplateForm>(EMPTY_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editing, setEditing] = useState<BaseTemplate | null>(null);
  const [editForm, setEditForm] = useState<TemplateForm>(EMPTY_TEMPLATE_FORM);

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

  async function handleCreate() {
    const payload = templatePayload(form);
    if (!payload.ok) { setFormError(t(payload.errorKey)); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch(API_BASE, { method: 'POST', body: JSON.stringify(payload.body) });
      setCreating(false); setForm(EMPTY_TEMPLATE_FORM);
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
        label: t('edit'),
        onClick: () => {
          setEditing(tpl);
          setEditForm(templateFormFromRow(tpl));
          setFormError(null);
        },
      },
      { label: t('delete'), danger: true, onClick: () => setDeleting(tpl) },
    ];
  }

  function renderRow(tpl: BaseTemplate) {
    return (
      <div key={tpl.id} style={rowCardStyle}>
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle}>
          <TemplateRowCells template={tpl} expanded={null} menuItems={menuItems(tpl)} fmtDate={(iso) => formatGymDate(iso, gymFmt)} />
        </div>
      </div>
    );
  }

  function formFields(value: TemplateForm, onChange: (f: TemplateForm) => void) {
    return (
      <>
        <FormLabel>{t('label_name')} *</FormLabel>
        <input className="form-input" value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} placeholder={t('placeholder_name')} autoFocus />
        <FormLabel>{t('label_description')}</FormLabel>
        <textarea className="form-input" value={value.description} onChange={e => onChange({ ...value, description: e.target.value })} rows={2} />
        <FormLabel>{t('label_num_days')}</FormLabel>
        <select className="form-input" value={value.num_days} onChange={e => onChange({ ...value, num_days: Number(e.target.value) })}>
          {NUM_DAYS_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <FormLabel>{t('label_status')}</FormLabel>
        <select className="form-input" value={value.status} onChange={e => onChange({ ...value, status: e.target.value as TemplateStatus })}>
          <option value="active">{tStatus('active')}</option>
          <option value="inactive">{tStatus('inactive')}</option>
          <option value="draft">{tStatus('draft')}</option>
        </select>
      </>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('base_title')}</h1>
        <button style={primaryBtnStyle()} onClick={() => { setForm(EMPTY_TEMPLATE_FORM); setFormError(null); setCreating(true); }}>{t('base_add')}</button>
      </div>

      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="base-tpt-search">
          <input
            id="base-tpt-search"
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
      ) : data.items.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>{t('base_empty')}</p>
      ) : viewMode === 'cards' ? (
        <CardGrid>
          {data.items.map((tpl) => (
            <TrainingPlanTemplateCard key={tpl.id} template={tpl} menuItems={menuItems(tpl)} />
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
        saveLabel={t('save')}
      >
        {formFields(editForm, setEditForm)}
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
