'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LineChart } from '@gymdesk/charts';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDayMonth } from '@/lib/gymFormat';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  cardMutedTextStyle, cardSectionLabelStyle, formControlStyle, formErrorStyle, innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { ProgressExerciseDetailsModal } from './ProgressExerciseDetailsModal';
import {
  combinedChartSeries, dayFlagLines, draftFromReading, formatValue, groupReadingsByDate, metricLabelKey, progressChartPoints, readingChartX, readingPayload, resultUnitKey,
  type ProgressDetail, type ProgressReading, type ProgressSummary, type ReadingDraft,
} from './progressView';

/**
 * #1231 — the Member card's **Progress** tab: one collapsible card per exercise
 * the member has logged, with #1224's summary and graph and a Readings card
 * (the individual `exercise_logs`) whose rows can be edited (value and notes,
 * never the date) or hard-deleted from their `⋮` menu. Every figure is the
 * API's; an edit or delete reloads the exercise so nothing stale stays visible.
 */
export function MemberProgress({ memberId, canWrite }: { memberId: number | string; canWrite: boolean }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [items, setItems] = useState<ProgressSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [detailsFor, setDetailsFor] = useState<ProgressSummary | null>(null);
  const [deletingExercise, setDeletingExercise] = useState<ProgressSummary | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const base = `/members/${memberId}/progress`;

  async function deleteExercise(item: ProgressSummary) {
    setDeleteBusy(true);
    try {
      await apiFetch(`${base}/exercises/${item.exercise_id}`, { method: 'DELETE' });
      setDeletingExercise(null);
      setDeleteError(false);
      if (open === item.exercise_id) setOpen(null);
      load();
    } catch {
      setDeleteError(true);
      setOpen(item.exercise_id);
      setDeletingExercise(null);
    } finally { setDeleteBusy(false); }
  }

  const load = useCallback(() => {
    apiFetch<ProgressSummary[]>(`${base}/exercises`)
      .then((rows) => { setItems(rows); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => { load(); }, [load]);

  if (failed) return <p style={formErrorStyle}>{t('members.progress_error')}</p>;
  if (items === null) return <p style={cardMutedTextStyle}>{t('members.progress_loading')}</p>;
  if (items.length === 0) return <p style={cardMutedTextStyle}>{t('members.progress_empty')}</p>;

  return (
    <>
    <ProgressExerciseDetailsModal exercise={detailsFor} onClose={() => setDetailsFor(null)} />
    <ConfirmDialog
      open={deletingExercise !== null}
      message={t('members.progress_delete_exercise_confirm')}
      confirmLabel={t('members.progress_delete_exercise')}
      cancelLabel={t('members.progress_cancel')}
      busy={deleteBusy}
      onConfirm={() => deletingExercise && deleteExercise(deletingExercise)}
      onCancel={() => setDeletingExercise(null)}
    />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => {
        const isOpen = open === item.exercise_id;
        return (
          <div key={item.exercise_id} style={innerCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : item.exercise_id)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', flex: 1, minWidth: 0 }}
            >
              <ExerciseAvatar src={item.image_thumbnail_url ?? item.image_url ?? null} name={item.exercise_name} />
              <strong style={{ flex: '1 1 160px' }}>{item.exercise_name}</strong>
              <Stat label={t('members.progress_days')} value={String(item.days_exercised)} />
              {item.metrics.map((m) => (
                <Stat key={m.slug} label={t(metricLabelKey(m.slug))} value={formatValue(m.value, t(resultUnitKey(m.slug)!), gym)} />
              ))}
            </button>
            <ContextMenu
              ariaLabel={t('members.progress_exercise_actions')}
              items={[
                { label: t('members.progress_details'), onClick: () => setDetailsFor(item) },
                { label: t('members.progress_delete_exercise'), danger: true, disabled: !canWrite,
                  title: canWrite ? undefined : t('common.read_only_hint'), onClick: () => { setDeleteError(false); setDeletingExercise(item); } },
              ]}
            />
            </div>
            {deleteError && deletingExercise === null && open === item.exercise_id && <p style={formErrorStyle}>{t('members.progress_delete_exercise_error')}</p>}
            {isOpen && (
              <ExerciseDetail
                base={base}
                item={item}
                canWrite={canWrite}
                onChanged={load}
              />
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

const AVATAR_SIZE = 36;

/** Circular exercise picture (the API's sex-resolved thumbnail); a neutral disc when there is none or it fails to load. */
function ExerciseAvatar({ src, name }: { src: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  const style: React.CSSProperties = {
    width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
    background: 'var(--gd-app-bg, #f3f4f6)', border: '1px solid var(--gd-card-border, #e5e7eb)', boxSizing: 'border-box',
  };
  if (src && SAFE_IMAGE_SRC.test(src) && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} style={style} />;
  }
  return <span aria-hidden="true" style={{ ...style, display: 'inline-block' }} />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={cardSectionLabelStyle}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function ExerciseDetail({ base, item, canWrite, onChanged }: {
  base: string; item: ProgressSummary; canWrite: boolean; onChanged: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [detail, setDetail] = useState<ProgressDetail | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ReadingDraft | null>(null);
  const [deleting, setDeleting] = useState<ProgressReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #2178 — a hovered day wins over the day a click pinned; a second click unpins it.
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [pinnedX, setPinnedX] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setDetail(await apiFetch<ProgressDetail>(`${base}/exercises/${item.exercise_id}`));
    } catch {
      // Deleting the last reading leaves no progress: the exercise leaves the list.
      setDetail(null);
    }
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, item.exercise_id]);
  useEffect(() => {
    apiFetch<ProgressDetail>(`${base}/exercises/${item.exercise_id}`).then(setDetail).catch(() => setDetail(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, item.exercise_id]);

  const chartSeries = useMemo(() => combinedChartSeries(
    detail?.metric_days ?? [],
    (slug) => t(metricLabelKey(slug)),
    (slug) => t(resultUnitKey(slug)!),
    gym,
    (date) => dayFlagLines(date, detail?.readings ?? [], {
      sets: (n) => t('members.progress_flag_sets', { n }),
      maxWeight: (v) => t('members.progress_flag_max_weight', { v }),
      maxReps: (v) => t('members.progress_flag_max_reps', { v }),
    }, gym, { kg: t('members.progress_unit_kg'), reps: t('members.progress_unit_reps') }),
  ), [detail, gym, t]);
  if (!detail) return null;

  async function save(r: ProgressReading) {
    const payload = draft ? readingPayload(draft) : null;
    if (!payload) { setError(t('members.progress_invalid')); return; }
    setBusy(true); setError(null);
    try {
      await apiFetch(`${base}/readings/${r.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setEditingId(null); setDraft(null);
      await reload();
    } catch { setError(t('members.progress_save_error')); } finally { setBusy(false); }
  }

  async function remove(r: ProgressReading) {
    setBusy(true); setError(null);
    try {
      await apiFetch(`${base}/readings/${r.id}`, { method: 'DELETE' });
      setDeleting(null);
      await reload();
    } catch { setError(t('members.progress_delete_error')); setDeleting(null); } finally { setBusy(false); }
  }

  const input = { ...formControlStyle, width: 90 };
  const cell: React.CSSProperties = { padding: '2px 12px 2px 0', fontSize: 13 };
  const rowGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '36px 56px 90px minmax(0, 1fr) auto', alignItems: 'center' };

  function renderReading(r: ProgressReading, divider: boolean) {
    const editing = editingId === r.id && draft;
    const wrap: React.CSSProperties = divider ? { borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: 2 } : {};
    const menu = (
      <ContextMenu
        ariaLabel={t('members.progress_reading_actions')}
        items={[
          { label: t('members.progress_edit'), disabled: !canWrite, title: canWrite ? undefined : t('common.read_only_hint'),
            onClick: () => { setEditingId(r.id); setDraft(draftFromReading(r)); setError(null); } },
          { label: t('members.progress_delete'), danger: true, disabled: !canWrite, title: canWrite ? undefined : t('common.read_only_hint'),
            onClick: () => setDeleting(r) },
        ]}
      />
    );
    if (editing) {
      return (
        <div key={r.id} style={{ ...wrap, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          {draft.sets.map((s, i) => (
            <span key={s.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span>{t('members.progress_set', { n: r.sets[i].set_number })}</span>
              <input aria-label={t('members.progress_weight')} style={input} value={s.weight} inputMode="decimal"
                onChange={(e) => setDraft({ ...draft, sets: draft.sets.map((x) => (x.id === s.id ? { ...x, weight: e.target.value } : x)) })} />
              <input aria-label={t('members.progress_reps')} style={input} value={s.reps} inputMode="numeric"
                onChange={(e) => setDraft({ ...draft, sets: draft.sets.map((x) => (x.id === s.id ? { ...x, reps: e.target.value } : x)) })} />
            </span>
          ))}
          <input aria-label={t('members.progress_duration')} style={input} value={draft.duration} inputMode="numeric"
            onChange={(e) => setDraft({ ...draft, duration: e.target.value })} />
          <input aria-label={t('members.progress_notes')} style={{ ...formControlStyle, flex: '1 1 160px' }} value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          <button type="button" style={primaryBtnSmall()} disabled={busy} onClick={() => save(r)}>{t('members.progress_save')}</button>
          <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={() => { setEditingId(null); setDraft(null); setError(null); }}>{t('members.progress_cancel')}</button>
        </div>
      );
    }
    const sets = [...r.sets].sort((a, b) => a.set_number - b.set_number);
    const extra = (
      <span style={{ ...cell, minWidth: 0 }}>
        {r.skipped ? t('members.progress_skipped') : null}
        {!r.skipped && r.duration_seconds !== null ? formatValue(r.duration_seconds, t('members.progress_unit_seconds'), gym) : null}
        {!r.skipped && sets.length === 0 && r.duration_seconds === null ? '—' : null}
        {r.notes ? <em style={{ display: 'block' }}>{r.notes}</em> : null}
      </span>
    );
    const rows = r.skipped ? [] : sets;
    return (
      <div key={r.id} style={wrap}>
        {rows.length === 0 ? (
          <div style={rowGrid}>
            <span /><span /><span />
            {extra}
            {menu}
          </div>
        ) : rows.map((s, i) => (
          <div key={s.id} style={rowGrid}>
            <span style={cell}>{s.set_number}</span>
            <span style={cell}>{formatValue(s.reps, null, gym)}</span>
            <span style={cell}>{formatValue(s.weight, t('members.progress_unit_kg'), gym)}</span>
            {i === 0 ? extra : <span />}
            {i === 0 ? menu : <span />}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {chartSeries.length > 0 && (
        <LineChart
          series={chartSeries}
          height={220}
          selectedX={hoverX ?? pinnedX}
          ariaLabel={t('members.progress_chart_aria', { name: item.exercise_name })}
          axisLabelFormatter={(value) => formatGymDayMonth(new Date(value).toISOString().slice(0, 10), gym)}
        />
      )}
      <div style={innerCardStyle}>
        <span style={cardSectionLabelStyle}>{t('members.progress_readings')}</span>
        {error && <p style={formErrorStyle}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, padding: '4px 0' }}>
          <span style={{ width: 70, flexShrink: 0, ...cardSectionLabelStyle }}>{t('members.progress_col_date')}</span>
          <div style={{ ...rowGrid, flex: 1 }}>
            {['progress_col_set', 'progress_reps', 'progress_weight'].map((k) => (
              <span key={k} style={{ ...cardSectionLabelStyle, padding: '2px 12px 2px 0' }}>{t(`members.${k}`)}</span>
            ))}
            <span /><span />
          </div>
        </div>
        {groupReadingsByDate(detail.readings).map((group) => {
          const x = readingChartX(group.date);
          const active = (hoverX ?? pinnedX) === x;
          return (
            <div key={group.date} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <button
                type="button"
                aria-pressed={pinnedX === x}
                onMouseEnter={() => setHoverX(x)}
                onMouseLeave={() => setHoverX(null)}
                onFocus={() => setHoverX(x)}
                onBlur={() => setHoverX(null)}
                onClick={() => setPinnedX(pinnedX === x ? null : x)}
                style={{ all: 'unset', cursor: 'pointer', width: 70, flexShrink: 0, fontWeight: active ? 700 : 400, color: active ? 'var(--brand, inherit)' : 'inherit' }}
              >
                {formatGymDayMonth(group.date, gym)}
              </button>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {group.readings.map((r, ri) => renderReading(r, ri > 0))}
              </div>
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        message={t('members.progress_delete_confirm')}
        confirmLabel={t('members.progress_delete')}
        cancelLabel={t('members.progress_cancel')}
        busy={busy}
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
