'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { btnStyle } from '@/components/ui';
// #969 stage 2: the Import modal is the second of the ticket's three screens, so
// it renders the *same* toolbar over the *same* filter-state declaration as the
// two list pages (§19) rather than its own name box and single muscle select.
import { ExerciseFilterBar, type ExerciseFacetOptions } from '@/components/exercises/ExerciseFilterBar';
import { EMPTY_EXERCISE_FILTER, exerciseFilterQuery, type ExerciseFilterState } from '@/lib/exerciseFilters';

/**
 * #718: Import Exercises — pick Base Exercises from the platform library and
 * import the selection in one request (`POST /exercises/import`).
 *
 * Every filter is server-side (`GET /exercises/base`), so the library is never
 * pulled into the browser to be filtered here, and "Select all matching" means
 * exactly the rows the server returned for the current filters. Selection is
 * keyed by base exercise id and lives outside the fetched list, so changing a
 * filter never drops what is already ticked.
 *
 * Since #969 the filters are the catalogue toolbar every exercise screen wears
 * — name/translation, slug, muscles (multi-select, Any/All, Primary/Secondary)
 * and the metadata facets — and the Status control is deliberately **not**
 * offered: this list is `status = 'active'` by definition, since an inactive
 * Base Exercise is not importable at all.
 */

interface BaseMuscle { key: string; role: 'principal' | 'secondary' }

export interface BaseExercise {
  id: number;
  name: string;
  /** #967: the Base Exercise's name in the gym admin's language (base name as the fallback). */
  display_name?: string | null;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
  muscles: BaseMuscle[] | null;
  /** The gym's own copy, when it already has one — such a row can't be imported again. */
  imported_exercise_id: number | null;
  /**
   * #719 §12: the gym already has this one, but re-importing would restore
   * System media its copy no longer carries. The server decides this — the
   * modal never compares URLs itself, and never resolves System-vs-gym media.
   */
  media_refreshable: boolean;
}

interface ImportResult {
  imported: { id: number }[];
  refreshed: { id: number; exercise_id: number }[];
  skipped: { id: number; name: string; reason: string }[];
}

interface Props {
  open: boolean;
  /** Muscle keys of the static catalog (`GET /muscles`), for the Muscle filter. */
  muscleKeys: string[];
  muscleLabel: (key: string) => string;
  onCancel: () => void;
  /** Called after a successful import so the page can refresh and toast. */
  onImported: (result: ImportResult) => void;
}

export function ImportExercisesModal({ open, muscleKeys, muscleLabel, onCancel, onImported }: Props) {
  const t = useTranslations('exercises');
  const { apiFetch } = useApiClient();

  const [filter, setFilter] = useState<ExerciseFilterState>(EMPTY_EXERCISE_FILTER);
  // What the metadata dropdowns offer and the unfiltered library total (§8, §9,
  // §14), read from the library's own gym-facing facets route.
  const [facets, setFacets] = useState<ExerciseFacetOptions | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [rows, setRows] = useState<BaseExercise[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against out-of-order responses: a slow unfiltered request must not
  // land after a faster filtered one and show the wrong list (same reason as
  // ImpersonationDialog's searchSeq).
  const loadSeq = useRef(0);

  const load = useCallback(async (current: ExerciseFilterState) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const result = await apiFetch<BaseExercise[]>(`/exercises/base${exerciseFilterQuery(current)}`);
      if (seq !== loadSeq.current) return;
      setRows(result);
      setError(null);
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      setRows([]);
      setError(err.message ?? t('error_generic'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [apiFetch, t]);

  // §9: opening the modal always starts from a fresh selection and no filters.
  useEffect(() => {
    if (!open) return;
    setFilter({ ...EMPTY_EXERCISE_FILTER });
    setSelected(new Set());
    setError(null);
  }, [open]);

  // One effect drives every fetch, debounced because the toolbar's text fields
  // change on every keystroke (#969 §17) — the same 250ms the two list pages use.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => load(filter), 250);
    return () => clearTimeout(timer);
  }, [open, filter, load]);

  // The facets and the library total do not depend on the current filter, so
  // they are read once per opening rather than per keystroke.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ total: number; equipment: string[]; category: string[] }>('/exercises/base/facets');
        if (cancelled) return;
        setFacets({ equipment: res.equipment ?? [], category: res.category ?? [] });
        setTotal(res.total ?? null);
      } catch { /* non-critical: the toolbar simply offers no metadata filter */ }
    })();
    return () => { cancelled = true; };
  }, [open, apiFetch]);

  if (!open) return null;

  const importable = rows.filter((r) => r.imported_exercise_id == null);
  // §12: a row the gym already has is selectable only when re-importing would
  // actually restore System media onto its copy.
  const refreshable = rows.filter((r) => r.imported_exercise_id != null && r.media_refreshable);
  const selectableIds = new Set([...importable, ...refreshable].map((r) => r.id));
  const allMatchingSelected = importable.length > 0 && importable.every((r) => selected.has(r.id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /**
   * §6: applies to the current filtered result set only — never to rows the
   * filters exclude, and never to an exercise the gym already has. When every
   * matching row is already ticked the same control clears them again.
   *
   * Deliberately **not** extended to the re-importable rows (#719 §12): a
   * re-import overwrites media the gym may have uploaded itself, so it is ticked
   * one row at a time rather than swept up by a bulk control.
   */
  function toggleAllMatching() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of importable) {
        if (allMatchingSelected) next.delete(row.id); else next.add(row.id);
      }
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const result = await apiFetch<ImportResult>('/exercises/import', {
        method: 'POST',
        body: JSON.stringify({ baseExerciseIds: Array.from(selected) }),
      });
      onImported(result);
    } catch (err: any) {
      // §8: an API error keeps the modal open with the selection intact.
      setError(err.message ?? t('error_generic'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !importing) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 60,
      }}
    >
      <div style={{
        background: 'var(--gd-card-bg, #ffffff)', borderRadius: 12,
        width: '100%', maxWidth: 720, maxHeight: '80vh',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 22px 12px' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('import_modal_title')}</h2>
        </div>

        {/* §19: the catalogue toolbar, not a second filtering UX. A Base
            Exercise carries a slug, so §4's field is offered here as it is on
            Base Exercises; Status is not, because the library is active-only. */}
        <div style={{ padding: '0 22px' }}>
          <ExerciseFilterBar
            value={filter}
            onChange={setFilter}
            muscleKeys={muscleKeys}
            muscleLabel={muscleLabel}
            facets={facets}
            autoFocusSearch
            shown={rows.length}
            total={total}
          />
        </div>

        <div style={{ padding: '0 22px 10px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={toggleAllMatching}
            disabled={importable.length === 0 || importing}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: importable.length === 0 ? 'not-allowed' : 'pointer',
              color: 'var(--brand, #6c63ff)', fontSize: 13, fontWeight: 600,
              opacity: importable.length === 0 ? 0.45 : 1,
            }}
          >
            {allMatchingSelected ? t('import_clear_all_matching') : t('import_select_all_matching')}
          </button>
          <span style={{ fontSize: 13, color: '#777' }}>
            {t('import_available_count', { n: importable.length })}
          </span>
          {refreshable.length > 0 && (
            <span style={{ fontSize: 13, color: '#8a5a00' }}>
              {t('import_media_update_count', { n: refreshable.length })}
            </span>
          )}
          <span style={{ fontSize: 13, color: '#777' }}>
            {t('import_selected_count', { n: selected.size })}
          </span>
        </div>

        <div style={{ overflowY: 'auto', padding: '0 22px', flex: 1 }}>
          {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>}
          {!loading && rows.length === 0 && (
            <p style={{ color: '#888', fontSize: 14 }}>{t('import_empty')}</p>
          )}
          {!loading && rows.map((row) => {
            const alreadyImported = row.imported_exercise_id != null;
            const selectable = selectableIds.has(row.id);
            const mediaUpdate = alreadyImported && row.media_refreshable;
            const principal = (row.muscles ?? []).filter((m) => m.role === 'principal').map((m) => muscleLabel(m.key)).join(', ');
            return (
              <label
                key={row.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                  borderBottom: '1px solid var(--gd-card-border, #eee)',
                  cursor: selectable ? 'pointer' : 'default',
                  opacity: selectable ? 1 : 0.6,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  disabled={!selectable || importing}
                  onChange={() => toggle(row.id)}
                />
                {/* #967 §7: the library is searched across every translation and
                    listed in the reader's own language. */}
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{row.display_name ?? row.name}</span>
                {principal && <span style={{ fontSize: 12, color: '#777' }}>{principal}</span>}
                {mediaUpdate && (
                  <span
                    title={t('import_media_update_hint')}
                    style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#fdf3e0', color: '#8a5a00' }}
                  >
                    {t('import_media_update')}
                  </span>
                )}
                {alreadyImported && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#e8f4fd', color: '#1a6da8' }}>
                    {t('type_system_sourced')}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        {error && <p style={{ color: '#c0392b', margin: 0, padding: '10px 22px 0', fontSize: 14 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '16px 22px 20px' }}>
          {/*
            * #803 §5: Cancel read as disabled because `#aaa` behind white text is
            * barely 2.3:1 — the same washed-out grey the Import button wears at
            * `opacity: 0.45` when nothing is selected. It now uses the `#444` of
            * ExerciseDetailModal's own Cancel, so the two exercise modals agree and
            * no new colour enters the page, and it stays enabled however few rows
            * the filters matched: Cancel never depended on the selection.
            *
            * It is still disabled *while an import runs* — that is §6's "import
            * loading state", unchanged: the request is in flight, closing the modal
            * would drop the refresh and the toast without stopping the POST, and the
            * overlay click is guarded the same way. The opacity is what that state
            * was missing, so the one moment Cancel really is inert now looks it.
            */}
          <button
            onClick={onCancel}
            disabled={importing}
            style={{ ...btnStyle('#444'), opacity: importing ? 0.45 : 1, cursor: importing ? 'not-allowed' : 'pointer' }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            style={{ ...btnStyle(), opacity: importing || selected.size === 0 ? 0.45 : 1 }}
          >
            {importing ? t('import_importing') : t('import')}
          </button>
        </div>
      </div>
    </div>
  );
}
