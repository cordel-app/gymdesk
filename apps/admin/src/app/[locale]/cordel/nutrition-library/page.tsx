'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { btnStyle, btnSmall, cardSurfaceStyle } from '@/components/ui';

interface Category { id: number; slug: string }
interface NutritionalQuality { id: number; slug: string }

interface LibraryItem {
  id: number;
  /** Base (English) name — what this page authors and what uniqueness applies to. */
  name: string;
  /** `name` resolved into the viewer's locale; equals `name` when untranslated. */
  display_name: string;
  /** Per-locale names, keyed by locale (#643). Absent locales fall back to `name`. */
  translations: Record<string, string>;
  status: 'active' | 'deleted';
  /**
   * Cloudflare URL of this food's image, or null (#715). For a base food the
   * object behind it always lives in `cordel/Nutrition/`; the column is the same
   * one gym-owned items use, and the row's ownership is what decides the folder.
   */
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

interface LocalesResponse {
  locales: string[];
  base_locale: string;
  translatable: string[];
}

interface EditForm {
  name: string;
  categoryIds: number[];
  qualityIds: number[];
  translations: Record<string, string>;
}

function emptyEditForm(): EditForm {
  return { name: '', categoryIds: [], qualityIds: [], translations: {} };
}

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  ca: 'Catalan',
};

function localeLabel(locale: string) {
  return LOCALE_LABELS[locale] ?? locale.toUpperCase();
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
  const { getToken } = useAuth();
  const { toast } = useToast();

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allQualities, setAllQualities] = useState<NutritionalQuality[]>([]);
  // Served by the API so the locale list isn't hardcoded a second time here.
  const [translatableLocales, setTranslatableLocales] = useState<string[]>([]);
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

  // Image upload (#715) — one item at a time, so a single ref and a single
  // error are enough. `uploadingId` doubles as the "which card is busy" flag.
  const [uploadingId, setUploadingId] = useState<number | null>(null);
  const [imageError, setImageError] = useState<{ id: number; message: string } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageTargetRef = useRef<LibraryItem | null>(null);

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
      const [data, categoriesData, qualitiesData, localesData] = await Promise.all([
        apiFetch<ListResponse>(`/platform/nutrition-library?${params.toString()}`),
        allCategories.length ? Promise.resolve(allCategories) : apiFetch<Category[]>('/platform/nutrition-library/categories'),
        allQualities.length ? Promise.resolve(allQualities) : apiFetch<NutritionalQuality[]>('/platform/nutrition-library/nutritional-qualities'),
        translatableLocales.length
          ? Promise.resolve({ translatable: translatableLocales } as LocalesResponse)
          : apiFetch<LocalesResponse>('/platform/nutrition-library/locales'),
      ]);
      setItems(data.items);
      setTotal(data.total);
      setAllCategories(categoriesData);
      setAllQualities(qualitiesData);
      setTranslatableLocales(localesData.translatable);
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
        body: JSON.stringify({
          name: newForm.name.trim(),
          category_ids: newForm.categoryIds,
          quality_ids: newForm.qualityIds,
          translations: trimmedTranslations(newForm.translations),
        }),
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
      // The base name, never `display_name` — editing in Spanish must not
      // overwrite the English value the translations hang off (#643).
      name: item.name,
      categoryIds: item.categories.map((c) => c.id),
      qualityIds: item.qualities.map((q) => q.id),
      translations: { ...item.translations },
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
        body: JSON.stringify({
          name: editForm.name.trim(),
          category_ids: editForm.categoryIds,
          quality_ids: editForm.qualityIds,
          translations: trimmedTranslations(editForm.translations),
        }),
      });
      setEditingId(null);
      toast('Item updated', 'success');
      load();
    } catch (e: any) {
      setEditError(e.message ?? 'Error');
    } finally { setEditSaving(false); }
  }

  // ─── Image upload (#715) ────────────────────────────────────────────────
  //
  // The picker is opened from the expanded card; the file it returns is checked
  // here for the two constraints a browser can see (a PNG, exactly 512×512) and
  // then posted as raw bytes to `POST /platform/nutrition-library/:id/image`.
  // The server validates the same things from the file's own bytes — this pass
  // exists to give a clear error before the upload, never instead of it.

  function openImagePicker(item: LibraryItem) {
    imageTargetRef.current = item;
    setImageError(null);
    if (imageInputRef.current) {
      // Cleared so picking the same file twice still fires `onChange`.
      imageInputRef.current.value = '';
      imageInputRef.current.click();
    }
  }

  /** `null` when the file is a 512×512 PNG, otherwise the reason it is not. */
  async function checkImageFile(file: File): Promise<string | null> {
    if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
      return 'Image must be a PNG file.';
    }
    const dimensions = await readImageDimensions(file);
    if (!dimensions) return 'That file could not be read as an image.';
    if (dimensions.width !== IMAGE_SIZE || dimensions.height !== IMAGE_SIZE) {
      return `Image must be exactly ${IMAGE_SIZE}×${IMAGE_SIZE} pixels (this one is ${dimensions.width}×${dimensions.height}).`;
    }
    return null;
  }

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const item = imageTargetRef.current;
    if (!file || !item) return;

    const problem = await checkImageFile(file);
    if (problem) {
      // Nothing is sent, so the existing image stays exactly as it is.
      setImageError({ id: item.id, message: problem });
      return;
    }

    setUploadingId(item.id);
    setImageError(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/proxy/platform/nutrition-library/${item.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: file,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? 'Image upload failed');
      }
      toast('Image updated', 'success');
      await load();
    } catch (err: any) {
      setImageError({ id: item.id, message: err.message ?? 'Image upload failed' });
    } finally {
      setUploadingId(null);
    }
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
        {translatableLocales.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={inlineLabelStyle}>Translations</label>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>
              Leave a language blank to fall back to the name above.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {translatableLocales.map((loc) => (
                <div key={loc} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 80, flexShrink: 0, fontSize: 12.5, color: '#555' }}>{localeLabel(loc)}</span>
                  <input
                    value={form.translations[loc] ?? ''}
                    onChange={(e) => setForm({ ...form, translations: { ...form.translations, [loc]: e.target.value } })}
                    placeholder={form.name ? `${form.name} in ${localeLabel(loc)}` : localeLabel(loc)}
                    style={inlineInputStyle}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
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
              {/* #715 — the food's image, shown only on the expanded card. The
                  collapsed row keeps its compact presentation. */}
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={imageFrameStyle}>
                  {item.image_url ? (
                    <img
                      // The key is deterministic, so a replacement reuses the
                      // URL — `modified_at` busts the browser's cache.
                      src={`${item.image_url}?v=${encodeURIComponent(item.modified_at ?? item.created_at)}`}
                      alt={item.name}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                    />
                  ) : (
                    <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>No image yet</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                  <button
                    onClick={() => openImagePicker(item)}
                    disabled={uploadingId === item.id}
                    style={btnSmall()}
                  >
                    {uploadingId === item.id ? 'Uploading…' : 'Upload Image'}
                  </button>
                  <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
                    Upload a {IMAGE_SIZE}×{IMAGE_SIZE} PNG image with a transparent background.
                  </p>
                  {imageError?.id === item.id && (
                    <p style={{ margin: 0, fontSize: 12.5, color: '#c0392b' }}>{imageError.message}</p>
                  )}
                </div>
              </div>
              {translatableLocales.map((loc) => (
                <DetailRow key={loc} label={localeLabel(loc)} value={item.translations[loc] ?? `${item.name} (untranslated)`} />
              ))}
              <DetailRow label="Categories" value={item.categories.length > 0 ? item.categories.map((c) => categoryLabel(c.slug)).join(', ') : '—'} />
              <DetailRow label="Qualities" value={item.qualities.length > 0 ? item.qualities.map((q) => qualityLabel(q.slug)).join(', ') : 'None'} />
              <DetailRow label="Status" value={item.status} />
              <DetailRow label="Created At" value={new Date(item.created_at).toLocaleString()} />
              <DetailRow label="Modified At" value={item.modified_at ? new Date(item.modified_at).toLocaleString() : '—'} />
              {/* #675: same deep link every Details view offers — filtered to this item. */}
              <div style={{ marginTop: 6 }}>
                <ViewAuditLogButton entityType="nutrition_library_item" entityId={item.id} scope="platform" size="small" />
              </div>
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

      {/* One picker for the page: `openImagePicker()` points it at a food. */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png"
        onChange={handleImageSelected}
        style={{ display: 'none' }}
      />

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

/**
 * Trim every locale and drop the blanks: an empty field means "no translation",
 * which the API stores as a missing row so the base name shows instead.
 */
function trimmedTranslations(translations: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [locale, name] of Object.entries(translations)) {
    const trimmed = (name ?? '').trim();
    if (trimmed) out[locale] = trimmed;
  }
  return out;
}

/**
 * The exact square every Base Nutrition Library image is (#715 §2). Declared
 * once: the picker's check, the hint the administrator reads and the frame the
 * image is drawn in all come from it.
 */
const IMAGE_SIZE = 512;

/**
 * Natural size of an image file, or null when the browser cannot decode it.
 * Used for the client-side half of the 512×512 check — the server repeats it
 * from the PNG's own IHDR, so a browser that fails here costs a clear error
 * rather than a wrong upload.
 */
async function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 120, flexShrink: 0, color: '#888' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * A 1:1 frame for the food image. The checkerboard is what makes a transparent
 * background legible as transparency rather than as white, and `objectFit:
 * contain` keeps the square undistorted whatever the frame's size.
 */
const imageFrameStyle: React.CSSProperties = {
  width: 160,
  height: 160,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%),'
    + ' linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

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
  ...cardSurfaceStyle,
  ...(highlighted ? { border: '1.5px solid #4b45c6' } : {}),
  overflow: 'hidden',
  marginBottom: 12,
});

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
