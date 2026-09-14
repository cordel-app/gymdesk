'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { ImageUploadField } from '@/components/ImageUploadField';
import { btnStyle, btnSmall } from '@/components/ui';

interface Category { id: number; slug: string }
interface NutritionalQuality { id: number; slug: string }

interface LibraryItem {
  id: number;
  gym_id: string | null;
  name: string;
  status: 'active' | 'deleted';
  image_url: string | null;
  created_at: string;
  modified_at: string | null;
  categories: Category[];
  qualities: NutritionalQuality[];
}

interface ListResponse {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
}

interface EditForm {
  name: string;
  categoryIds: number[];
  qualityIds: number[];
  imageUrl: string | null;
}

function emptyEditForm(): EditForm {
  return { name: '', categoryIds: [], qualityIds: [], imageUrl: null };
}

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
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allQualities, setAllQualities] = useState<NutritionalQuality[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [qualityFilter, setQualityFilter] = useState<string[]>([]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Inline create
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<EditForm>(emptyEditForm());
  const [newSaving, setNewSaving] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  function categoryLabel(slug: string) {
    return t(`nutrition_library.category_${slug}`, { defaultValue: slug });
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
      for (const c of categoryFilter) params.append('category_id', c);
      for (const q of qualityFilter) params.append('quality_id', q);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const [data, categoriesData, qualitiesData] = await Promise.all([
        apiFetch<ListResponse>(`/nutrition-library?${params.toString()}`),
        allCategories.length ? Promise.resolve(allCategories) : apiFetch<Category[]>('/nutrition-library/categories'),
        allQualities.length ? Promise.resolve(allQualities) : apiFetch<NutritionalQuality[]>('/nutrition-library/nutritional-qualities'),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setAllCategories(categoriesData);
      setAllQualities(qualitiesData);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_library.error_generic'));
    } finally { setLoading(false); }
  }, [apiFetch, activeGymId, search, categoryFilter, qualityFilter, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  function toggleId(ids: number[], id: number): number[] {
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  function toggleExpand(id: number) {
    if (editingId === id) return; // don't collapse while editing
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

  // ─── Inline create ──────────────────────────────────────────────────────

  function openInlineNew() {
    setNewForm(emptyEditForm());
    setNewError(null);
    setCreating(true);
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setCreating(false);
    setNewError(null);
  }

  async function saveInlineNew() {
    if (!newForm.name.trim()) { setNewError(t('nutrition_library.error_required')); return; }
    if (newForm.categoryIds.length === 0) { setNewError(t('nutrition_library.error_category_required')); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch('/nutrition-library', {
        method: 'POST',
        body: JSON.stringify({
          name: newForm.name.trim(),
          category_ids: newForm.categoryIds,
          quality_ids: newForm.qualityIds,
          image_url: newForm.imageUrl,
        }),
      });
      setCreating(false);
      load();
    } catch (e: any) {
      setNewError(e.message ?? t('nutrition_library.error_generic'));
    } finally { setNewSaving(false); }
  }

  // ─── Inline edit ────────────────────────────────────────────────────────

  function openInlineEdit(item: LibraryItem) {
    setEditingId(item.id);
    setEditForm({
      name: item.name,
      categoryIds: item.categories.map((c) => c.id),
      qualityIds: item.qualities.map((q) => q.id),
      imageUrl: item.image_url,
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleInlineSave(item: LibraryItem) {
    if (!editForm.name.trim()) { setEditError(t('nutrition_library.error_required')); return; }
    if (editForm.categoryIds.length === 0) { setEditError(t('nutrition_library.error_category_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/nutrition-library/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          category_ids: editForm.categoryIds,
          quality_ids: editForm.qualityIds,
          image_url: editForm.imageUrl,
        }),
      });
      setEditingId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? t('nutrition_library.error_generic'));
    } finally { setEditSaving(false); }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);
  const activeFilterCount = categoryFilter.length + qualityFilter.length + (search ? 1 : 0);

  function renderCategoryCheckboxes(selected: number[], onChange: (ids: number[]) => void) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {allCategories.map((c) => (
          <label key={c.id} style={chipCheckboxLabel(selected.includes(c.id))}>
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={() => onChange(toggleId(selected, c.id))}
              style={{ marginRight: 6 }}
            />
            {categoryLabel(c.slug)}
          </label>
        ))}
      </div>
    );
  }

  function renderQualityCheckboxes(selected: number[], onChange: (ids: number[]) => void) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {allQualities.map((q) => (
          <label key={q.id} style={chipCheckboxLabel(selected.includes(q.id))}>
            <input
              type="checkbox"
              checked={selected.includes(q.id)}
              onChange={() => onChange(toggleId(selected, q.id))}
              style={{ marginRight: 6 }}
            />
            {qualityLabel(q.slug)}
          </label>
        ))}
      </div>
    );
  }

  function renderInlineForm(
    form: EditForm,
    setForm: (f: EditForm) => void,
    error: string | null,
    saving: boolean,
    onCancel: () => void,
    onSave: () => void,
    saveLabel: string,
    autoFocusRef?: React.RefObject<HTMLInputElement>,
  ) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_library.label_name')} *</label>
            <input
              ref={autoFocusRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inlineInputStyle}
              autoFocus={!autoFocusRef}
            />
          </div>
          <div>
            <label style={inlineLabelStyle}>{t('nutrition_library.label_image')}</label>
            <ImageUploadField
              uploadPath="/storage/uploads/nutrition-image"
              value={form.imageUrl}
              onChange={(url) => setForm({ ...form, imageUrl: url })}
            />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>{t('nutrition_library.label_categories')} *</label>
          {renderCategoryCheckboxes(form.categoryIds, (ids) => setForm({ ...form, categoryIds: ids }))}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>{t('nutrition_library.nutritional_qualities_label')}</label>
          {renderQualityCheckboxes(form.qualityIds, (ids) => setForm({ ...form, qualityIds: ids }))}
        </div>
        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 8px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnSmall('#888')}>{t('nutrition_library.cancel')}</button>
          <button onClick={onSave} disabled={saving} style={btnSmall()}>
            {saving ? t('nutrition_library.saving') : saveLabel}
          </button>
        </div>
      </div>
    );
  }

  const columns: Column<LibraryItem>[] = [
    { header: t('nutrition_library.label_name'), render: (item) => <strong>{item.name}</strong> },
    {
      header: t('nutrition_library.label_categories'),
      render: (item) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.categories.map((c) => <span key={c.id} style={categoryChipStyle}>{categoryLabel(c.slug)}</span>)}
        </div>
      ),
    },
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
            ...(canEditItem ? [{ label: t('nutrition_library.edit'), onClick: () => openInlineEdit(item) }] : []),
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
        {canWrite && <button style={btnStyle()} onClick={openInlineNew} disabled={creating}>{t('nutrition_library.add_new')}</button>}
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
          options={allCategories.map((c) => ({ value: String(c.id), label: categoryLabel(c.slug) }))}
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

      {/* Inline create row */}
      {creating && (
        <div style={cardStyle(true)}>
          {renderInlineForm(newForm, setNewForm, newError, newSaving, cancelInlineNew, saveInlineNew, t('nutrition_library.create'), newNameRef)}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        loading={loading}
        loadingText={t('nutrition_library.loading')}
        emptyText={t('nutrition_library.empty_filtered')}
        renderExpanded={(item) => (
          editingId === item.id ? (
            renderInlineForm(editForm, setEditForm, editError, editSaving, cancelEdit, () => handleInlineSave(item), t('nutrition_library.save'))
          ) : (
            <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <DetailRow
                label={t('nutrition_library.label_categories')}
                value={item.categories.length > 0 ? item.categories.map((c) => categoryLabel(c.slug)).join(', ') : '—'}
              />
              <DetailRow
                label={t('nutrition_library.nutritional_qualities_label')}
                value={item.qualities.length > 0 ? item.qualities.map((q) => qualityLabel(q.slug)).join(', ') : t('nutrition_library.no_qualities')}
              />
              <DetailRow label={t('nutrition_library.col_status')} value={t(`nutrition_library.status_${item.status}`)} />
              <DetailRow label={t('nutrition_library.ownership')} value={item.gym_id === null ? t('nutrition_library.ownership_base') : t('nutrition_library.ownership_gym')} />
              <DetailRow label={t('nutrition_library.created_at')} value={new Date(item.created_at).toLocaleString()} />
              <DetailRow label={t('nutrition_library.modified_at')} value={item.modified_at ? new Date(item.modified_at).toLocaleString() : '—'} />
              {item.image_url && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <span style={{ width: 120, flexShrink: 0, color: '#888' }}>{t('nutrition_library.label_image')}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.image_url} alt="" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, border: '1px solid #ddd', objectFit: 'contain' }} />
                </div>
              )}
            </div>
          )
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(item) => toggleExpand(item.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#666' }}>{pageStart}–{pageEnd} / {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={btnStyle('#888')}>›</button>
        </div>
      )}
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

const categoryChipStyle: React.CSSProperties = {
  background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 20,
  padding: '2px 10px', fontSize: 12, fontWeight: 500, color: '#15803d',
};

function chipCheckboxLabel(checked: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', padding: '4px 12px', borderRadius: 12,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : 'transparent',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: 'pointer', fontSize: 13, fontWeight: 500, userSelect: 'none',
  };
}

const cardStyle = (highlighted: boolean): React.CSSProperties => ({
  border: highlighted ? '1.5px solid #4b45c6' : '1px solid var(--gd-card-border, #ececf0)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'var(--gd-card-bg, #ffffff)',
  marginBottom: 12,
});

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
