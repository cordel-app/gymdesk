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
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ExerciseVideoField } from '@/components/ExerciseVideoField';
import type { PreparedExerciseImage } from '@/lib/exerciseImageUpload';
import type { PreparedExerciseVideo } from '@/lib/exerciseVideoUpload';
import { btnStyle, cardSurfaceStyle, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
// #806: the Exercise editor, its form-state hook and the form declaration are
// shared with the platform Base Exercises page — there is one implementation of
// the form and this page supplies the gym context's persistence.
import { ExerciseEditor, ExerciseMediaPair } from '@/components/exercises/ExerciseEditor';
import { useExerciseEditorState, useMuscleLabel } from '@/components/exercises/useExerciseEditorState';
import {
  EXERCISE_STATUSES,
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
import { ImportExercisesModal } from './ImportExercisesModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExerciseMuscle { key: string; role: MuscleRole }
type ResultType = ResultTypeRow;
interface Exercise {
  id: number; name: string; description: string | null;
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

const STATUSES = EXERCISE_STATUSES;
const truncate = (s: string | null, n = 55) => s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—';

// ─── Component ────────────────────────────────────────────────────────────────

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

  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expanded/edit state. #806: the form itself — values, muscles, result types,
  // the error line and the saving flag — lives in the shared hook, so this page
  // holds only *which* row is open.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
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

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading, statusFilter, search]);

  async function loadLookups() {
    try {
      const [mu, rt] = await Promise.all([
        apiFetch<{ key: string }[]>('/muscles'),
        apiFetch<ResultType[]>('/result-types'),
      ]);
      setMuscleKeys(mu.map((m) => m.key));
      setResultTypes(rt);
    } catch { /* non-critical */ }
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      setRows(await apiFetch<Exercise[]>(`/exercises${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  function handleSearchChange(val: string) {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 300);
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
        <div style={rowSt} onClick={() => toggleExpand(ex.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ex.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {truncate(ex.description)}
          </div>
          <div style={{ minWidth: 140, flexShrink: 0, fontSize: 13, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {principalMuscles}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>
            {ex.created_at?.slice(0, 10) ?? '—'}
          </div>
          <div style={{ minWidth: 120, flexShrink: 0, fontSize: 13, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ex.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 110, flexShrink: 0 }}>
            {isSystemSourced
              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#e8f4fd', color: '#1a6da8' }}>{t('type_system_sourced')}</span>
              : <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#f0f9eb', color: '#3a7c3a' }}>{t('type_custom')}</span>
            }
          </div>
          <div style={{ minWidth: 80, flexShrink: 0 }}>
            <StatusBadge status={ex.status} label={tStatus(ex.status)} />
          </div>
          <span style={{ fontSize: 13, color: '#aaa', flexShrink: 0, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
        {isEditing ? renderEditSection(ex) : isExpanded ? renderViewSection(ex) : null}
      </div>
    );
  }

  function renderHeader() {
    return (
      <div style={{ display: 'flex', padding: '6px 20px', marginBottom: 4, color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', gap: 12 }}>
        <span style={{ flex: 2 }}>{t('col_name')}</span>
        <span style={{ flex: 3 }}>{t('col_description')}</span>
        <span style={{ minWidth: 140, flexShrink: 0 }}>{t('col_primary_muscles')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_created_at')}</span>
        <span style={{ minWidth: 120, flexShrink: 0 }}>{t('col_created_by')}</span>
        <span style={{ minWidth: 110, flexShrink: 0 }}>{t('col_type')}</span>
        <span style={{ minWidth: 80, flexShrink: 0 }}>{t('col_status')}</span>
        <span style={{ minWidth: 13, flexShrink: 0 }} />
        <span style={{ minWidth: 32, flexShrink: 0 }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 220 }}
          />
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          {/* #803: the header button names what it imports — the platform's System
              Exercises. The modal's own primary action stays `import`, so the two
              deliberately read differently and need two keys. */}
          <button onClick={() => setImportOpen(true)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#1e7e40'), !canWrite)}>{t('import_system_exercises')}</button>
          {/* #805: opens the inline creation card at the top of the list, never a modal. */}
          <button onClick={openAdd} disabled={!canWrite || addOpen} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)}>{t('add')}</button>
        </div>
      </div>

      {renderInlineNewRow()}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {rows.length > 0 && renderHeader()}
          {rows.length === 0 && !addOpen && <p style={{ color: '#888' }}>{t('empty')}</p>}
          {rows.map(renderRow)}
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
        message={depDialog ? tDeps(`exercise_${depDialog.action}` as any, { name: depDialog.entity.name, count: depDialog.refs.usageCount }) : ''}
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
const rowSt: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '12px 20px', gap: 12, cursor: 'pointer' };
