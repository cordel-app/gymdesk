'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { DataTable, Column } from '@/components/DataTable';
import { ImageUploadField } from '@/components/ImageUploadField';
import { NutritionItemReadOnlyView } from '@/components/nutritionLibrary/NutritionItemReadOnlyView';
import { NutritionItemDetailsModal } from '@/components/nutritionLibrary/NutritionItemDetailsModal';
import {
  NutritionItemFormValues,
  NutritionLibraryItemRow,
  emptyNutritionItemForm,
  toNutritionItemFormValues,
} from '@/components/nutritionLibrary/nutritionItemProfile';
import { btnStyle, btnSmall, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
// #947: the library is tabbed — Foods (this page's own body) and Nutrition Goals.
// Which tabs exist and their order are declared once, in `goalProfile.ts`, and
// shared with Cordel's Base library; the goal section is one component serving
// both pages, handed this page's API root and its own namespace to resolve labels
// in. #948 moved **Personal Goals** out of the strip to its own section
// (`/{locale}/personal-goals`), which renders that very same component — a
// Personal Goal does not depend on Nutrition and is a different entity (§8).
import { LibraryTabs } from '@/components/goalLibrary/LibraryTabs';
import { GoalLibrarySection } from '@/components/goalLibrary/GoalLibrarySection';
import { LibraryTabId, isGoalTab } from '@/components/goalLibrary/goalProfile';
import { formHelpTextStyle, inlineActionsRowStyle } from '@/components/formChrome';

interface Category { id: number; slug: string }
interface NutritionalQuality { id: number; slug: string }

/**
 * A row as `GET /nutrition-library` returns it. The field set — including
 * `description` and the audit snapshot the Details modal shows — is declared once
 * in `nutritionItemProfile.ts` and shared with the Base library page (#799 §26).
 */
type LibraryItem = NutritionLibraryItemRow;

interface ListResponse {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
}

/** What `⋮ → Edit` manages — the shared declaration, not a second field list. */
type EditForm = NutritionItemFormValues;

const emptyEditForm = emptyNutritionItemForm;

const LIMIT = 20;

export default function NutritionLibraryPage() {
  const t = useTranslations();
  // The goal tab's labels live in their own namespace, shared with Cordel's Base
  // library and with both Personal Goals sections, so the same section cannot read
  // one way on one page and another on the other (#806).
  const tGoals = useTranslations('goal_library');
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  // #613: impersonation-aware (superadmins included); read-only roles see controls disabled.
  const { canWrite, readOnlyTitle } = useModuleAccess('NUTRITION');

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

  // Which library tab is open. Deliberately page state rather than a route: §6
  // asks for the content and actions to change without navigating away, and the
  // Foods list this page has already loaded survives a round trip to a goals tab.
  const [tab, setTab] = useState<LibraryTabId>('foods');

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
          description: newForm.description.trim(),
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
    // The one persisted-row → form-values mapping, shared with the read-only
    // view's field set (#799 §26). It seeds `name` (the base value), never
    // `display_name` — editing in Spanish must not overwrite the English original.
    setEditForm(toNutritionItemFormValues(item));
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
          description: editForm.description.trim(),
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
    /**
     * The food this form is editing, or `null` while it is creating one. #1035
     * made a food's image an object keyed by the row's own id and name
     * (`nutrition/<food_id>-<name>.<ext>`), so there is nothing to upload against
     * until the row exists — the create form says so instead of offering a
     * control, exactly as Cordel's Base library already does.
     */
    itemId: number | null,
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
            <label style={inlineLabelStyle}>{t('nutrition_library.label_media')}</label>
            {/* #799 §17: uploading, replacing and removing the image happens here
                and nowhere else — the expanded card shows it read-only. The path
                is the food's own since #1035, because the key carries its id and
                name. */}
            {itemId === null ? (
              <p style={formHelpTextStyle}>{t('nutrition_library.image_after_create')}</p>
            ) : (
              <ImageUploadField
                uploadPath={`/nutrition-library/${itemId}/image`}
                value={form.imageUrl}
                onChange={(url) => setForm({ ...form, imageUrl: url })}
              />
            )}
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>{t('nutrition_library.label_description')}</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('nutrition_library.description_placeholder')}
            rows={3}
            style={{ ...inlineInputStyle, resize: 'vertical' }}
          />
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
        <div style={inlineActionsRowStyle}>
          <button onClick={onCancel} style={btnSmall('#888')}>{t('nutrition_library.cancel')}</button>
          <button onClick={onSave} disabled={saving} style={btnSmall()}>
            {saving ? t('nutrition_library.saving') : saveLabel}
          </button>
        </div>
      </div>
    );
  }

  const columns: Column<LibraryItem>[] = [
    { header: t('nutrition_library.label_name'), mobile: 'name', title: (item) => item.display_name ?? item.name, render: (item) => <strong>{item.display_name ?? item.name}</strong> },
    {
      header: t('nutrition_library.label_categories'),
      mobile: 'secondary',
      render: (item) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.categories.map((c) => <span key={c.id} style={categoryChipStyle}>{categoryLabel(c.slug)}</span>)}
        </div>
      ),
    },
    {
      header: t('nutrition_library.nutritional_qualities_label'),
      mobile: 'secondary',
      render: (item) => item.qualities.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {item.qualities.map((q) => <span key={q.id} style={qualityChipStyle}>{qualityLabel(q.slug)}</span>)}
        </div>
      ) : <span style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 13 }}>—</span>,
    },
    {
      header: '', width: 120, mobile: 'secondary',
      render: (item) => item.gym_id === null
        ? <span style={{ fontSize: 12, color: '#888' }}>{t('nutrition_library.read_only')}</span>
        : null,
    },
    {
      header: '', width: 40, mobile: 'actions',
      render: (item) => {
        const isGymItem = item.gym_id !== null;
        return (
          <ContextMenu items={[
            // #799 §8: Details is the read-only modal (audit information), Edit the
            // form. Expanding the row is a third, separate interaction.
            { label: t('nutrition_library.details'), onClick: () => setDetailItem(item) },
            ...(isGymItem ? [{ label: t('nutrition_library.edit'), onClick: () => openInlineEdit(item), disabled: !canWrite, title: readOnlyTitle }] : []),
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
        {/* The Foods tab's own `+ Add` (§7). The goals tab renders its own, which
            is why this one is absent rather than relabelled while it is open. */}
        {tab === 'foods' && (
          <button style={readOnlyStyle(btnStyle(), !canWrite)} onClick={openInlineNew} disabled={!canWrite || creating} title={readOnlyTitle}>{t('nutrition_library.add_new')}</button>
        )}
      </div>

      <LibraryTabs active={tab} onChange={setTab} label={(key) => tGoals(key as any)} />

      {/* The Nutrition Goals tab. Personal Goals is its own section since #948,
          rendering this same component with `kind="personal"`. */}
      {isGoalTab(tab) && (
        <GoalLibrarySection
          kind={tab}
          scope="gym"
          canWrite={canWrite}
          readOnlyTitle={readOnlyTitle}
          label={(key) => tGoals(key as any)}
          ready={!!activeGymId}
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
          {renderInlineForm(newForm, setNewForm, newError, newSaving, cancelInlineNew, saveInlineNew, t('nutrition_library.create'), null, newNameRef)}
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
            renderInlineForm(editForm, setEditForm, editError, editSaving, cancelEdit, () => handleInlineSave(item), t('nutrition_library.save'), item.id)
          ) : (
            /* #799 §1–§7: expanding reads. The complete item, strictly read-only,
               with no image control and no Edit affordance — `⋮ → Edit` is the only
               way in. Audit information lives in `⋮ → Details`, not here. */
            <NutritionItemReadOnlyView
              item={item}
              allCategories={allCategories}
              allQualities={allQualities}
              extraRows={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #888)' }}>
                    {t('nutrition_library.ownership')}
                  </span>
                  <span>{item.gym_id === null ? t('nutrition_library.ownership_base') : t('nutrition_library.ownership_gym')}</span>
                </div>
              }
            />
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

      {detailItem && (
        <NutritionItemDetailsModal item={detailItem} onClose={() => setDetailItem(null)} />
      )}
      </>
      )}
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
