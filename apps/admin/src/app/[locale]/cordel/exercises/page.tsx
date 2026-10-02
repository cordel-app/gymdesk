'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable, Column } from '@/components/DataTable';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ExerciseVideoField } from '@/components/ExerciseVideoField';
import { btnStyle, cardSurfaceStyle } from '@/components/ui';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  SAFE_IMAGE_SRC,
  type PreparedExerciseImage,
} from '@/lib/exerciseImageUpload';
import type { PreparedExerciseVideo } from '@/lib/exerciseVideoUpload';
// #806: one Exercise editor, one form declaration, one form-state hook — the
// same ones the gym Exercises page renders. What this page supplies is the
// platform context: the `/platform/exercises` routes and their superadmin
// permissions, which are untouched (§6, AC4, AC5).
import { ExerciseEditor, ExerciseMediaPair, type ExerciseNameLocales } from '@/components/exercises/ExerciseEditor';
import { useExerciseEditorState, useMuscleLabel } from '@/components/exercises/useExerciseEditorState';
import {
  resultTypeLabel,
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
   * lives in `cordel/Exercises/Images/`; the column is the same one a gym-owned
   * exercise uses, and the row's ownership is what decides the folder.
   */
  image_url: string | null;
  /** Its 512×512 companion — what every card draws, so no master is downloaded (§4). */
  image_thumbnail_url: string | null;
  /**
   * The demonstration video (#717). An uploaded MP4 lives in
   * `cordel/Exercises/Videos/`; on a row that was never uploaded to, the same
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
}

export default function CordelExercisesPage() {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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
  // Which exercise has a <video> mounted. Nothing is mounted until the
  // administrator asks to play one, so opening a card never downloads an MP4
  // (§9) — and only one plays at a time.
  const [playingId, setPlayingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : '';
      setRows(await apiFetch<Exercise[]>(`${API_BASE}${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search]);

  useEffect(() => { load(); }, [load]);

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
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${API_BASE}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Exercise deleted', 'success');
      load();
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
   * The image of an expanded card, read-only (#806 §11, and #797's rule that an
   * expanded card reads while `⋮ → Edit` writes).
   *
   * The frame draws the **thumbnail** — the 2048×2048 master has no business
   * being downloaded for a 160px card (#716 §4), so it is only ever fetched by
   * following `View full size`, which opens it in a new tab. Only a reference
   * with a drawable scheme reaches the DOM: `image_url` is a column a `PUT` can
   * set to any string, so it is not this page's to trust (CodeQL
   * `js/xss-through-dom`, the same inline guard the upload control applies).
   */
  function renderImageSection(exercise: Exercise) {
    const version = encodeURIComponent(exercise.modified_at ?? exercise.created_at);
    // A replacement reuses the deterministic key, so the URL does not change —
    // `modified_at` is what busts the browser's cache (#715's rule).
    const thumbnail = exercise.image_thumbnail_url ?? exercise.image_url;
    const drawable = thumbnail != null && SAFE_IMAGE_SRC.test(thumbnail);
    const master = exercise.image_url;
    const masterOpenable = master != null && SAFE_IMAGE_SRC.test(master);

    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={imageFrameStyle}>
          {drawable ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${thumbnail}?v=${version}`}
              alt={exercise.display_name ?? exercise.name}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>{t('image_none')}</span>
          )}
        </div>
        {masterOpenable && (
          <a
            href={`${master}?v=${version}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12.5, color: '#4b45c6' }}
          >
            View full size ({EXERCISE_IMAGE_MASTER_SIZE}×{EXERCISE_IMAGE_MASTER_SIZE})
          </a>
        )}
      </div>
    );
  }

  /**
   * The video of an expanded card, read-only.
   *
   * What the card draws is the **poster**, never the clip: no `<video>` is
   * mounted until the administrator asks to play one, so expanding a card — or
   * loading the page — never pulls an MP4 down (#717 §9). Asking for the player
   * mounts one with `controls` and `preload="metadata"` and nothing else, because
   * §8 is explicit that nothing starts playing on its own. Playing is a *read*,
   * which is why it stays on the expanded card while every upload and removal
   * control moved into the editor (#806 §11).
   *
   * Only a reference with a drawable scheme reaches the DOM. `video_url` is a
   * column a `PUT` can set to any string, and on a row that was never uploaded
   * to it is typically a YouTube link — which is a reference this page links to
   * rather than tries to play (CodeQL `js/xss-through-dom`).
   */
  function renderVideoSection(exercise: Exercise) {
    const version = encodeURIComponent(exercise.modified_at ?? exercise.created_at);
    const poster = exercise.video_thumbnail_url;
    const posterDrawable = poster != null && SAFE_IMAGE_SRC.test(poster);
    const video = exercise.video_url;
    const hasVideo = video != null;
    // An uploaded object is an `.mp4` this deployment stored; anything else the
    // column holds is a link, and a `<video>` would only fail to decode it.
    const playable = video != null && PLAYABLE_VIDEO_SRC.test(video);
    const playing = playingId === exercise.id && playable;

    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={videoFrameStyle}>
          {playing ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={`${video}?v=${version}`}
              poster={posterDrawable ? `${poster}?v=${version}` : undefined}
              controls
              preload="metadata"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
            />
          ) : posterDrawable ? (
            <button
              type="button"
              onClick={() => playable && setPlayingId(exercise.id)}
              title={playable ? 'Play video' : undefined}
              style={posterButtonStyle(playable)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${poster}?v=${version}`}
                alt=""
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              {playable && <span aria-hidden="true" style={playOverlayStyle}>▶</span>}
            </button>
          ) : playable ? (
            // A clip with no stored poster — there is nothing to draw, but it is
            // still playable, so the frame offers the player rather than a dead
            // "No preview".
            <button type="button" onClick={() => setPlayingId(exercise.id)} style={posterButtonStyle(true)}>
              <span style={{ ...playOverlayStyle, color: '#6c63ff', textShadow: 'none' }}>▶</span>
            </button>
          ) : (
            <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>
              {hasVideo ? t('video_no_poster') : t('video_none')}
            </span>
          )}
        </div>
        {hasVideo && !playable && SAFE_IMAGE_SRC.test(video!) && (
          // An external link the exercise carries — shown as what it is rather
          // than played, since nothing here can vouch for what is behind it.
          <a href={video!} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: '#4b45c6', wordBreak: 'break-all' }}>
            {video}
          </a>
        )}
      </div>
    );
  }

  /**
   * The read-only body of an expanded card: the fields the editor writes, as
   * text. It reads the same list row the editor is seeded from — never a second
   * fetch and never a second field list (#797's rule).
   */
  function renderReadOnly(exercise: Exercise) {
    const principal = (exercise.muscles ?? []).filter((m) => m.role === 'principal');
    const secondary = (exercise.muscles ?? []).filter((m) => m.role === 'secondary');
    const rts = exercise.allowed_result_types ?? [];
    const defaults = [
      exercise.min_reps_default != null ? `${t('label_min_reps_default')}: ${exercise.min_reps_default}` : null,
      exercise.max_reps_default != null ? `${t('label_max_reps_default')}: ${exercise.max_reps_default}` : null,
      exercise.sets_default != null ? `${t('label_sets_default')}: ${exercise.sets_default}` : null,
      exercise.rest_default_seconds != null ? `${t('label_rest_default_seconds')}: ${exercise.rest_default_seconds}s` : null,
    ].filter((part): part is string => part !== null);

    return (
      <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* #717 Q6: one **Media** section holding both kinds of media, shown only
            on the expanded card — the collapsed row keeps its compact
            presentation (#716 §9). Since #806 it *shows* the media and nothing
            else: uploading and removing moved into the editor behind
            `⋮ → Edit`, which is where every other write on this page lives. */}
        <p style={sectionLabelStyle}>{t('section_media')}</p>
        {renderImageSection(exercise)}
        {renderVideoSection(exercise)}
        <DetailRow label={t('label_description')} value={exercise.description ?? '—'} />
        <DetailRow label={t('label_status')} value={tStatus(exercise.status)} />
        <DetailRow
          label={t('label_result_types')}
          value={rts.length > 0 ? rts.map((rt) => resultTypeLabel(rt, (key) => t(key as any))).join(', ') : '—'}
        />
        <DetailRow label={t('section_configuration')} value={defaults.length > 0 ? defaults.join(' · ') : '—'} />
        <DetailRow label={t('label_notes_default')} value={exercise.notes_default ?? '—'} />
        <DetailRow
          label={t('role_principal')}
          value={principal.length > 0 ? principal.map((m) => muscleLabel(m.key)).join(', ') : '—'}
        />
        <DetailRow
          label={t('role_secondary')}
          value={secondary.length > 0 ? secondary.map((m) => muscleLabel(m.key)).join(', ') : '—'}
        />
        <DetailRow label={t('col_created_at')} value={new Date(exercise.created_at).toLocaleString()} />
        <DetailRow label={t('detail_modified_at')} value={exercise.modified_at ? new Date(exercise.modified_at).toLocaleString() : '—'} />
        {/* #675: the same deep link every Details view offers — filtered to this exercise. */}
        <div style={{ marginTop: 6 }}>
          <ViewAuditLogButton entityType="exercise" entityId={exercise.id} scope="platform" size="small" />
        </div>
      </div>
    );
  }

  const columns: Column<Exercise>[] = [
    // #967 §6: the list shows the name in the application's language.
    { header: t('col_name'), render: (row) => <strong>{row.display_name ?? row.name}</strong> },
    {
      header: t('col_description'),
      render: (row) => row.description
        ? <span style={{ color: '#666' }}>{row.description}</span>
        : <span style={{ color: 'var(--text-muted, #9ca3af)' }}>—</span>,
    },
    { header: t('col_status'), width: 100, render: (row) => <StatusBadge status={row.status} label={tStatus(row.status)} /> },
    { header: t('col_created_at'), width: 120, render: (row) => <span style={{ color: '#888' }}>{row.created_at?.slice(0, 10)}</span> },
    {
      header: '', width: 40,
      render: (row) => (
        <ContextMenu items={[
          { label: t('details'), onClick: () => toggleExpand(row.id) },
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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search_placeholder')}
            style={searchInputStyle}
          />
          <button style={btnStyle()} onClick={openInlineNew} disabled={creating}>+ New Exercise</button>
        </div>
      </div>

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

/**
 * Which references this page will hand to a `<video src>`: an `http(s)` URL
 * whose path ends in `.mp4`, which is what an upload produces. A YouTube watch
 * page is a link, not a clip, and a `<video>` pointed at one only fails to
 * decode — so it is rendered as a link instead (#717 §8).
 */
const PLAYABLE_VIDEO_SRC = /^https?:\/\/[^?#]+\.mp4(?:[?#]|$)/i;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#888' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * A 1:1 frame for the exercise image. The checkerboard is what makes a
 * transparent background legible as transparency rather than as white, and
 * `objectFit: contain` keeps the square undistorted (#715's frame, same
 * reasoning).
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

/** A 16:9 frame for the poster and, once asked for, the player itself. */
const videoFrameStyle: React.CSSProperties = {
  width: 240,
  height: 160,
  flexShrink: 0,
  borderRadius: 8,
  border: '1px solid var(--card-border, #e5e7eb)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  backgroundColor: '#f7f7fb',
};

/** The poster doubles as the play control, so it is a button rather than a div. */
function posterButtonStyle(playable: boolean): React.CSSProperties {
  return {
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '100%',
    padding: 0,
    border: 'none',
    background: 'none',
    cursor: playable ? 'pointer' : 'default',
    lineHeight: 0,
  };
}

const playOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  fontSize: 38,
  lineHeight: 1,
  textShadow: '0 1px 6px rgba(0,0,0,.65)',
};

/** The Media heading — the same quiet section label the gym-side card uses. */
const sectionLabelStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: '#888',
};

const searchInputStyle: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, minWidth: 200,
};

const cardStyle: React.CSSProperties = {
  ...cardSurfaceStyle,
  border: '1.5px solid #4b45c6',
  overflow: 'hidden',
  marginBottom: 12,
};
