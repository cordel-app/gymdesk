'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable, Column } from '@/components/DataTable';
import { btnStyle, btnSmall, cardSurfaceStyle } from '@/components/ui';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  EXERCISE_IMAGE_THUMBNAIL_SIZE,
  SAFE_IMAGE_SRC,
  isPreparedExerciseImage,
  prepareExerciseImage,
} from '@/lib/exerciseImageUpload';
import {
  EXERCISE_VIDEO_POSTER_SIZE,
  exerciseVideoMaxMb,
  isPreparedExerciseVideo,
  prepareExerciseVideo,
} from '@/lib/exerciseVideoUpload';

interface Exercise {
  id: number;
  name: string;
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
  created_at: string;
  modified_at: string | null;
}

interface EditForm {
  name: string;
  description: string;
}

function emptyEditForm(): EditForm {
  return { name: '', description: '' };
}

export default function CordelExercisesPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Inline create / edit (#716 Q4: the card edits in place — no modal).
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<EditForm>(emptyEditForm());
  const [newSaving, setNewSaving] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Exercise | null>(null);
  // §7: removing media is destructive, so it goes through the page's existing
  // confirmation rather than acting on the first click.
  const [removingVideo, setRemovingVideo] = useState<Exercise | null>(null);

  // Image upload (#716) — one exercise at a time, so a single picker, a single
  // busy flag and a single error are enough.
  const [busyImageId, setBusyImageId] = useState<number | null>(null);
  const [imageAction, setImageAction] = useState<'upload' | 'remove' | null>(null);
  const [imageError, setImageError] = useState<{ id: number; message: string } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageTargetRef = useRef<Exercise | null>(null);

  // Video upload (#717) — the same one-at-a-time shape as the image above.
  const [busyVideoId, setBusyVideoId] = useState<number | null>(null);
  const [videoAction, setVideoAction] = useState<'upload' | 'remove' | null>(null);
  const [videoError, setVideoError] = useState<{ id: number; message: string } | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const videoTargetRef = useRef<Exercise | null>(null);
  // Which exercise has a <video> mounted. Nothing is mounted until the
  // administrator asks to play one, so opening a card never downloads an MP4
  // (§9) — and only one plays at a time.
  const [playingId, setPlayingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : '';
      setRows(await apiFetch<Exercise[]>(`/platform/exercises${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search]);

  useEffect(() => { load(); }, [load]);

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline create / edit ────────────────────────────────────────────────

  function openInlineNew() {
    setNewForm(emptyEditForm());
    setNewError(null);
    setCreating(true);
  }

  async function saveInlineNew() {
    if (!newForm.name.trim()) { setNewError('Name is required.'); return; }
    setNewSaving(true);
    setNewError(null);
    try {
      await apiFetch('/platform/exercises', {
        method: 'POST',
        body: JSON.stringify({
          name: newForm.name.trim(),
          description: newForm.description.trim() || null,
        }),
      });
      setCreating(false);
      toast('Exercise created', 'success');
      load();
    } catch (e: any) {
      setNewError(e.message ?? 'Error');
    } finally { setNewSaving(false); }
  }

  function openInlineEdit(exercise: Exercise) {
    setEditingId(exercise.id);
    setEditForm({ name: exercise.name, description: exercise.description ?? '' });
    setEditError(null);
    setExpanded((prev) => new Set(prev).add(exercise.id));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveInlineEdit(exercise: Exercise) {
    if (!editForm.name.trim()) { setEditError('Name is required.'); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/platform/exercises/${exercise.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
        }),
      });
      setEditingId(null);
      toast('Exercise updated', 'success');
      load();
    } catch (e: any) {
      setEditError(e.message ?? 'Error');
    } finally { setEditSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/exercises/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Exercise deleted', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  // ─── Image upload / removal (#716 §11, §12) ──────────────────────────────
  //
  // The picker is opened from the expanded card. `prepareExerciseImage()` — the
  // same helper the gym-side control uses (#719) — checks what a browser can
  // check (a PNG, exactly 2048×2048), draws the 512×512 thumbnail from the
  // master, and returns both as base64. If it cannot produce the thumbnail
  // nothing is sent at all, so the image already on the exercise is never
  // replaced by a master with no companion. The server repeats every check from
  // the files' own bytes, so this pass exists to give a clear error *before* an
  // upload, never instead of one.

  function openImagePicker(exercise: Exercise) {
    imageTargetRef.current = exercise;
    setImageError(null);
    if (imageInputRef.current) {
      // Cleared so picking the same file twice still fires `onChange`.
      imageInputRef.current.value = '';
      imageInputRef.current.click();
    }
  }

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const exercise = imageTargetRef.current;
    if (!file || !exercise) return;

    setBusyImageId(exercise.id);
    setImageAction('upload');
    setImageError(null);
    try {
      const prepared = await prepareExerciseImage(file);
      if (!isPreparedExerciseImage(prepared)) {
        // Nothing is sent, so the existing image stays exactly as it is (§11).
        setImageError({ id: exercise.id, message: IMAGE_PROBLEM_MESSAGES[prepared] });
        return;
      }
      await apiFetch(`/platform/exercises/${exercise.id}/image`, {
        method: 'POST',
        body: JSON.stringify(prepared),
      });
      toast('Image updated', 'success');
      await load();
    } catch (err: any) {
      setImageError({ id: exercise.id, message: err.message ?? 'Image upload failed' });
    } finally {
      setBusyImageId(null);
      setImageAction(null);
    }
  }

  async function handleImageRemove(exercise: Exercise) {
    setBusyImageId(exercise.id);
    setImageAction('remove');
    setImageError(null);
    try {
      await apiFetch(`/platform/exercises/${exercise.id}/image`, { method: 'DELETE' });
      toast('Image removed', 'success');
      await load();
    } catch (err: any) {
      setImageError({ id: exercise.id, message: err.message ?? 'Image removal failed' });
    } finally {
      setBusyImageId(null);
      setImageAction(null);
    }
  }

  // ─── Video upload / removal (#717 §4–§7) ─────────────────────────────────
  //
  // The same shape as the image control above, one folder over.
  // `prepareExerciseVideo()` — the helper the gym-side control uses (#719 part
  // 2) — checks what a browser can check (an MP4, within the configured cap),
  // captures one frame into a 512 × 512 PNG poster and returns both as base64.
  // If the poster cannot be captured nothing is sent at all (§6: a failed
  // upload keeps the existing video), and the server repeats every check from
  // the files' own bytes, so this pass exists to give a clear error *before* a
  // multi-megabyte upload rather than instead of one.

  function openVideoPicker(exercise: Exercise) {
    videoTargetRef.current = exercise;
    setVideoError(null);
    if (videoInputRef.current) {
      // Cleared so picking the same file twice still fires `onChange`.
      videoInputRef.current.value = '';
      videoInputRef.current.click();
    }
  }

  async function handleVideoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const exercise = videoTargetRef.current;
    if (!file || !exercise) return;

    setBusyVideoId(exercise.id);
    setVideoAction('upload');
    setVideoError(null);
    try {
      const prepared = await prepareExerciseVideo(file);
      if (!isPreparedExerciseVideo(prepared)) {
        // Nothing is sent, so the existing video stays exactly as it is (§6).
        setVideoError({ id: exercise.id, message: VIDEO_PROBLEM_MESSAGES[prepared] });
        return;
      }
      await apiFetch(`/platform/exercises/${exercise.id}/video`, {
        method: 'POST',
        body: JSON.stringify(prepared),
      });
      // A replacement reuses the same key, so a player left open would keep
      // showing the old bytes from cache.
      setPlayingId(null);
      toast('Video updated', 'success');
      await load();
    } catch (err: any) {
      setVideoError({ id: exercise.id, message: err.message ?? 'Video upload failed' });
    } finally {
      setBusyVideoId(null);
      setVideoAction(null);
    }
  }

  async function handleVideoRemove(exercise: Exercise) {
    setBusyVideoId(exercise.id);
    setVideoAction('remove');
    setVideoError(null);
    try {
      await apiFetch(`/platform/exercises/${exercise.id}/video`, { method: 'DELETE' });
      setPlayingId(null);
      toast('Video removed', 'success');
      await load();
    } catch (err: any) {
      setVideoError({ id: exercise.id, message: err.message ?? 'Video removal failed' });
    } finally {
      setBusyVideoId(null);
      setVideoAction(null);
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  function renderInlineForm(
    form: EditForm,
    setForm: (f: EditForm) => void,
    error: string | null,
    saving: boolean,
    onCancel: () => void,
    onSave: () => void,
    saveLabel: string,
  ) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Name *</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Bench Press"
            style={inlineInputStyle}
            autoFocus
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={inlineLabelStyle}>Description</label>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={inlineInputStyle}
          />
        </div>
        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 8px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnSmall('#888')}>Cancel</button>
          <button onClick={onSave} disabled={saving} style={btnSmall()}>{saving ? 'Saving…' : saveLabel}</button>
        </div>
      </div>
    );
  }

  /**
   * The image block of an expanded card (§9, §10, §11).
   *
   * The frame draws the **thumbnail** — the 2048×2048 master has no business
   * being downloaded for a 160px card (§4), so it is only ever fetched by
   * following `View full size`, which opens it in a new tab. Only a reference
   * with a drawable scheme reaches the DOM: `image_url` is a column a `PUT` can
   * set to any string, so it is not this page's to trust (CodeQL
   * `js/xss-through-dom`, the same inline guard the gym-side control applies).
   */
  function renderImageSection(exercise: Exercise) {
    const version = encodeURIComponent(exercise.modified_at ?? exercise.created_at);
    // A replacement reuses the deterministic key, so the URL does not change —
    // `modified_at` is what busts the browser's cache (#715's rule).
    const thumbnail = exercise.image_thumbnail_url ?? exercise.image_url;
    const drawable = thumbnail != null && SAFE_IMAGE_SRC.test(thumbnail);
    const master = exercise.image_url;
    const masterOpenable = master != null && SAFE_IMAGE_SRC.test(master);
    const busy = busyImageId === exercise.id;

    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={imageFrameStyle}>
          {drawable ? (
            <img
              src={`${thumbnail}?v=${version}`}
              alt={exercise.name}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            <span style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 8 }}>No image yet</span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => openImagePicker(exercise)} disabled={busy} style={btnSmall()}>
              {busy && imageAction === 'upload' ? 'Uploading…' : drawable ? 'Replace Image' : 'Upload Image'}
            </button>
            {drawable && (
              <button onClick={() => handleImageRemove(exercise)} disabled={busy} style={btnSmall('#888')}>
                {busy && imageAction === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
            Upload a {EXERCISE_IMAGE_MASTER_SIZE}×{EXERCISE_IMAGE_MASTER_SIZE} PNG image with a transparent
            background. Its {EXERCISE_IMAGE_THUMBNAIL_SIZE}×{EXERCISE_IMAGE_THUMBNAIL_SIZE} thumbnail is made
            from it automatically.
          </p>
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
          {imageError?.id === exercise.id && (
            <p style={{ margin: 0, fontSize: 12.5, color: '#c0392b' }}>{imageError.message}</p>
          )}
        </div>
      </div>
    );
  }

  /**
   * The video block of an expanded card (§4, §8, §9).
   *
   * What the card draws is the **poster**, never the clip: no `<video>` is
   * mounted until the administrator asks to play one, so expanding a card — or
   * loading the page — never pulls an MP4 down (§9). Asking for the player
   * mounts one with `controls` and `preload="metadata"` and nothing else — it
   * loads the metadata and waits for its own play control, because §8 is
   * explicit that nothing starts playing on its own.
   *
   * Only a reference with a drawable scheme reaches the DOM. `video_url` is a
   * column a `PUT` can set to any string, and on a row that was never uploaded
   * to it is typically a YouTube link — which is a reference this page links to
   * rather than tries to play (CodeQL `js/xss-through-dom`, the same inline
   * guard the image block applies).
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
    const busy = busyVideoId === exercise.id;
    const playing = playingId === exercise.id && playable;

    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap' }}>
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
              {hasVideo ? 'No preview' : 'No video yet'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => openVideoPicker(exercise)} disabled={busy} style={btnSmall()}>
              {busy && videoAction === 'upload' ? 'Uploading…' : hasVideo ? 'Replace Video' : 'Upload Video'}
            </button>
            {hasVideo && (
              <button onClick={() => setRemovingVideo(exercise)} disabled={busy} style={btnSmall('#888')}>
                {busy && videoAction === 'remove' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
            Upload an MP4 video (H.264), up to {exerciseVideoMaxMb()} MB. Its {EXERCISE_VIDEO_POSTER_SIZE}×
            {EXERCISE_VIDEO_POSTER_SIZE} preview image is captured from the video and uploaded with it.
          </p>
          {hasVideo && !playable && SAFE_IMAGE_SRC.test(video!) && (
            // An external link the exercise carries — shown as what it is rather
            // than played, since nothing here can vouch for what is behind it.
            <a href={video!} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: '#4b45c6', wordBreak: 'break-all' }}>
              {video}
            </a>
          )}
          {videoError?.id === exercise.id && (
            <p style={{ margin: 0, fontSize: 12.5, color: '#c0392b' }}>{videoError.message}</p>
          )}
        </div>
      </div>
    );
  }

  const columns: Column<Exercise>[] = [
    { header: 'Name', render: (row) => <strong>{row.name}</strong> },
    {
      header: 'Description',
      render: (row) => row.description
        ? <span style={{ color: '#666' }}>{row.description}</span>
        : <span style={{ color: 'var(--text-muted, #9ca3af)' }}>—</span>,
    },
    { header: 'Status', width: 100, render: (row) => <StatusBadge status={row.status} label={row.status} /> },
    { header: 'Created', width: 120, render: (row) => <span style={{ color: '#888' }}>{row.created_at?.slice(0, 10)}</span> },
    {
      header: '', width: 40,
      render: (row) => (
        <ContextMenu items={[
          { label: 'Details', onClick: () => toggleExpand(row.id) },
          { label: 'Edit', onClick: () => openInlineEdit(row) },
          { label: 'Delete', danger: true, onClick: () => setDeleting(row) },
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
            placeholder="Search…"
            style={searchInputStyle}
          />
          <button style={btnStyle()} onClick={openInlineNew} disabled={creating}>+ New Exercise</button>
        </div>
      </div>

      {creating && (
        <div style={cardStyle}>
          {renderInlineForm(newForm, setNewForm, newError, newSaving, () => setCreating(false), saveInlineNew, 'Create')}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={loading}
        loadingText="Loading…"
        emptyText="No base exercises yet."
        renderExpanded={(row) => (
          editingId === row.id ? (
            renderInlineForm(editForm, setEditForm, editError, editSaving, cancelEdit, () => saveInlineEdit(row), 'Save')
          ) : (
            <div style={{ padding: '12px 20px', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* #717 Q6: one **Media** section holding both kinds of media,
                  shown only on the expanded card — the collapsed row keeps its
                  compact presentation (#716 §9). Nothing the card showed before
                  is hidden or moved: the detail rows below are unchanged. */}
              <p style={sectionLabelStyle}>Media</p>
              {/* #716 — the exercise's image. */}
              {renderImageSection(row)}
              {/* #717 — its demonstration video, drawn from the stored poster. */}
              {renderVideoSection(row)}
              <DetailRow label="Description" value={row.description ?? '—'} />
              <DetailRow label="Status" value={row.status} />
              <DetailRow label="Created At" value={new Date(row.created_at).toLocaleString()} />
              <DetailRow label="Modified At" value={row.modified_at ? new Date(row.modified_at).toLocaleString() : '—'} />
              {/* #675: the same deep link every Details view offers — filtered to this exercise. */}
              <div style={{ marginTop: 6 }}>
                <ViewAuditLogButton entityType="exercise" entityId={row.id} scope="platform" size="small" />
              </div>
            </div>
          )
        )}
        expandedRowKeys={new Set([...expanded, ...(editingId !== null ? [editingId] : [])])}
        onToggleExpand={(row) => toggleExpand(row.id)}
      />

      {/* One picker for the page: `openImagePicker()` points it at an exercise. */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png"
        onChange={handleImageSelected}
        style={{ display: 'none' }}
      />

      {/* The same, for videos: `openVideoPicker()` points it at an exercise. */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4"
        onChange={handleVideoSelected}
        style={{ display: 'none' }}
      />

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete base exercise "${deleting?.name}"?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={removingVideo !== null}
        message={`Remove the video from "${removingVideo?.name}"? The exercise keeps everything else.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={() => {
          const target = removingVideo;
          setRemovingVideo(null);
          if (target) handleVideoRemove(target);
        }}
        onCancel={() => setRemovingVideo(null)}
      />
    </div>
  );
}

/** What each `prepareExerciseVideo()` refusal reads as on this page (#717 §5). */
const VIDEO_PROBLEM_MESSAGES: Record<string, string> = {
  not_an_mp4: 'Video must be an MP4 file.',
  too_large: 'That video is larger than this deployment accepts.',
  unreadable: 'That file could not be read as a video.',
  poster_failed: 'The preview image could not be captured, so nothing was uploaded and the current video is unchanged.',
};

/**
 * Which references this page will hand to a `<video src>`: an `http(s)` URL
 * whose path ends in `.mp4`, which is what an upload produces. A YouTube watch
 * page is a link, not a clip, and a `<video>` pointed at one only fails to
 * decode — so it is rendered as a link instead (§8).
 */
const PLAYABLE_VIDEO_SRC = /^https?:\/\/[^?#]+\.mp4(?:[?#]|$)/i;

/** What each `prepareExerciseImage()` refusal reads as on this page. */
const IMAGE_PROBLEM_MESSAGES: Record<string, string> = {
  not_a_png: 'Image must be a PNG file.',
  unreadable: 'That file could not be read as an image.',
  wrong_size: `Image must be exactly ${EXERCISE_IMAGE_MASTER_SIZE}×${EXERCISE_IMAGE_MASTER_SIZE} pixels.`,
  thumbnail_failed: 'The thumbnail could not be generated from that image, so nothing was uploaded.',
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 120, flexShrink: 0, color: '#888' }}>{label}</span>
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

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
