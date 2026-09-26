'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DependencyDialog, ReferenceReport } from '@/components/DependencyDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ExerciseVideoField } from '@/components/ExerciseVideoField';
import type { PreparedExerciseImage } from '@/lib/exerciseImageUpload';
import type { PreparedExerciseVideo } from '@/lib/exerciseVideoUpload';
import { btnSmall, btnStyle, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { ExerciseDetailModal } from './ExerciseDetailModal';
import { ImportExercisesModal } from './ImportExercisesModal';

// ─── Types ────────────────────────────────────────────────────────────────────

type MuscleRole = 'principal' | 'secondary';
interface ExerciseMuscle { key: string; role: MuscleRole }
interface ResultType { id: number; name: string; slug: string }
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

const STATUSES = ['active', 'inactive'] as const;
const truncate = (s: string | null, n = 55) => s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—';

function emptyAddForm() {
  return {
    name: '', description: '', video_url: '',
    min_reps_default: '', max_reps_default: '', sets_default: '', rest_default_seconds: '', notes_default: '',
    status: 'active',
  };
}
type AddForm = ReturnType<typeof emptyAddForm>;

function emptyEditForm(e: Exercise): AddForm {
  return {
    name: e.name,
    description: e.description ?? '',
    video_url: e.video_url ?? '',
    min_reps_default: e.min_reps_default != null ? String(e.min_reps_default) : '',
    max_reps_default: e.max_reps_default != null ? String(e.max_reps_default) : '',
    sets_default: e.sets_default != null ? String(e.sets_default) : '',
    rest_default_seconds: e.rest_default_seconds != null ? String(e.rest_default_seconds) : '',
    notes_default: e.notes_default ?? '',
    status: e.status,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExercisesPage() {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const tMuscles = useTranslations('muscles');
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

  // Expanded/edit state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<AddForm>(emptyAddForm());
  const [editMuscles, setEditMuscles] = useState<Map<string, MuscleRole>>(new Map());
  const [editResultTypeIds, setEditResultTypeIds] = useState<Set<number>>(new Set());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Add modal (creation flow unchanged)
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddForm>(emptyAddForm());
  const [addMuscles, setAddMuscles] = useState<Map<string, MuscleRole>>(new Map());
  const [addResultTypeIds, setAddResultTypeIds] = useState<Set<number>>(new Set());
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // #719: the image picked in the Add modal, uploaded once the exercise exists.
  const [stagedImage, setStagedImage] = useState<PreparedExerciseImage | null>(null);
  // #719 part 2: and the video picked there, uploaded the same way.
  const [stagedVideo, setStagedVideo] = useState<PreparedExerciseVideo | null>(null);

  // Details, delete, dependency
  const [detailFor, setDetailFor] = useState<Exercise | null>(null);
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

  // ─── Muscle label helper ──────────────────────────────────────────────────

  function muscleLabel(key: string): string {
    if (muscleKeys.includes(key)) return tMuscles(key as any);
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ─── Expand / Edit ────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function enterEdit(ex: Exercise) {
    setExpandedId(ex.id);
    setEditingId(ex.id);
    setEditForm(emptyEditForm(ex));
    const map = new Map<string, MuscleRole>();
    for (const m of (ex.muscles ?? [])) map.set(m.key, m.role);
    setEditMuscles(map);
    setEditResultTypeIds(new Set((ex.allowed_result_types ?? []).map((rt) => rt.id)));
    setEditError(null);
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  function cancelEdit() {
    setEditingId(null);
    setExpandedId(null);
    setEditError(null);
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

  async function handleSave(id: number) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/exercises/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          // #717 Q6: the editor no longer offers `video_url`, so it no longer
          // submits it. Leaving it in would also re-send a value captured when
          // the editor opened — which, after a video was uploaded in the same
          // session, would repoint the reference and drop the poster with it.
          min_reps_default: editForm.min_reps_default ? parseInt(editForm.min_reps_default, 10) : null,
          max_reps_default: editForm.max_reps_default ? parseInt(editForm.max_reps_default, 10) : null,
          sets_default: editForm.sets_default ? parseInt(editForm.sets_default, 10) : null,
          rest_default_seconds: editForm.rest_default_seconds ? parseInt(editForm.rest_default_seconds, 10) : null,
          notes_default: editForm.notes_default.trim() || null,
          status: editForm.status,
          muscles: Array.from(editMuscles.entries()).map(([key, role]) => ({ key, role })),
          allowed_result_type_ids: Array.from(editResultTypeIds),
        }),
      });
      setEditingId(null);
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
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
      if (editingId === ex.id) setEditForm((prev) => ({ ...prev, status: next }));
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

  // ─── Add (creation modal unchanged) ──────────────────────────────────────

  async function handleAdd() {
    if (!addForm.name.trim()) { setAddError(t('error_required')); return; }
    setAddSaving(true);
    setAddError(null);
    try {
      const created = await apiFetch<Exercise>('/exercises', {
        method: 'POST',
        body: JSON.stringify({
          name: addForm.name.trim(),
          description: addForm.description.trim() || null,
          video_url: addForm.video_url.trim() || null,
          min_reps_default: addForm.min_reps_default ? parseInt(addForm.min_reps_default, 10) : null,
          max_reps_default: addForm.max_reps_default ? parseInt(addForm.max_reps_default, 10) : null,
          sets_default: addForm.sets_default ? parseInt(addForm.sets_default, 10) : null,
          rest_default_seconds: addForm.rest_default_seconds ? parseInt(addForm.rest_default_seconds, 10) : null,
          notes_default: addForm.notes_default.trim() || null,
          status: addForm.status,
          muscles: Array.from(addMuscles.entries()).map(([key, role]) => ({ key, role })),
          allowed_result_type_ids: Array.from(addResultTypeIds),
        }),
      });
      // #719: the image the modal staged, now that there is an exercise to
      // attach it to. A failure here leaves the exercise created and imageless
      // and says so, rather than discarding the exercise.
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
      setAddModalOpen(false);
      setAddForm(emptyAddForm());
      setAddMuscles(new Map());
      setAddResultTypeIds(new Set());
      setStagedImage(null);
      setStagedVideo(null);
      load();
    } catch (err: any) {
      setAddError(err.message ?? t('error_generic'));
    } finally {
      setAddSaving(false);
    }
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

  // Muscle picker keys: static catalog + any legacy keys on the exercise being edited
  const pickerKeys = [...muscleKeys, ...Array.from(editMuscles.keys()).filter((k) => !muscleKeys.includes(k))];
  const addPickerKeys = [...muscleKeys, ...Array.from(addMuscles.keys()).filter((k) => !muscleKeys.includes(k))];

  // ─── Render helpers ──────────────────────────────────────────────────────

  function renderEditSection(ex: Exercise) {
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>

        <p style={sectionLabelSt}>{t('section_general')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_name')} *</label>
            <input ref={nameInputRef} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={inlineInputSt} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_description')}</label>
            <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_status')}</label>
            <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} style={inlineSelectSt}>
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('label_result_types')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {resultTypes.map((rt) => (
              <label key={rt.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={editResultTypeIds.has(rt.id)}
                  onChange={(ev) => {
                    const next = new Set(editResultTypeIds);
                    if (ev.target.checked) next.add(rt.id); else next.delete(rt.id);
                    setEditResultTypeIds(next);
                  }} />
                {rt.name}
              </label>
            ))}
          </div>
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_configuration')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div>
              <label style={inlineLabelSt}>{t('label_min_reps_default')}</label>
              <input type="number" min="0" value={editForm.min_reps_default} onChange={(e) => setEditForm({ ...editForm, min_reps_default: e.target.value })} style={inlineInputSt} />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_max_reps_default')}</label>
              <input type="number" min="0" value={editForm.max_reps_default} onChange={(e) => setEditForm({ ...editForm, max_reps_default: e.target.value })} style={inlineInputSt} />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_sets_default')}</label>
              <input type="number" min="0" value={editForm.sets_default} onChange={(e) => setEditForm({ ...editForm, sets_default: e.target.value })} style={inlineInputSt} />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_rest_default_seconds')}</label>
              <input type="number" min="0" value={editForm.rest_default_seconds} onChange={(e) => setEditForm({ ...editForm, rest_default_seconds: e.target.value })} style={inlineInputSt} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={inlineLabelSt}>{t('label_notes_default')}</label>
              <input value={editForm.notes_default} onChange={(e) => setEditForm({ ...editForm, notes_default: e.target.value })} style={inlineInputSt} />
            </div>
          </div>
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_muscles')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pickerKeys.map((key) => {
              const role = editMuscles.get(key);
              return (
                <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={!!role}
                    onChange={(ev) => {
                      const next = new Map(editMuscles);
                      if (ev.target.checked) next.set(key, 'principal'); else next.delete(key);
                      setEditMuscles(next);
                    }} />
                  <span style={{ flex: 1 }}>{muscleLabel(key)}</span>
                  {role && (
                    <select value={role} onChange={(ev) => { const next = new Map(editMuscles); next.set(key, ev.target.value as MuscleRole); setEditMuscles(next); }} style={{ fontSize: 12, padding: '2px 4px' }}>
                      <option value="principal">{t('role_principal')}</option>
                      <option value="secondary">{t('role_secondary')}</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_media')}</p>
          {/* #717 Q6: `video_url` is no longer a directly editable field —
              video management goes through the control below, which writes the
              reference and its poster together. The column itself is unchanged
              and a row that carries an external link keeps it (the view section
              still shows it); the editor simply no longer offers a text box
              that could repoint it at anything and silently drop the poster. */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <label style={inlineLabelSt}>{t('label_image')}</label>
              {/* #719: the image is not part of this form. Uploading or removing
                  acts on the exercise straight away, so cancelling the editor
                  neither undoes it nor re-applies an image that was removed. */}
              <ExerciseImageField
                exerciseId={ex.id}
                imageUrl={ex.image_url}
                thumbnailUrl={ex.image_thumbnail_url}
                onChanged={(updated) => applyExerciseUpdate(updated as Exercise)}
                disabled={!canWrite}
                disabledTitle={readOnlyTitle}
              />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_video')}</label>
              {/* #719 part 2: the uploaded video, likewise acted on directly.
                  #717 Q6 removed the URL text box that used to sit above: the
                  video is managed here and nowhere else. */}
              <ExerciseVideoField
                exerciseId={ex.id}
                videoUrl={ex.video_url}
                posterUrl={ex.video_thumbnail_url}
                onChanged={(updated) => applyExerciseUpdate(updated as Exercise)}
                disabled={!canWrite}
                disabledTitle={readOnlyTitle}
              />
            </div>
          </div>
        </div>

        {editError && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#c0392b' }}>{editError}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(ex.id)} disabled={editSaving} style={btnSmall('#6c63ff')}>
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  function renderViewSection(ex: Exercise) {
    const principal = (ex.muscles ?? []).filter((m) => m.role === 'principal');
    const secondary = (ex.muscles ?? []).filter((m) => m.role === 'secondary');
    const rts = ex.allowed_result_types ?? [];

    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>

        {rts.length > 0 && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('label_result_types')}</p>
            <p style={{ margin: 0, fontSize: 13, color: '#444' }}>{rts.map((rt) => rt.name).join(', ')}</p>
          </div>
        )}

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_configuration')}</p>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, color: '#444' }}>
            {ex.min_reps_default != null && <span><strong>{t('label_min_reps_default')}:</strong> {ex.min_reps_default}</span>}
            {ex.max_reps_default != null && <span><strong>{t('label_max_reps_default')}:</strong> {ex.max_reps_default}</span>}
            {ex.sets_default != null && <span><strong>{t('label_sets_default')}:</strong> {ex.sets_default}</span>}
            {ex.rest_default_seconds != null && <span><strong>{t('label_rest_default_seconds')}:</strong> {ex.rest_default_seconds}s</span>}
            {!ex.min_reps_default && !ex.max_reps_default && !ex.sets_default && !ex.rest_default_seconds && <span style={{ color: '#aaa' }}>—</span>}
          </div>
          {ex.notes_default && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#666' }}>{ex.notes_default}</p>}
        </div>

        {(principal.length > 0 || secondary.length > 0) && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_muscles')}</p>
            {principal.length > 0 && (
              <p style={{ margin: '0 0 4px', fontSize: 13 }}>
                <strong>{t('role_principal')}:</strong> {principal.map((m) => muscleLabel(m.key)).join(', ')}
              </p>
            )}
            {secondary.length > 0 && (
              <p style={{ margin: 0, fontSize: 13 }}>
                <strong>{t('role_secondary')}:</strong> {secondary.map((m) => muscleLabel(m.key)).join(', ')}
              </p>
            )}
          </div>
        )}

        {(ex.video_url || ex.image_url) && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_media')}</p>
            {ex.video_url && <p style={{ margin: '0 0 4px', fontSize: 13 }}><strong>{t('label_video_url')}:</strong> {ex.video_url}</p>}
            {ex.video_thumbnail_url && (
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{t('label_video')}:</strong>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* #719 §17: the stored poster — the MP4 itself is never
                    downloaded to draw a preview. */}
                <img src={ex.video_thumbnail_url} alt="" loading="lazy" style={{ display: 'block', marginTop: 4, maxWidth: 160, maxHeight: 120, borderRadius: 6, border: '1px solid #ddd', objectFit: 'cover' }} />
              </div>
            )}
            {ex.image_url && (
              <div>
                <strong style={{ fontSize: 13 }}>{t('label_image')}:</strong>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* #719 §17: the 512×512 thumbnail when there is one — the
                    2048×2048 master is never downloaded to fill a 160px box. */}
                <img src={ex.image_thumbnail_url ?? ex.image_url} alt="" loading="lazy" style={{ display: 'block', marginTop: 4, maxWidth: 160, maxHeight: 120, borderRadius: 6, border: '1px solid #ddd', objectFit: 'contain' }} />
              </div>
            )}
          </div>
        )}

      </div>
    );
  }

  function renderRow(ex: Exercise) {
    const isEditing = editingId === ex.id;
    const isExpanded = isEditing || expandedId === ex.id;
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

  const selectSt: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' };

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
          <button onClick={() => setImportOpen(true)} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#1e7e40'), !canWrite)}>{t('import')}</button>
          <button onClick={() => { setAddForm(emptyAddForm()); setAddMuscles(new Map()); setAddResultTypeIds(new Set()); setStagedImage(null); setStagedVideo(null); setAddError(null); setAddModalOpen(true); }} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#6c63ff'), !canWrite)}>{t('add')}</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {rows.length > 0 && renderHeader()}
          {rows.length === 0 && <p style={{ color: '#888' }}>{t('empty')}</p>}
          {rows.map(renderRow)}
        </>
      )}

      {/* ── Add modal (creation flow unchanged) ── */}
      <CrudModal
        open={addModalOpen}
        title={t('modal_add')}
        error={addError}
        saving={addSaving}
        cancelLabel={t('cancel')}
        saveLabel={addSaving ? t('saving') : t('modal_add')}
        onCancel={() => { setAddModalOpen(false); setStagedImage(null); setStagedVideo(null); setAddError(null); }}
        onSave={handleAdd}
      >
        <FormLabel>{t('label_name')} *</FormLabel>
        <FormInput value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} autoFocus />
        <FormLabel>{t('label_description')}</FormLabel>
        <FormInput value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })} />
        <FormLabel>{t('label_video_url')}</FormLabel>
        <FormInput type="url" value={addForm.video_url} onChange={(e) => setAddForm({ ...addForm, video_url: e.target.value })} />
        <FormLabel>{t('label_image')}</FormLabel>
        {/* #719: there is no exercise to upload to yet, so the prepared pair is
            held here and posted to `POST /exercises/:id/image` the moment the
            exercise exists. */}
        <ExerciseImageField
          exerciseId={null}
          imageUrl={null}
          onStaged={setStagedImage}
        />
        <FormLabel>{t('label_video')}</FormLabel>
        {/* #719 part 2: same staging as the image — the pair is posted to
            `POST /exercises/:id/video` the moment the exercise exists. */}
        <ExerciseVideoField
          exerciseId={null}
          videoUrl={null}
          onStaged={setStagedVideo}
        />
        <FormLabel>{t('label_min_reps_default')}</FormLabel>
        <FormInput type="number" min="0" value={addForm.min_reps_default} onChange={(e) => setAddForm({ ...addForm, min_reps_default: e.target.value })} />
        <FormLabel>{t('label_max_reps_default')}</FormLabel>
        <FormInput type="number" min="0" value={addForm.max_reps_default} onChange={(e) => setAddForm({ ...addForm, max_reps_default: e.target.value })} />
        <FormLabel>{t('label_sets_default')}</FormLabel>
        <FormInput type="number" min="0" value={addForm.sets_default} onChange={(e) => setAddForm({ ...addForm, sets_default: e.target.value })} />
        <FormLabel>{t('label_rest_default_seconds')}</FormLabel>
        <FormInput type="number" min="0" value={addForm.rest_default_seconds} onChange={(e) => setAddForm({ ...addForm, rest_default_seconds: e.target.value })} />
        <FormLabel>{t('label_notes_default')}</FormLabel>
        <FormInput value={addForm.notes_default} onChange={(e) => setAddForm({ ...addForm, notes_default: e.target.value })} />
        <FormLabel>{t('label_status')}</FormLabel>
        <select value={addForm.status} onChange={(e) => setAddForm({ ...addForm, status: e.target.value })} style={selectSt}>
          {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
        </select>
        <FormLabel>{t('label_result_types')}</FormLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
          {resultTypes.map((rt) => (
            <label key={rt.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={addResultTypeIds.has(rt.id)}
                onChange={(e) => {
                  const next = new Set(addResultTypeIds);
                  if (e.target.checked) next.add(rt.id); else next.delete(rt.id);
                  setAddResultTypeIds(next);
                }} />
              {t(`result_type_${rt.slug}` as any) ?? rt.name}
            </label>
          ))}
        </div>
        <FormLabel>{t('label_muscles')}</FormLabel>
        <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {addPickerKeys.map((key) => {
            const role = addMuscles.get(key);
            return (
              <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={!!role}
                  onChange={(e) => {
                    const next = new Map(addMuscles);
                    if (e.target.checked) next.set(key, 'principal'); else next.delete(key);
                    setAddMuscles(next);
                  }} />
                <span style={{ flex: 1 }}>{muscleLabel(key)}</span>
                {role && (
                  <select value={role} onChange={(e) => { const next = new Map(addMuscles); next.set(key, e.target.value as MuscleRole); setAddMuscles(next); }} style={{ fontSize: 12, padding: '2px 4px' }}>
                    <option value="principal">{t('role_principal')}</option>
                    <option value="secondary">{t('role_secondary')}</option>
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </CrudModal>

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
        <ExerciseDetailModal
          exerciseId={detailFor.id}
          exerciseName={detailFor.name}
          onClose={() => setDetailFor(null)}
        />
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
const inlineLabelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
const inlineInputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const subSectionSt: React.CSSProperties = { paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--gd-card-border, #eee)' };
const sectionLabelSt: React.CSSProperties = { margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
