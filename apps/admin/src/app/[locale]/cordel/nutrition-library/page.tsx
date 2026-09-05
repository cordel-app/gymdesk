'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
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

const QUALITY_LABELS: Record<string, string> = {
  protein: 'Protein',
  carbohydrate: 'Carbohydrate',
};

function categoryLabel(cat: string) {
  return cat.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
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
  const [allQualities, setAllQualities] = useState<NutritionalQuality[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);

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

  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<Category>('main_dish');
  const [editQualityIds, setEditQualityIds] = useState<number[]>([]);

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
      for (const c of categoryFilter) params.append('category', c);
      for (const q of qualityFilter) params.append('quality_id', q);
      params.set('status', showDeleted ? 'deleted' : 'active');
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const [data, qualitiesData] = await Promise.all([
        apiFetch<ListResponse>(`/platform/nutrition-library?${params.toString()}`),
        allQualities.length ? Promise.resolve(allQualities) : apiFetch<NutritionalQuality[]>('/platform/nutrition-library/nutritional-qualities'),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setAllQualities(qualitiesData);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search, categoryFilter, qualityFilter, showDeleted, offset]);

  useEffect(() => { load(); }, [load]);

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

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/platform/nutrition-library', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), category: newCategory, quality_ids: newQualityIds }),
      });
      setCreating(false);
      setNewName('');
      setNewQualityIds([]);
      toast('Item created', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`/platform/nutrition-library/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), category: editCategory, quality_ids: editQualityIds }),
      });
      setEditing(null);
      toast('Item updated', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
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

  const columns: Column<LibraryItem>[] = [
    { header: 'Name', render: (item) => <strong>{item.name}</strong> },
    { header: 'Category', width: 140, render: (item) => categoryLabel(item.category) },
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
          {
            label: 'Edit',
            onClick: () => {
              setEditing(item);
              setEditName(item.name);
              setEditCategory(item.category as Category);
              setEditQualityIds(item.qualities.map((q) => q.id));
            },
          },
          { label: 'Delete', danger: true, onClick: () => setDeleting(item) },
        ]} />
      ) : null,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Base Nutrition Library</h1>
        <button style={btnStyle()} onClick={() => { setCreating(true); setNewName(''); setNewCategory('main_dish'); setNewQualityIds([]); }}>+ New Item</button>
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
          options={CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
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

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        loading={loading}
        loadingText="Loading…"
        emptyText="No food items match your filters."
        renderExpanded={(item) => (
          <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <DetailRow label="Category" value={categoryLabel(item.category)} />
            <DetailRow label="Status" value={item.status} />
            <DetailRow label="Created At" value={new Date(item.created_at).toLocaleString()} />
            <DetailRow label="Modified At" value={item.modified_at ? new Date(item.modified_at).toLocaleString() : '—'} />
          </div>
        )}
        expandedRowKeys={expanded}
        onToggleExpand={(item) => toggleExpand(item.id)}
      />

      {total > 0 && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#666' }}>{pageStart}–{pageEnd} of {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={btnStyle('#888')}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={btnStyle('#888')}>›</button>
        </div>
      )}

      {/* Create modal */}
      <CrudModal
        open={creating}
        title="New Library Item"
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Create"
      >
        <FormLabel>Name</FormLabel>
        <input
          className="form-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. Chicken"
          autoFocus
        />
        <FormLabel>Category</FormLabel>
        <select className="form-input" value={newCategory} onChange={(e) => setNewCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
        <FormLabel>Nutritional Qualities</FormLabel>
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

      {/* Edit modal */}
      <CrudModal
        open={editing !== null}
        title="Edit Library Item"
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Save"
      >
        <FormLabel>Name</FormLabel>
        <input
          className="form-input"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          autoFocus
        />
        <FormLabel>Category</FormLabel>
        <select className="form-input" value={editCategory} onChange={(e) => setEditCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
        <FormLabel>Nutritional Qualities</FormLabel>
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
