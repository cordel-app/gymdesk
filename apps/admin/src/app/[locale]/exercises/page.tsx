'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DependencyDialog, ReferenceReport } from '@/components/DependencyDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { StatusBadge } from '@/components/StatusBadge';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ExerciseVideoField } from '@/components/ExerciseVideoField';
import type { PreparedExerciseImage } from '@/lib/exerciseImageUpload';
import type { PreparedExerciseVideo } from '@/lib/exerciseVideoUpload';
import { btnStyle, cardSurfaceStyle, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
// #806: the Exercise editor, its form-state hook and the form declaration are
// shared with the platform Base Exercises page — there is one implementation of
// the form and this page supplies the gym context's persistence.
import { ExerciseEditor, ExerciseMediaPair, type ExerciseNameLocales } from '@/components/exercises/ExerciseEditor';
import { useExerciseEditorState, useMuscleLabel } from '@/components/exercises/useExerciseEditorState';
import {
  toExerciseCreatePayload,
  toExerciseUpdatePayload,
  type MuscleRole,
  type ResultTypeRow,
} from '@/components/exercises/exerciseForm';
// #965: the expanded card is the editor's read-only counterpart and `⋮ → Details`
// carries the technical metadata — both shared with the Base Exercises page, for
// the reason the editor itself is (#806).
import { ExerciseReadOnlyView } from '@/components/exercises/ExerciseReadOnlyView';
import { ExerciseMediaPreview } from '@/components/exercises/ExerciseMediaPreview';
import { ExerciseDetailModal } from '@/components/exercises/ExerciseDetailModal';
// #969 stage 2: the gym's own Exercises list is the third of the ticket's three
// screens, so it renders the *same* toolbar over the *same* filter-state
// declaration as Base Exercises and the Import modal (§19) — never a search box
// of its own.
import { EXERCISE_CATEGORIES } from '@/lib/exerciseCategories';
import { ExerciseFilterBar, type ExerciseFacetOptions } from '@/components/exercises/ExerciseFilterBar';
import { EMPTY_EXERCISE_FILTER, exerciseFilterQuery, type ExerciseFilterState } from '@/lib/exerciseFilters';
import { ImportExercisesModal } from './ImportExercisesModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExerciseMuscle { key: string; role: MuscleRole }
type ResultType = ResultTypeRow;
interface Exercise {
  id: number; name: string;
  /** #967: the name in the caller's language, resolved server-side (base name as the fallback). */
  display_name: string;
  /** #967: the stored per-locale names — what `⋮ → Edit` seeds its language inputs from. */
  translations: Record<string, string>;
  description: string | null;
  /** #719: the video reference, and its stored poster when the gym uploaded one. */
  video_url: string | null; video_thumbnail_url: string | null;
  /** #719: the master reference, and the 512×512 thumbnail when the gym uploaded one. */
  image_url: string | null; image_thumbnail_url: string | null;
  min_reps_default: number | null; max_reps_default: number | null;
  sets_default: number | null; rest_default_seconds: number | null; notes_default: string | null;
  status: 'active' | 'inactive';
  gym_id: string | null;
  /** #718: set when the row was imported from a Base Exercise — the "System sourced" half of the source label. */
  cloned_from_id: number | null;
  created_at: string; created_by_name: string | null;
  modified_at: string | null; modified_by_name: string | null;
  muscles: ExerciseMuscle[] | null;
  allowed_result_types: ResultType[] | null;
}

const truncate = (s: string | null, n = 55) => s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—';

// ─── Component ────────────────────────────────────────────────────────────────

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 3 — the row and the header band are laid out from one declaration
 * rather than restating widths at each other (#637's shape).
 *
 * `mobile` says what each column is on a phone. The exercise's name is the row's
 * identity and its status is the one state worth seeing without tapping; the
 * muscles, the author, the date and the System-sourced/Custom tag are read in
 * the expanded card (#965).
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `exercises` namespace. Absent = no title. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 140, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 160, grow: 3, mobile: 'secondary' },
  { key: 'primary_muscles', labelKey: 'col_primary_muscles', width: 140, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 90, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 120, mobile: 'secondary' },
  { key: 'type', labelKey: 'col_type', width: 110, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 80, mobile: 'keep' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 13, mobile: 'keep' },
  { key: 'actions', width: 32, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 20;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

export default function ExercisesPage() {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const tDeps = useTranslations('dependencies');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [muscleKeys, setMuscleKeys] = useState<string[]>([]);
  const [resultTypes, setResultTypes] = useState<ResultType[]>([]);
  const [loading, setLoading] = useState(true);

  // #969: every filter the toolbar offers, applied server-side (§16/§17) — the
  // list is never narrowed in the browser.
  const [filter, setFilter] = useState<ExerciseFilterState>(EMPTY_EXERCISE_FILTER);
  // What the metadata dropdowns offer, and the unfiltered total `Showing 42 of
  // 612` counts against (§8, §9, §14). A gym's own exercises carry none of
  // #964's source columns, so these come back empty and the two controls are
  // absent rather than empty — the count still needs the total.
  const [facets, setFacets] = useState<ExerciseFacetOptions | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  // Expanded/edit state. #806: the form itself — values, muscles, result types,
  // the error line and the saving flag — lives in the shared hook, so this page
  // holds only *which* row is open.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  // #967 §3: which languages a name is entered in comes from the API, never from
  // a list in this page.
  const [nameLocales, setNameLocales] = useState<ExerciseNameLocales | null>(null);
  const editState = useExerciseEditorState();
  const nameInputRef = useRef<HTMLInputElement>(null);

  // #805: the inline creation card, opened by "+ Add Exercise". No modal.
  const [addOpen, setAddOpen] = useState(false);
  const addState = useExerciseEditorState();
  const newNameRef = useRef<HTMLInputElement>(null);
  // #719: the image picked in the creation card, uploaded once the exercise exists.
  const [stagedImage, setStagedImage] = useState<PreparedExerciseImage | null>(null);
  // #719 part 2: and the video picked there, uploaded the same way.
  const [stagedVideo, setStagedVideo] = useState<PreparedExerciseVideo | null>(null);

  // Details, delete, dependency
  const [detailFor, setDetailFor] = useState<Exercise | null>(null);
  // Which exercise has a `<video>` mounted (#717 §9). Nothing is mounted until
  // someone asks to play one, and only one plays at a time.
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Exercise | null>(null);
  const [depDialog, setDepDialog] = useState<{ action: 'edit' | 'delete'; entity: Exercise; refs: ReferenceReport } | null>(null);
  const [depBusy, setDepBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('TRAINING');
  useEffect(() => { if (!gymLoading && !canRead) router.replace(`/${locale}`); }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) loadLookups();
  }, [gymLoading, canRead, activeGymId]);

  // A short debounce, because the toolbar's text fields change on every
  // keystroke (§17). The mutation paths call `load()` directly and are
  // unaffected.
  useEffect(() => {
    if (gymLoading || !canRead) return;
    const handle = setTimeout(load, 250);
    return () => clearTimeout(handle);
  }, [activeGymId, gymLoading, canRead, filter]);

  // The facets and the total describe the whole catalogue rather than the
  // current filter, so they are re-read when the catalogue itself may have
  // moved — not on every keystroke.
  useEffect(() => {
    if (!gymLoading && canRead) loadFacets();
  }, [activeGymId, gymLoading, canRead]);

  async function loadLookups() {
    try {
      const [mu, rt, loc] = await Promise.all([
        apiFetch<{ key: string }[]>('/muscles'),
        apiFetch<ResultType[]>('/result-types'),
        apiFetch<{ base_locale: string; translatable: string[] }>('/exercises/locales'),
      ]);
      setMuscleKeys(mu.map((m) => m.key));
      setResultTypes(rt);
      setNameLocales({ base: loc.base_locale, translatable: loc.translatable });
    } catch { /* non-critical */ }
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows(await apiFetch<Exercise[]>(`/exercises${exerciseFilterQuery(filter)}`));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadFacets() {
    if (!activeGymId) return;
    try {
      const res = await apiFetch<{ total: number; equipment: string[]; category: string[] }>('/exercises/facets');
      // #1384: the seven supported categories are always offered (a gym's own
      // exercises may be assigned one), beside any other stored value.
      const categories = Array.from(new Set([...EXERCISE_CATEGORIES, ...(res.category ?? [])])).sort();
      setFacets({ equipment: res.equipment ?? [], category: categories });
      setTotal(res.total ?? null);
    } catch { /* non-critical: the toolbar simply offers no metadata filter */ }
  }

  // ─── Muscle label helper (#806: shared with the Base Exercises page) ──────

  const muscleLabel = useMuscleLabel(muscleKeys);

  // ─── Expand / Edit ────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function enterEdit(ex: Exercise) {
    setExpandedId(ex.id);
    setEditingId(ex.id);
    editState.reset(ex);
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  function cancelEdit() {
    setEditingId(null);
    setExpandedId(null);
    editState.setError(null);
  }

  // ─── Dependency guard ─────────────────────────────────────────────────────

  async function guardedAction(action: 'edit' | 'delete', ex: Exercise) {
    try {
      const refs = await apiFetch<ReferenceReport>(`/exercises/${ex.id}/references`);
      if (refs.usageCount > 0) { setDepDialog({ action, entity: ex, refs }); return; }
      if (action === 'edit') enterEdit(ex);
      else setDeleting(ex);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function depContinue() {
    if (!depDialog) return;
    if (depDialog.action === 'edit') {
      enterEdit(depDialog.entity);
      setDepDialog(null);
      return;
    }
    setDepBusy(true);
    try {
      await apiFetch(`/exercises/${depDialog.entity.id}`, { method: 'DELETE' });
      setDepDialog(null);
      load();
    } catch (err: any) {
      setDepDialog(null);
      toast(err.message ?? t('error_generic'));
    } finally {
      setDepBusy(false);
    }
  }

  // ─── Save inline edit ─────────────────────────────────────────────────────

  /**
   * #806 §6: the gym context's persistence — the shared editor validates and
   * reports, this page decides the route. A rejection keeps the form open with
   * the user's input, which is what `submit()` returning false means.
   */
  async function handleSave(id: number) {
    const saved = await editState.submit(async () => {
      // #717 Q6: `toExerciseUpdatePayload` deliberately omits `video_url` —
      // see the shared module.
      await apiFetch(`/exercises/${id}`, {
        method: 'PUT',
        body: JSON.stringify(toExerciseUpdatePayload(editState.form, editState.extras)),
      });
    });
    if (!saved) return;
    setEditingId(null);
    setExpandedId(null);
    load();
  }

  // #719: the media endpoints return the exercise as every other route shapes
  // it, so the row is replaced in place — the open editor keeps its unsaved
  // fields and the new image appears without a reload.
  function applyExerciseUpdate(updated: Exercise) {
    if (!updated?.id) return;
    setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
  }

  // ─── Duplicate ────────────────────────────────────────────────────────────

  async function handleDuplicate(ex: Exercise) {
    try {
      const dup = await apiFetch<Exercise>(`/exercises/${ex.id}/duplicate`, { method: 'POST' });
      await load();
      enterEdit(dup);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Clone base exercise ──────────────────────────────────────────────────

  async function handleClone(ex: Exercise) {
    try {
      await apiFetch(`/exercises/${ex.id}/clone`, { method: 'POST' });
      toast(t('cloned'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Activate / Deactivate ────────────────────────────────────────────────

  // #673: quick status toggle from the context menu. Reuses PUT /exercises/:id,
  // which applies `status` on its own and leaves every other column untouched.
  async function handleToggleStatus(ex: Exercise) {
    const next = ex.status === 'active' ? 'inactive' : 'active';
    try {
      await apiFetch(`/exercises/${ex.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: next }),
      });
      // Keep an open inline editor in sync so saving it doesn't revert the toggle.
      if (editingId === ex.id) editState.setForm((prev) => ({ ...prev, status: next }));
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/exercises/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) { setExpandedId(null); setEditingId(null); }
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Add (inline creation card, #805) ────────────────────────────────────

  function openAdd() {
    addState.reset(null);
    setStagedImage(null);
    setStagedVideo(null);
    setAddOpen(true);
    setTimeout(() => newNameRef.current?.focus(), 60);
  }

  /** Cancel discards the unsaved form state and calls no API (#805 §14). */
  function closeAdd() {
    setAddOpen(false);
    addState.reset(null);
    setStagedImage(null);
    setStagedVideo(null);
  }

  async function handleAdd() {
    const saved = await addState.submit(async () => {
      const created = await apiFetch<Exercise>('/exercises', {
        method: 'POST',
        body: JSON.stringify(toExerciseCreatePayload(addState.form, addState.extras)),
      });
      // #719: the image the creation card staged, now that there is an exercise
      // to attach it to. A failure here leaves the exercise created and
      // imageless and says so, rather than discarding the exercise — so it is
      // reported as a toast and does not fail the save.
      if (stagedImage) {
        try {
          await apiFetch(`/exercises/${created.id}/image`, { method: 'POST', body: JSON.stringify(stagedImage) });
        } catch (err: any) {
          toast(err.message ?? t('image_error_upload_failed'));
        }
      }
      if (stagedVideo) {
        try {
          await apiFetch(`/exercises/${created.id}/video`, { method: 'POST', body: JSON.stringify(stagedVideo) });
        } catch (err: any) {
          toast(err.message ?? t('video_error_upload_failed'));
        }
      }
    });
    if (!saved) return;
    closeAdd();
    load();
  }

  // #718: the gym picks which Base Exercises to import; the modal owns the
  // filters and the selection, this page only refreshes once they land.
  /**
   * #719 §12: a single import request can do three things — import new
   * exercises, refresh the System media of copies the gym already has, and skip
   * the rest — so the toast is composed from the parts that actually happened.
   * An import of nothing but skips still reports the (zero) import, so the
   * action never appears to have done nothing silently.
   */
  function handleImported(result: { imported: unknown[]; refreshed: unknown[]; skipped: unknown[] }) {
    setImportOpen(false);
    const refreshedCount = result.refreshed?.length ?? 0;
    const parts: string[] = [];
    if (result.imported.length > 0 || refreshedCount === 0) {
      parts.push(t('imported', { n: result.imported.length }));
    }
    if (refreshedCount > 0) parts.push(t('imported_media_refreshed', { n: refreshedCount }));
    if (result.skipped.length > 0) parts.push(t('imported_skipped', { n: result.skipped.length }));
    toast(parts.join(' '), 'success');
    load();
  }

  if (gymLoading || !canRead) return null;

  // ─── Render helpers ──────────────────────────────────────────────────────

  /** The inline creation card (#805): the "+ Add Exercise" button's only surface — there is no modal. */
  function renderInlineNewRow() {
    if (!addOpen) return null;
    return (
      <div style={cardSt}>
        <div style={{ padding: '16px 20px' }}>
          <p style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('new_exercise')}</p>
          <ExerciseEditor
            mode="create"
            idPrefix="exercise-new"
            state={addState}
            nameLocales={nameLocales}
            muscleKeys={muscleKeys}
            muscleLabel={muscleLabel}
            resultTypes={resultTypes}
            nameRef={newNameRef}
            media={<ExerciseMediaPair
              // #719: there is no exercise to upload to yet, so the prepared
              // pair is held here and posted to `POST /exercises/:id/image` the
              // moment the exercise exists.
              image={<ExerciseImageField exerciseId={null} imageUrl={null} onStaged={setStagedImage} />}
              // #719 part 2: same staging for the video and its poster.
              video={<ExerciseVideoField exerciseId={null} videoUrl={null} onStaged={setStagedVideo} />}
            />}
            onCancel={closeAdd}
            onSave={handleAdd}
          />
        </div>
      </div>
    );
  }

  function renderEditSection(ex: Exercise) {
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
        <ExerciseEditor
          mode="edit"
          idPrefix={`exercise-${ex.id}`}
          state={editState}
          nameLocales={nameLocales}
          muscleKeys={muscleKeys}
          muscleLabel={muscleLabel}
          resultTypes={resultTypes}
          nameRef={nameInputRef}
          media={<ExerciseMediaPair
            // #719: the image is not part of this form. Uploading or removing
            // acts on the exercise straight away, so cancelling the editor
            // neither undoes it nor re-applies an image that was removed.
            image={<ExerciseImageField
              exerciseId={ex.id}
              imageUrl={ex.image_url}
              thumbnailUrl={ex.image_thumbnail_url}
              onChanged={(updated) => applyExerciseUpdate(updated as Exercise)}
              disabled={!canWrite}
              disabledTitle={readOnlyTitle}
            />}
            video={<ExerciseVideoField
              exerciseId={ex.id}
              videoUrl={ex.video_url}
              posterUrl={ex.video_thumbnail_url}
              onChanged={(updated) => applyExerciseUpdate(updated as Exercise)}
              disabled={!canWrite}
              disabledTitle={readOnlyTitle}
            />}
          />}
          onCancel={cancelEdit}
          onSave={() => handleSave(ex.id)}
        />
      </div>
    );
  }

  /**
   * The read-only body of an expanded card (#965): the editor's own five
   * sections, with the controls replaced by values.
   *
   * Until #965 this page rendered its own list of whichever sections happened to
   * be non-empty, while the Base Exercises page rendered a flat table of rows —
   * two read-only views of one entity, neither of them the Edit view's shape. Both
   * are `ExerciseReadOnlyView` now, so the section order, the labels and the media
   * presentation are the editor's and cannot drift (§14, §15).
   */
  function renderViewSection(ex: Exercise) {
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
        <ExerciseReadOnlyView
          exercise={ex}
          muscleKeys={muscleKeys}
          muscleLabel={muscleLabel}
          resultTypes={resultTypes}
          media={
            <ExerciseMediaPreview
              exercise={ex}
              playing={playingId === ex.id}
              onPlay={() => setPlayingId(ex.id)}
            />
          }
        />
      </div>
    );
  }

  function renderRow(ex: Exercise) {
    const isEditing = editingId === ex.id;
    const isExpanded = isEditing || expandedId === ex.id;
    // #804: `GET /exercises` returns the gym's own rows only, so a base row no
    // longer reaches this list — a System Exercise appears here after it has
    // been imported, as the gym's own copy carrying `cloned_from_id`. The
    // `isBase` arms below are kept as the row shape's defence, not as a path a
    // user can take: nothing in the page filters on it and nothing depends on
    // it firing.
    const isBase = ex.gym_id === null;
    // #718 §12: two origins, and only two — an exercise the platform provides
    // (the library row itself, or the gym's copy of one) is "System sourced";
    // one the gym wrote is "Custom". The ownership model is untouched: this
    // reads `gym_id` and `cloned_from_id`, it does not change them.
    const isSystemSourced = isBase || ex.cloned_from_id != null;
    const principalMuscles = (ex.muscles ?? []).filter((m) => m.role === 'principal').map((m) => muscleLabel(m.key)).join(', ') || '—';

    const menuItems: ContextMenuItem[] = isBase
      ? [
          { label: t('details'), onClick: () => setDetailFor(ex) },
          { label: t('clone'), onClick: () => handleClone(ex), disabled: !canWrite, title: readOnlyTitle },
        ]
      : [
          { label: t('details'), onClick: () => setDetailFor(ex) },
          { label: t('edit'), onClick: () => guardedAction('edit', ex), disabled: !canWrite, title: readOnlyTitle },
          { label: t('duplicate'), onClick: () => handleDuplicate(ex), disabled: !canWrite, title: readOnlyTitle },
          ex.status === 'active'
            ? { label: t('deactivate'), onClick: () => handleToggleStatus(ex), disabled: !canWrite, title: readOnlyTitle }
            : { label: t('activate'), onClick: () => handleToggleStatus(ex), disabled: !canWrite, title: readOnlyTitle },
          { label: t('delete'), onClick: () => guardedAction('delete', ex), danger: true, disabled: !canWrite, title: readOnlyTitle },
        ];

    return (
      <div key={ex.id} style={cardSt}>
        <div className={LIST_GRID_ROW_CLASS} style={rowSt} onClick={() => toggleExpand(ex.id)}>
          <div className={CELL_CLASS.name} title={ex.display_name ?? ex.name} style={{ fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {/* #967 §6: the list shows the name in the application's language —
                the server resolved it, falling back to the base name. */}
            {ex.display_name ?? ex.name}
          </div>
          <div className={CELL_CLASS.description} style={{ fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {truncate(ex.description)}
          </div>
          <div className={CELL_CLASS.primary_muscles} style={{ fontSize: 13, color: '#555', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {principalMuscles}
          </div>
          <div className={CELL_CLASS.created_at} style={{ fontSize: 13, color: '#888' }}>
            {ex.created_at?.slice(0, 10) ?? '—'}
          </div>
          <div className={CELL_CLASS.created_by} style={{ fontSize: 13, color: '#555', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ex.created_by_name ?? '—'}
          </div>
          <div className={CELL_CLASS.type}>
            {isSystemSourced
              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#e8f4fd', color: '#1a6da8' }}>{t('type_system_sourced')}</span>
              : <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#f0f9eb', color: '#3a7c3a' }}>{t('type_custom')}</span>
            }
          </div>
          <div className={CELL_CLASS.status}>
            <StatusBadge status={ex.status} label={tStatus(ex.status)} />
          </div>
          <span className={CELL_CLASS.expand} style={{ fontSize: 13, color: '#aaa', display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
        {isEditing ? renderEditSection(ex) : isExpanded ? renderViewSection(ex) : null}
      </div>
    );
  }

  function renderHeader() {
    return (
      <div className={LIST_GRID_ROW_CLASS} style={headerBandSt}>
        {LIST_COLUMNS.map((col) => (
          <span key={col.key} className={CELL_CLASS[col.key]}>
            {col.labelKey ? t(col.labelKey) : null}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* #803: the header button names what it imports — the platform's System
              Exercises. The modal's own primary action stays `import`, so the two
              deliberately read differently and need two keys. */}
          <button onClick={() => setImportOpen(true)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#1e7e40'), !canWrite)}>{t('import_system_exercises')}</button>
          {/* #805: opens the inline creation card at the top of the list, never a modal. */}
          <button onClick={openAdd} disabled={!canWrite || addOpen} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)}>{t('add')}</button>
        </div>
      </div>

      {/* #969 §2: the search box and the Status dropdown that sat in the header
          are two fields of the shared toolbar now, and the list starts directly
          below it. This context carries no slug (§4 — no editor writes one) and
          no source metadata, so it renders Search + Muscles + Equipment +
          Category + Status, the same row as Base Exercises (#1384). */}
      <ExerciseFilterBar
        value={filter}
        onChange={setFilter}
        muscleKeys={muscleKeys}
        muscleLabel={muscleLabel}
        facets={facets}
        alwaysShowMetadata
        showStatus
        shown={rows.length}
        total={total}
      />

      {renderInlineNewRow()}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {rows.length === 0 && !addOpen && <p style={{ color: '#888' }}>{t('empty')}</p>}
          {rows.length > 0 && (
            /* The header band and the cards share LIST_GRID_COLUMNS and scroll
               together, so they cannot fall out of line, and a narrow viewport
               scrolls the list instead of the page (#1011). */
            <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
              <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
                {renderHeader()}
                {rows.map(renderRow)}
              </div>
            </div>
          )}
        </>
      )}


      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      <DependencyDialog
        open={depDialog !== null}
        message={depDialog ? tDeps(`exercise_${depDialog.action}` as any, { name: depDialog.entity.display_name ?? depDialog.entity.name, count: depDialog.refs.usageCount }) : ''}
        question={tDeps('question')}
        references={depDialog?.refs.references ?? []}
        moreLabel={depDialog && depDialog.refs.usageCount > depDialog.refs.references.length
          ? tDeps('more', { n: depDialog.refs.usageCount - depDialog.refs.references.length }) : null}
        referenceHref={`/${locale}/workout-templates`}
        confirmLabel={tDeps('continue')}
        cancelLabel={tDeps('cancel')}
        onConfirm={depContinue}
        onCancel={() => setDepDialog(null)}
        busy={depBusy}
      />

      {detailFor && (
        <ExerciseDetailModal exercise={detailFor} onClose={() => setDetailFor(null)} />
      )}

      {/* ── Import Exercises modal (#718) ── */}
      <ImportExercisesModal
        open={importOpen}
        muscleKeys={muscleKeys}
        muscleLabel={muscleLabel}
        onCancel={() => setImportOpen(false)}
        onImported={handleImported}
      />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardSt: React.CSSProperties = { ...cardSurfaceStyle, marginBottom: 8, overflow: 'hidden' };
const rowSt: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  padding: `12px ${ROW_PADDING_X}px`,
  gap: LIST_COLUMN_GAP,
  cursor: 'pointer',
};
const headerBandSt: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  padding: `6px ${ROW_PADDING_X}px`,
  gap: LIST_COLUMN_GAP,
  marginBottom: 4,
  color: '#999',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
