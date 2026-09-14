'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { btnStyle, btnSmall } from '@/components/ui';

interface Category { id: number; slug: string }
interface NutritionalQuality { id: number; slug: string }

interface LibraryItem {
  id: number;
  name: string;
  status: 'active' | 'deleted';
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
}

function emptyEditForm(): EditForm {
  return { name: '', categoryIds: [], qualityIds: [] };
}

const CATEGORY_LABELS: Record<string, string> = {
  main_dish: 'Main Dish',
  side: 'Side',
  sauce: 'Sauce',
  drink: 'Drink',
  dessert: 'Dessert',
  other: 'Other',
};

const QUALITY_LABELS: Record<string, string> = {
  protein: 'Protein',
  carbohydrate: 'Carbohydrate',
  fat: 'Fat',
  fiber: 'Fiber',
};

function categoryLabel(slug: string) {
  return CATEGORY_LABELS[slug] ?? slug.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function qualityLabel(slug: string) {
  return QUALITY_LABELS[slug] ?? slug;
}

const LIMIT = 20;

export default function CordelNutritionLibraryPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allQualities, setAllQualities] = useState<NutritionalQuality[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);

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

  const [deleting, setDeleting] = useState<LibraryItem | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setOffset(0); }, [search, categoryFilter, qualityFilter, showDeleted]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      for (const c of categoryFilter) params.append('category_id', c);
      for (const q of qualityFilter) params.append('quality_id', q);
      params.set('status', showDeleted ? 'deleted' : 'active');
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const [data, categoriesData, qualitiesData] = await Promise.all([
        apiFetch<ListResponse>(`/platform/nutrition-library?${params.toString()}`),
        allCategories.length ? Promise.resolve(allCategories) : apiFetch<Category[]>('/platform/nutrition-library/categories'),
        allQualities.length ? Promise.resolve(allQualities) : apiFetch<NutritionalQuality[]>('/platform/nutrition-library/nutritional-qualities'),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setAllCategories(categoriesData);
      setAllQualities(qualitiesData);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search, categoryFilter, qualityFilter, showDeleted, offset]);

  useEffect(() => { load(); }, [load]);

  function toggleId(ids: number[], id: number): number[] {
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  function toggleExpand(id: number) {
    if (editingId === id) return;
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

  async function saveInlineNew() {
    if (!newForm.name.trim()) { setNewError('Name is required.'); return; }
    if (newForm.categoryIds.length === 0) { setNewError('At least one category is required.'); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch('/platform/nutrition-library', {
        method: 'POST',
        body: JSON.stringify({ name: newForm.name.trim(), category_ids: newForm.categoryIds, quality_ids: newForm.qualityIds }),
      });
      setCreating(false);
      toast('Item created', 'success');
      load();
    } catch (e: any) {
      setNewError(e.message ?? 'Error');
    } finally { setNewSaving(false); }
  }

  // ─── Inline edit ────────────────────────────────────────────────────────

  function openInlineEdit(item: LibraryItem) {
    setEditingId(item.id);
    setEditForm({
      name: item.name,
      categoryIds: item.categories.map((c) => c.id),
      qualityIds: item.qualities.map((q) => q.id),
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleInlineSave(item: LibraryItem) {
    if (!editForm.name.trim()) { setEditError('Name is required.'); return; }
    if (editForm.categoryIds.length === 0) { setEditError('At least one category is required.'); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/platform/nutrition-library/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), category_ids: editForm.categoryIds, quality_ids: editForm.qualityIds }),
      });
      setEditingId(null);
      toast('Item updated', 'success');
      load();
    } catch (e: any) {
      setEditError(e.message ?? 'Error');
    } finally { setEditSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/nutrition-library/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Item deleted', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);
  const activeFilterCount = categoryFilter.length + qualityFilter.length + (search ? 1 : 0);

  function renderCheckboxes(all: { id: number; slug: string }[], selected: number[], onChange: (ids: number[]) => void, labelFn: (slug: string) => string) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {all.map((o) => (
          <label key={o.id} style={qualityCheckboxLabel(selected.includes(o.id))}>
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={() => onChange(toggleId(selected, o.id))}
              style={{ marginRight: 6 }}
            />
            {labelFn(o.slug)}
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
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Name *</label>
          <input
            ref={autoFocusRef}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Chicken"
            style={inlineInputStyle}
            autoFocus={!autoFocusRef}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Categories *</label>
          {renderCheckboxes(allCategories, form.categoryIds, (ids) => setForm({ ...form, categoryIds: ids }), categoryLabel)}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Nutritional Qualities</label>
          {renderCheckboxes(allQualities, form.qualityIds, (ids) => setForm({ ...form, qualityIds: ids }), qualityLabel)}
        </div>
        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 8px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnSmall('#888')}>Cancel</button>
          <button onClick={onSave} disabled={saving} style={btnSmall()}>{saving ? 'Saving…' : saveLabel}</button>
        </div>
      </div>
    );
  }

  const columns: Column<LibraryItem>[] = [
    { header: 'Name', render: (item) => <strong>{item.name}</strong> },
    {
      header: 'Categories',
      render: (item) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.categories.map((c) => <span key={c.id} style={categoryChipStyle}>{categoryLabel(c.slug)}</span>)}
        </div>
      ),
    },
    {
      header: 'Qualities',
      render: (item) => item.qualities.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.qualities.map((q) => <span key={q.id} style={qualityChipStyle}>{qualityLabel(q.slug)}</span>)}
        </div>
      ) : <span style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 13 }}>—</span>,
    },
    { header: 'Status', width: 100, render: (item) => <StatusBadge status={item.status} label={item.status} /> },
    {
      header: '', width: 40,
      render: (item) => item.status !== 'deleted' ? (
        <ContextMenu items={[
          { label: 'Details', onClick: () => toggleExpand(item.id) },
          { label: 'Edit', onClick: () => openInlineEdit(item) },
          { label: 'Delete', danger: true, onClick: () => setDeleting(item) },
        ]} />
      ) : null,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Base Nutrition Library</h1>
        <button style={btnStyle()} onClick={openInlineNew} disabled={creating}>+ New Item</button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name…"
          style={searchInputStyle}
        />
        <MultiSelectFilter
          label="Category"
          options={allCategories.map((c) => ({ value: String(c.id), label: categoryLabel(c.slug) }))}
          selected={categoryFilter}
          onChange={setCategoryFilter}
        />
        <MultiSelectFilter
          label="Nutrition Properties"
          options={allQualities.map((q) => ({ value: String(q.id), label: qualityLabel(q.slug) }))}
          selected={qualityFilter}
          onChange={setQualityFilter}
        />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          Show deleted
        </label>
        {activeFilterCount > 0 && (
          <button onClick={clearFilters} style={{ ...btnStyle('#888'), padding: '8px 14px' }}>Clear filters</button>
        )}
      </div>

      {creating && (
        <div style={cardStyle(true)}>
          {renderInlineForm(newForm, setNewForm, newError, newSaving, () => setCreating(false), saveInlineNew, 'Create', newNameRef)}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        loading={loading}
        loadingText="Loading…"
        emptyText="No food items match your filters."
        renderExpanded={(item) => (
          editingId === item.id ? (
            renderInlineForm(editForm, setEditForm, editError, editSaving, cancelEdit, () => handleInlineSave(item), 'Save')
          ) : (
            <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <DetailRow label="Categories" value={item.categories.length > 0 ? item.categories.map((c) => categoryLabel(c.slug)).join(', ') : '—'} />
              <DetailRow label="Qualities" value={item.qualities.length > 0 ? item.qualities.map((q) => qualityLabel(q.slug)).join(', ') : 'None'} />
              <DetailRow label="Status" value={item.status} />
              <DetailRow label="Created At" value={new Date(item.created_at).toLocaleString()} />
              <DetailRow label="Modified At" value={item.modified_at ? new Date(item.modified_at).toLocaleString() : '—'} />
            </div>
          )
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(item) => toggleExpand(item.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#666' }}>{pageStart}–{pageEnd} of {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={btnStyle('#888')}>›</button>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete "${deleting?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
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
  background: 'var(--badge-bg, #eff6ff)',
  border: '1px solid var(--badge-border, #bfdbfe)',
  color: 'var(--badge-text, #1d4ed8)',
  borderRadius: 12,
  padding: '2px 10px',
  fontSize: 12,
  fontWeight: 500,
};

const categoryChipStyle: React.CSSProperties = {
  background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12,
  padding: '2px 10px', fontSize: 12, fontWeight: 500, color: '#15803d',
};

function qualityCheckboxLabel(checked: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    borderRadius: 12,
    border: `1px solid ${checked ? 'var(--badge-border, #bfdbfe)' : 'var(--card-border, #e5e7eb)'}`,
    background: checked ? 'var(--badge-bg, #eff6ff)' : 'transparent',
    color: checked ? 'var(--badge-text, #1d4ed8)' : 'inherit',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    userSelect: 'none',
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
