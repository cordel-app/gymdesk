'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable, Column } from '@/components/DataTable';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ExerciseVideoField } from '@/components/ExerciseVideoField';
import { cardSurfaceStyle, primaryBtnStyle } from '@/components/ui';
import type { PreparedExerciseImage } from '@/lib/exerciseImageUpload';
import type { PreparedExerciseVideo } from '@/lib/exerciseVideoUpload';
// #806: one Exercise editor, one form declaration, one form-state hook — the
// same ones the gym Exercises page renders. What this page supplies is the
// platform context: the `/platform/exercises` routes and their superadmin
// permissions, which are untouched (§6, AC4, AC5).
import { ExerciseEditor, ExerciseMediaPair, type ExerciseNameLocales } from '@/components/exercises/ExerciseEditor';
import { useExerciseEditorState, useMuscleLabel } from '@/components/exercises/useExerciseEditorState';
// #965: the expanded card is the editor's read-only counterpart, and `⋮ → Details`
// is the one place the technical metadata lives. Both are shared with the gym
// Exercises page for the reason the editor is (#806).
import { ExerciseReadOnlyView } from '@/components/exercises/ExerciseReadOnlyView';
import { ExerciseMediaPreview } from '@/components/exercises/ExerciseMediaPreview';
import { ExerciseDetailModal } from '@/components/exercises/ExerciseDetailModal';
// #969: the one exercise filter toolbar, over the one filter-state declaration.
// Both are shared with the gym Exercises page and the Import modal (§19).
import { ExerciseFilterBar, type ExerciseFacetOptions } from '@/components/exercises/ExerciseFilterBar';
import { EMPTY_EXERCISE_FILTER, exerciseFilterQuery, type ExerciseFilterState } from '@/lib/exerciseFilters';
import {
  formatExerciseDate,
  exerciseDisplayValue,
  toExerciseCreatePayload,
  toExerciseUpdatePayload,
  type MuscleRole,
  type ResultTypeRow,
} from '@/components/exercises/exerciseForm';

/** Where every persistence call on this page goes — the platform's own router. */
const API_BASE = '/platform/exercises';

interface Exercise {
  id: number;
  name: string;
  /** #967: the name in the administrator's language, resolved server-side. */
  display_name: string;
  /** #967: the stored per-locale names — what the editor seeds its inputs from. */
  translations: Record<string, string>;
  description: string | null;
  status: 'active' | 'inactive';
  /**
   * The 2048×2048 master (#716). For a base exercise the object behind it always
   * lives in `cordel/exercises/images/`; the column is the same one a gym-owned
   * exercise uses, and the row's ownership is what decides the folder.
   */
  image_url: string | null;
  /** Its 512×512 companion — what every card draws, so no master is downloaded (§4). */
  image_thumbnail_url: string | null;
  /**
   * The demonstration video (#717). An uploaded MP4 lives in
   * `cordel/exercises/videos/`; on a row that was never uploaded to, the same
   * column may still hold an external link (a YouTube URL), which is why the
   * card never assumes it can be played inline.
   */
  video_url: string | null;
  /** Its 512×512 poster — what the card draws, so no MP4 is downloaded (§9). */
  video_thumbnail_url: string | null;
  /** #806: the configuration defaults the shared editor has always written on a Gym Exercise. */
  min_reps_default: number | null;
  max_reps_default: number | null;
  sets_default: number | null;
  rest_default_seconds: number | null;
  notes_default: string | null;
  muscles: { key: string; role: MuscleRole }[] | null;
  allowed_result_types: ResultTypeRow[] | null;
  created_at: string;
  modified_at: string | null;
  /**
   * Who created and last changed it (#965, migration 208). A Base Exercise is a
   * `gym_id IS NULL` row written by a superadmin, who has no `gym_memberships`
   * row to join a name from, so the name is snapshotted at write time — a row
   * written before that migration carries NULL and reads as the em dash.
   */
  created_by_name: string | null;
  modified_by_name: string | null;
}

export default function CordelExercisesPage() {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  // #969: every filter the toolbar offers, applied server-side — ~900 Base
  // Exercises after the Free Exercise DB import are never narrowed in the
  // browser (§16/§17).
  const [filter, setFilter] = useState<ExerciseFilterState>(EMPTY_EXERCISE_FILTER);
  // What the Equipment and Category dropdowns offer, and the unfiltered total
  // `Showing 42 of 612` counts against (§8, §9, §14). The options are the values
  // present in the catalogue, so a facet that comes back empty renders no
  // control at all.
  const [facets, setFacets] = useState<ExerciseFacetOptions | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  // #806: the two catalogues the shared editor renders. They come from this
  // router's own `GET /platform/exercises/lookups` rather than the gym-facing
  // `/muscles` + `/result-types`, which sit behind a gym's module access and
  // feature flags — a platform screen must not depend on those.
  const [muscleKeys, setMuscleKeys] = useState<string[]>([]);
  const [resultTypes, setResultTypes] = useState<ResultTypeRow[]>([]);
  // #967 §3: and the languages a Base Exercise's name is entered in, which that
  // same read carries — no language list in this page either.
  const [nameLocales, setNameLocales] = useState<ExerciseNameLocales | null>(null);
  const muscleLabel = useMuscleLabel(muscleKeys);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline create / edit (#716 Q4, #806 §9: the card edits in place — no modal).
  const [creating, setCreating] = useState(false);
  const createState = useExerciseEditorState();
  const newNameRef = useRef<HTMLInputElement>(null);
  // #719's staging, one folder over: there is no exercise to upload to until the
  // creation call has returned, so the prepared pair waits here.
  const [stagedImage, setStagedImage] = useState<PreparedExerciseImage | null>(null);
  const [stagedVideo, setStagedVideo] = useState<PreparedExerciseVideo | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const editState = useExerciseEditorState();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [deleting, setDeleting] = useState<Exercise | null>(null);
  // #965 §11: `⋮ → Details` opens a modal over the row it was chosen on. It takes
  // the list row rather than re-reading the exercise, so the metadata it shows is
  // the metadata the list already carries.
  const [detailFor, setDetailFor] = useState<Exercise | null>(null);
  // Which exercise has a <video> mounted. Nothing is mounted until the
  // administrator asks to play one, so opening a card never downloads an MP4
  // (§9) — and only one plays at a time.
  const [playingId, setPlayingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await apiFetch<Exercise[]>(`${API_BASE}${exerciseFilterQuery(filter)}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, filter]);

  // A short debounce, because the toolbar's text fields change on every
  // keystroke and this catalogue is ~900 rows (§17). The mutation paths call
  // `load()` directly and are unaffected.
  useEffect(() => {
    const handle = setTimeout(load, 250);
    return () => clearTimeout(handle);
  }, [load]);

  /**
   * The facets and the total, re-read when the catalogue itself may have moved
   * (a create, an edit or a delete) rather than on every keystroke — they
   * describe the whole catalogue and do not depend on the current filter.
   */
  const loadFacets = useCallback(async () => {
    try {
      const res = await apiFetch<{ total: number; equipment: string[]; category: string[] }>(`${API_BASE}/facets`);
      setFacets({ equipment: res.equipment ?? [], category: res.category ?? [] });
      setTotal(res.total ?? null);
    } catch { /* non-critical: the toolbar simply offers no metadata filter */ }
  }, [apiFetch]);

  useEffect(() => { loadFacets(); }, [loadFacets]);

  useEffect(() => {
    (async () => {
      try {
        const lookups = await apiFetch<{
          muscles: { key: string }[];
          result_types: ResultTypeRow[];
          base_locale: string;
          translatable: string[];
        }>(`${API_BASE}/lookups`);
        setMuscleKeys(lookups.muscles.map((m) => m.key));
        setResultTypes(lookups.result_types);
        setNameLocales({ base: lookups.base_locale, translatable: lookups.translatable });
      } catch { /* non-critical */ }
    })();
  }, [apiFetch]);

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** The exercise as the media routes returned it, applied in place (#719). */
  function applyExerciseUpdate(updated: Exercise) {
    if (!updated?.id) return;
    setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
  }

  // ─── Inline create (#806 §10) ────────────────────────────────────────────

  function openInlineNew() {
    createState.reset(null);
    setStagedImage(null);
    setStagedVideo(null);
    setCreating(true);
    setTimeout(() => newNameRef.current?.focus(), 60);
  }

  /** Cancel discards the unsaved form state and calls no API. */
  function closeInlineNew() {
    setCreating(false);
    createState.reset(null);
    setStagedImage(null);
    setStagedVideo(null);
  }

  async function saveInlineNew() {
    const saved = await createState.submit(async () => {
      const created = await apiFetch<Exercise>(API_BASE, {
        method: 'POST',
        body: JSON.stringify(toExerciseCreatePayload(createState.form, createState.extras)),
      });
      // A failed media upload leaves the exercise created and says so, rather
      // than discarding an exercise that already exists (#719's rule).
      if (stagedImage) {
        try {
          await apiFetch(`${API_BASE}/${created.id}/image`, { method: 'POST', body: JSON.stringify(stagedImage) });
        } catch (err: any) {
          toast(err.message ?? t('image_error_upload_failed'));
        }
      }
      if (stagedVideo) {
        try {
          await apiFetch(`${API_BASE}/${created.id}/video`, { method: 'POST', body: JSON.stringify(stagedVideo) });
        } catch (err: any) {
          toast(err.message ?? t('video_error_upload_failed'));
        }
      }
    });
    if (!saved) return;
    closeInlineNew();
    toast('Exercise created', 'success');
    load();
    loadFacets();
  }

  // ─── Inline edit ─────────────────────────────────────────────────────────

  function openInlineEdit(exercise: Exercise) {
    setEditingId(exercise.id);
    editState.reset(exercise);
    setExpanded((prev) => new Set(prev).add(exercise.id));
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  function cancelEdit() {
    setEditingId(null);
    editState.setError(null);
  }

  async function saveInlineEdit(exercise: Exercise) {
    const saved = await editState.submit(async () => {
      // #717 Q6: `toExerciseUpdatePayload` omits `video_url` — the editor's
      // upload control writes the reference and its poster together.
      await apiFetch(`${API_BASE}/${exercise.id}`, {
        method: 'PUT',
        body: JSON.stringify(toExerciseUpdatePayload(editState.form, editState.extras)),
      });
    });
    if (!saved) return;
    setEditingId(null);
    toast('Exercise updated', 'success');
    load();
    loadFacets();
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${API_BASE}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Exercise deleted', 'success');
      load();
      loadFacets();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  /**
   * The Media section of the editor (#806 §7): the same two controls the gym
   * Exercises page renders, pointed at this router.
   *
   * `requiresGymStorage={false}` because a Base Exercise's objects go to the
   * platform's own folder (`cordel/Exercises/…`) — the superadmin's currently
   * selected gym and its bucket have nothing to do with them.
   *
   * With no exercise (the creation card) both controls stage their prepared pair
   * for `saveInlineNew()` to upload; with one they act on it directly, so
   * cancelling the editor neither undoes an upload nor re-applies a removal.
   */
  function renderEditorMedia(exercise: Exercise | null) {
    return (
      <ExerciseMediaPair
        image={<ExerciseImageField
          basePath={API_BASE}
          requiresGymStorage={false}
          exerciseId={exercise?.id ?? null}
          imageUrl={exercise?.image_url ?? null}
          thumbnailUrl={exercise?.image_thumbnail_url ?? null}
          onChanged={exercise ? (updated) => applyExerciseUpdate(updated as Exercise) : undefined}
          onStaged={exercise ? undefined : setStagedImage}
        />}
        video={<ExerciseVideoField
          basePath={API_BASE}
          requiresGymStorage={false}
          exerciseId={exercise?.id ?? null}
          videoUrl={exercise?.video_url ?? null}
          posterUrl={exercise?.video_thumbnail_url ?? null}
          onChanged={exercise ? (updated) => {
            // A replacement reuses the same key, so a player left open would
            // keep showing the old bytes from cache.
            setPlayingId(null);
            applyExerciseUpdate(updated as Exercise);
          } : undefined}
          onStaged={exercise ? undefined : setStagedVideo}
        />}
      />
    );
  }

  /**
   * The read-only body of an expanded card (#965): the editor's own five
   * sections, with the controls replaced by values.
   *
   * It is `ExerciseReadOnlyView` and nothing else — the section order, the field
   * set and the chrome are the editor's, so the two halves of the card cannot
   * drift (§14, §15). Since #965 it carries **no** technical metadata and **no**
   * Audit Log link: Created At, Modified At and the internal id moved into
   * `⋮ → Details`, which is the one place that reports them (§9, §10, §13).
   *
   * It reads the same list row the editor is seeded from — never a second fetch
   * and never a second field list (#797's rule).
   */
  function renderReadOnly(exercise: Exercise) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <ExerciseReadOnlyView
          exercise={exercise}
          muscleKeys={muscleKeys}
          muscleLabel={muscleLabel}
          resultTypes={resultTypes}
          media={
            <ExerciseMediaPreview
              exercise={exercise}
              playing={playingId === exercise.id}
              onPlay={() => setPlayingId(exercise.id)}
            />
          }
        />
      </div>
    );
  }

  // #965 §1: the collapsed header is the concise summary — name, the description
  // beside it, when it was created and by whom, and its status. Everything else
  // about the exercise is one click away in the expanded body, and the technical
  // metadata is in `⋮ → Details`. The column order is the gym Exercises list's, so
  // the same entity reads the same way on both screens.
  const columns: Column<Exercise>[] = [
    // #967 §6: the list shows the name in the application's language.
    { header: t('col_name'), mobile: 'name', title: (row) => row.display_name ?? row.name, render: (row) => <strong>{row.display_name ?? row.name}</strong> },
    {
      header: t('col_description'),
      mobile: 'secondary',
      render: (row) => row.description
        ? <span style={{ color: '#666' }}>{row.description}</span>
        : <span style={{ color: 'var(--text-muted, #9ca3af)' }}>—</span>,
    },
    { header: t('col_created_at'), width: 120, mobile: 'secondary', render: (row) => <span style={{ color: '#888' }}>{formatExerciseDate(row.created_at)}</span> },
    {
      header: t('col_created_by'), width: 150, mobile: 'secondary',
      render: (row) => <span style={{ color: '#555' }}>{exerciseDisplayValue(row.created_by_name)}</span>,
    },
    { header: t('col_status'), width: 100, mobile: 'keep', render: (row) => <StatusBadge status={row.status} label={tStatus(row.status)} /> },
    {
      header: '', width: 40, mobile: 'actions',
      render: (row) => (
        <ContextMenu items={[
          // §11: Details is the modal, not a second way to expand the row — the
          // chevron is what reads the configuration.
          { label: t('details'), onClick: () => setDetailFor(row) },
          { label: t('edit'), onClick: () => openInlineEdit(row) },
          { label: t('delete'), danger: true, onClick: () => setDeleting(row) },
        ]} />
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Base Exercises</h1>
        {/* #968: a primary action takes the Theme's Primary Button pair. `btnStyle()`
            with no argument resolves to `--brand`, which `applyTokens` maps to
            sidebarSelectedItemBackground — the sidebar's colour, not an action's —
            so this button did not follow the Theme the gym Exercises page's
            `+ Add Exercise` already followed. */}
        <button style={primaryBtnStyle()} onClick={openInlineNew} disabled={creating}>+ New Exercise</button>
      </div>

      {/* #969 §2: the search box that used to sit alone beside the title is now
          one field of the shared toolbar, and the results start directly below
          it. The Base Exercises catalogue is the one context that carries both a
          slug (§4) and the source metadata facets (§8/§9). */}
      <ExerciseFilterBar
        value={filter}
        onChange={setFilter}
        muscleKeys={muscleKeys}
        muscleLabel={muscleLabel}
        facets={facets}
        showStatus
        shown={rows.length}
        total={total}
      />

      {creating && (
        <div style={cardStyle}>
          <div style={{ padding: '16px 20px' }}>
            <p style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('new_exercise')}</p>
            <ExerciseEditor
              mode="create"
              idPrefix="base-exercise-new"
              state={createState}
              nameLocales={nameLocales}
              muscleKeys={muscleKeys}
              muscleLabel={muscleLabel}
              resultTypes={resultTypes}
              nameRef={newNameRef}
              media={renderEditorMedia(null)}
              onCancel={closeInlineNew}
              onSave={saveInlineNew}
            />
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText="No base exercises yet."
        renderExpanded={(row) => (
          editingId === row.id ? (
            <div style={{ padding: '16px 20px' }}>
              <ExerciseEditor
                mode="edit"
                idPrefix={`base-exercise-${row.id}`}
                state={editState}
                nameLocales={nameLocales}
              muscleKeys={muscleKeys}
                muscleLabel={muscleLabel}
                resultTypes={resultTypes}
                nameRef={nameInputRef}
                media={renderEditorMedia(row)}
                onCancel={cancelEdit}
                onSave={() => saveInlineEdit(row)}
              />
            </div>
          ) : renderReadOnly(row)
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(row) => toggleExpand(row.id)}
      />

      {detailFor && (
        <ExerciseDetailModal exercise={detailFor} scope="platform" onClose={() => setDetailFor(null)} />
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete base exercise "${deleting?.display_name ?? deleting?.name}"?`}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  ...cardSurfaceStyle,
  border: '1.5px solid #4b45c6',
  overflow: 'hidden',
  marginBottom: 12,
};
