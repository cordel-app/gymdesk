'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { localeLabel as localeLabelFor } from '@/lib/localeLabels';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { NutritionItemReadOnlyView } from '@/components/nutritionLibrary/NutritionItemReadOnlyView';
import { NutritionItemDetailsModal } from '@/components/nutritionLibrary/NutritionItemDetailsModal';
import {
  NutritionItemFormValues,
  NutritionLibraryItemRow,
  emptyNutritionItemForm,
  toNutritionItemFormValues,
} from '@/components/nutritionLibrary/nutritionItemProfile';
import { btnStyle, btnSmall, cardSurfaceStyle } from '@/components/ui';
// #947: the Base library is three tabs too, and they are the same three — the tab
// declaration and the goal sections are shared with the gym-facing library, so the
// pair cannot drift (§2). What this page supplies is the platform context: the
// `/platform` router roots and their superadmin permissions.
import { LibraryTabs } from '@/components/goalLibrary/LibraryTabs';
import { GoalLibrarySection } from '@/components/goalLibrary/GoalLibrarySection';
import { LibraryTabId, isGoalTab } from '@/components/goalLibrary/goalProfile';

interface Category { id: number; slug: string }
interface NutritionalQuality { id: number; slug: string }

/**
 * A row as `GET /platform/nutrition-library` returns it. The field set — the
 * description and the audit snapshot included — is declared once in
 * `nutritionItemProfile.ts` and shared with the gym-facing library (#799 §26).
 *
 * `image_url` is the Cloudflare URL of this food's image, or null (#715): for a
 * base food the object behind it lives in `cordel/nutrition/`, the column is the
 * same one gym-owned items use, and the row's ownership decides the folder.
 */
type LibraryItem = NutritionLibraryItemRow;

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

/** What `⋮ → Edit` manages — the shared declaration, not a second field list. */
type EditForm = NutritionItemFormValues;

const emptyEditForm = emptyNutritionItemForm;

/**
 * #967 moved the language names into `lib/localeLabels.ts`, so the Nutrition
 * Library's translation inputs and the Exercises editor's cannot label the same
 * locale two ways — and the labels are translated now rather than English in
 * every language.
 */

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
  // The goal tab's labels live in their own namespace, shared with the gym-facing
  // library and with both Personal Goals sections (#948). The Foods half of this
  // page is still hardcoded English (it is a superadmin screen and was written that
  // way); the goal section is not, because it is the very same component the gym's
  // library renders.
  const tGoals = useTranslations('goal_library');
  const tCommon = useTranslations();
  // #967: the language names come from `lib/localeLabels.ts`, translated, rather
  // than from a map in this file.
  const localeLabel = (loc: string) => localeLabelFor(loc, (key) => tCommon(key as any));
  const { apiFetch } = useApiClient();
  const { getToken } = useAuth();
  const { toast } = useToast();

  // Which library tab is open — page state, not a route (§6).
  const [tab, setTab] = useState<LibraryTabId>('foods');

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

  // `⋮ → Details` — the read-only modal (#799 §9). It renders the list row it is
  // given, so nothing is fetched and nothing can disagree with the expanded card.
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);

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
          description: newForm.description.trim(),
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
    // The one persisted-row → form-values mapping, shared with the read-only
    // view's field set (#799 §26). It seeds the base name, never `display_name` —
    // editing in Spanish must not overwrite the English value the translations
    // hang off (#643).
    setEditForm(toNutritionItemFormValues(item));
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
          description: editForm.description.trim(),
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
    /**
     * The food being edited, or null while creating one. The Media section needs
     * it: `POST /platform/nutrition-library/:id/image` uploads against an existing
     * row, so a food that does not exist yet has nothing to upload to.
     */
    item?: LibraryItem | null,
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
          <label style={inlineLabelStyle}>Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional notes about this food"
            rows={3}
            style={{ ...inlineInputStyle, resize: 'vertical' }}
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
        {/* #799 §17: the image is uploaded and replaced here — the expanded card
            shows it read-only. The upload posts against an existing row, so while
            creating a food there is only the hint. */}
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Media</label>
          {item ? (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={imageFrameStyle}>
                {item.image_url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
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
                  type="button"
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
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
              Create the food first, then upload its {IMAGE_SIZE}×{IMAGE_SIZE} PNG image from Edit.
            </p>
          )}
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
      // #799 §8: Details is the read-only modal (audit information), Edit the form.
      // Expanding the row is a third, separate interaction.
      //
      // A deleted food keeps Details — that is where Deleted At / Deleted By are
      // shown (§13), and it is the one item whose deletion there is something to
      // read. Edit and Delete stay hidden for it, as they were.
      render: (item) => (
        <ContextMenu items={[
          { label: 'Details', onClick: () => setDetailItem(item) },
          ...(item.status !== 'deleted' ? [
            { label: 'Edit', onClick: () => openInlineEdit(item) },
            { label: 'Delete', danger: true, onClick: () => setDeleting(item) },
          ] : []),
        ]} />
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Base Nutrition Library</h1>
        {/* The Foods tab's own `+ Add`; the goals tab renders its own (§7). */}
        {tab === 'foods' && (
          <button style={btnStyle()} onClick={openInlineNew} disabled={creating}>+ New Item</button>
        )}
      </div>

      <LibraryTabs active={tab} onChange={setTab} label={(key) => tGoals(key as any)} />

      {/* The Base Nutrition Goals tab. Base Personal Goals is its own Cordel
          section since #948 (§5), rendering this same component. */}
      {isGoalTab(tab) && (
        <GoalLibrarySection
          kind={tab}
          scope="platform"
          /* Every row here is the platform's and this page is `requireSuperadmin`
             on both sides, so there is no read-only role to gate against. */
          canWrite
          label={(key) => tGoals(key as any)}
        />
      )}

      {/* The Foods tab — this page's own body, left at its original indentation so
          the diff that wrapped it stays readable. */}
      {tab === 'foods' && (
      <>
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
            renderInlineForm(editForm, setEditForm, editError, editSaving, cancelEdit, () => handleInlineSave(item), 'Save', undefined, item)
          ) : (
            /* #799 §1–§7: expanding reads. The complete food, strictly read-only,
               with no image control and no Edit affordance — `⋮ → Edit` is the only
               way in. Audit information lives in `⋮ → Details`, not here. */
            <NutritionItemReadOnlyView
              item={item}
              allCategories={allCategories}
              allQualities={allQualities}
              locales={translatableLocales}
            />
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

      {detailItem && (
        <NutritionItemDetailsModal item={detailItem} scope="platform" onClose={() => setDetailItem(null)} />
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete "${deleting?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
      </>
      )}
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
