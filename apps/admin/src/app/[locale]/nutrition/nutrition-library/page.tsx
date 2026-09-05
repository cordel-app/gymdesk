'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { btnStyle } from '@/components/ui';

interface NutritionalQuality { id: number; slug: string }

interface LibraryItem {
  id: number;
  gym_id: string | null;
  name: string;
  category: string;
  status: 'active' | 'deleted';
  created_at: string;
  modified_at: string | null;
  qualities: NutritionalQuality[];
}

interface ListResponse {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
}

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
type Category = typeof CATEGORIES[number];
const LIMIT = 20;

export default function NutritionLibraryPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const canWrite = !!activeGym?.role && canWriteModule(activeGym.role, 'NUTRITION');

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [allQualities, setAllQualities] = useState<NutritionalQuality[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [qualityFilter, setQualityFilter] = useState<string[]>([]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('main_dish');
  const [newQualityIds, setNewQualityIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<Category>('main_dish');
  const [editQualityIds, setEditQualityIds] = useState<number[]>([]);

  function categoryLabel(cat: string) {
    return t(`nutrition_library.category_${cat}`, { defaultValue: cat });
  }
  function qualityLabel(slug: string) {
    return t(`nutrition_library.quality_${slug}`, { defaultValue: slug });
  }

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setOffset(0); }, [search, categoryFilter, qualityFilter]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      for (const c of categoryFilter) params.append('category', c);
      for (const q of qualityFilter) params.append('quality_id', q);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const [data, qualitiesData] = await Promise.all([
        apiFetch<ListResponse>(`/nutrition-library?${params.toString()}`),
        allQualities.length ? Promise.resolve(allQualities) : apiFetch<NutritionalQuality[]>('/nutrition-library/nutritional-qualities'),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setAllQualities(qualitiesData);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_library.error_generic'));
    } finally { setLoading(false); }
  }, [apiFetch, activeGymId, search, categoryFilter, qualityFilter, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  function toggleQuality(ids: number[], qualityId: number): number[] {
    return ids.includes(qualityId) ? ids.filter((id) => id !== qualityId) : [...ids, qualityId];
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setSearchInput('');
    setSearch('');
    setCategoryFilter([]);
    setQualityFilter([]);
  }

  function openCreate() {
    setNewName(''); setNewCategory('main_dish'); setNewQualityIds([]); setFormError(null);
    setCreating(true);
  }

  function openEdit(item: LibraryItem) {
    setEditing(item);
    setEditName(item.name);
    setEditCategory(item.category as Category);
    setEditQualityIds(item.qualities.map((q) => q.id));
    setFormError(null);
  }

  async function handleCreate() {
    if (!newName.trim()) { setFormError(t('nutrition_library.error_required')); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch('/nutrition-library', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), category: newCategory, quality_ids: newQualityIds }),
      });
      setCreating(false);
      load();
    } catch (e: any) {
      setFormError(e.message ?? t('nutrition_library.error_generic'));
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    if (!editName.trim()) { setFormError(t('nutrition_library.error_required')); return; }
    setSaving(true); setFormError(null);
    try {
      await apiFetch(`/nutrition-library/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), category: editCategory, quality_ids: editQualityIds }),
      });
      setEditing(null);
      load();
    } catch (e: any) {
      setFormError(e.message ?? t('nutrition_library.error_generic'));
    } finally { setSaving(false); }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);
  const activeFilterCount = categoryFilter.length + qualityFilter.length + (search ? 1 : 0);

  const columns: Column<LibraryItem>[] = [
    { header: t('nutrition_library.label_name'), render: (item) => <strong>{item.name}</strong> },
    { header: t('nutrition_library.filter_category'), width: 140, render: (item) => categoryLabel(item.category) },
    {
      header: t('nutrition_library.nutritional_qualities_label'),
      render: (item) => item.qualities.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.qualities.map((q) => <span key={q.id} style={qualityChipStyle}>{qualityLabel(q.slug)}</span>)}
        </div>
      ) : <span style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 13 }}>—</span>,
    },
    {
      header: '', width: 120,
      render: (item) => item.gym_id === null
        ? <span style={{ fontSize: 12, color: '#888' }}>{t('nutrition_library.read_only')}</span>
        : null,
    },
    {
      header: '', width: 40,
      render: (item) => {
        const canEditItem = canWrite && item.gym_id !== null;
        return (
          <ContextMenu items={[
            { label: t('nutrition_library.details'), onClick: () => toggleExpand(item.id) },
            ...(canEditItem ? [{ label: t('nutrition_library.edit'), onClick: () => openEdit(item) }] : []),
          ]} />
        );
      },
    },
  ];

  if (gymLoading) return null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{t('nutrition_library.title')}</h1>
        {canWrite && <button style={btnStyle()} onClick={openCreate}>{t('nutrition_library.add_new')}</button>}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('nutrition_library.search_placeholder')}
          style={searchInputStyle}
        />
        <MultiSelectFilter
          label={t('nutrition_library.filter_category')}
          options={CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
          selected={categoryFilter}
          onChange={setCategoryFilter}
        />
        <MultiSelectFilter
          label={t('nutrition_library.filter_qualities')}
          options={allQualities.map((q) => ({ value: String(q.id), label: qualityLabel(q.slug) }))}
          selected={qualityFilter}
          onChange={setQualityFilter}
        />
        {activeFilterCount > 0 && (
          <button onClick={clearFilters} style={{ ...btnStyle('#888'), padding: '8px 14px' }}>{t('nutrition_library.clear_filters')}</button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        loading={loading}
        loadingText={t('nutrition_library.loading')}
        emptyText={t('nutrition_library.empty_filtered')}
        renderExpanded={(item) => (
          <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <DetailRow label={t('nutrition_library.filter_category')} value={categoryLabel(item.category)} />
            <DetailRow label={t('nutrition_library.col_status')} value={t(`nutrition_library.status_${item.status}`)} />
            <DetailRow label={t('nutrition_library.created_at')} value={new Date(item.created_at).toLocaleString()} />
            <DetailRow label={t('nutrition_library.modified_at')} value={item.modified_at ? new Date(item.modified_at).toLocaleString() : '—'} />
          </div>
        )}
        expandedRowKeys={expanded}
        onToggleExpand={(item) => toggleExpand(item.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#666' }}>{pageStart}–{pageEnd} / {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={btnStyle('#888')}>›</button>
        </div>
      )}

      {/* Create modal (gym-owned items only) */}
      <CrudModal
        open={creating}
        title={t('nutrition_library.modal_add_title')}
        error={formError}
        saving={saving}
        cancelLabel={t('nutrition_library.cancel')}
        saveLabel={t('nutrition_library.create')}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
      >
        <FormLabel>{t('nutrition_library.label_name')}</FormLabel>
        <input className="form-input" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
        <FormLabel>{t('nutrition_library.label_category')}</FormLabel>
        <select className="form-input" value={newCategory} onChange={(e) => setNewCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
        <FormLabel>{t('nutrition_library.nutritional_qualities_label')}</FormLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {allQualities.map((q) => (
            <label key={q.id} style={qualityCheckboxLabel(newQualityIds.includes(q.id))}>
              <input
                type="checkbox"
                checked={newQualityIds.includes(q.id)}
                onChange={() => setNewQualityIds((prev) => toggleQuality(prev, q.id))}
                style={{ marginRight: 6 }}
              />
              {qualityLabel(q.slug)}
            </label>
          ))}
        </div>
      </CrudModal>

      {/* Edit modal (gym-owned items only) */}
      <CrudModal
        open={editing !== null}
        title={t('nutrition_library.modal_edit_title')}
        error={formError}
        saving={saving}
        cancelLabel={t('nutrition_library.cancel')}
        saveLabel={t('nutrition_library.save')}
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
      >
        <FormLabel>{t('nutrition_library.label_name')}</FormLabel>
        <input className="form-input" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
        <FormLabel>{t('nutrition_library.label_category')}</FormLabel>
        <select className="form-input" value={editCategory} onChange={(e) => setEditCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
        <FormLabel>{t('nutrition_library.nutritional_qualities_label')}</FormLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {allQualities.map((q) => (
            <label key={q.id} style={qualityCheckboxLabel(editQualityIds.includes(q.id))}>
              <input
                type="checkbox"
                checked={editQualityIds.includes(q.id)}
                onChange={() => setEditQualityIds((prev) => toggleQuality(prev, q.id))}
                style={{ marginRight: 6 }}
              />
              {qualityLabel(q.slug)}
            </label>
          ))}
        </div>
      </CrudModal>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 120, flexShrink: 0, color: '#888' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const searchInputStyle: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, minWidth: 220,
};

const qualityChipStyle: React.CSSProperties = {
  background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 20,
  padding: '2px 10px', fontSize: 12, fontWeight: 500, color: '#1d4ed8',
};

function qualityCheckboxLabel(checked: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', padding: '4px 12px', borderRadius: 12,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : 'transparent',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: 'pointer', fontSize: 13, fontWeight: 500, userSelect: 'none',
  };
}
