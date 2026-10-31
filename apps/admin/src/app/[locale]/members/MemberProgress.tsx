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
import {
  draftFromReading, formatValue, metricLabelKey, progressChartPoints, readingPayload, resultUnitKey,
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
  const base = `/members/${memberId}/progress`;

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => {
        const isOpen = open === item.exercise_id;
        return (
          <div key={item.exercise_id} style={innerCardStyle}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : item.exercise_id)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', width: '100%' }}
            >
              <ExerciseAvatar src={item.image_thumbnail_url ?? item.image_url ?? null} name={item.exercise_name} />
              <strong style={{ flex: '1 1 160px' }}>{item.exercise_name}</strong>
              <Stat label={t('members.progress_days')} value={String(item.days_exercised)} />
              {item.metrics.map((m) => (
                <Stat key={m.slug} label={t(metricLabelKey(m.slug))} value={formatValue(m.value, t(resultUnitKey(m.slug)!), gym)} />
              ))}
            </button>
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

  const series = useMemo(() => (detail?.metric_days ?? []).map((m) => ({
    slug: m.slug,
    points: progressChartPoints(m.days, t(resultUnitKey(m.slug)!), gym),
  })), [detail, gym, t]);
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
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {series.filter((s) => s.points.some((p) => p.y !== null)).map((s) => (
        <div key={s.slug}>
          <span style={cardSectionLabelStyle}>{t(metricLabelKey(s.slug))}</span>
          <LineChart
            points={s.points}
            height={200}
            ariaLabel={t('members.progress_chart_aria', { name: `${item.exercise_name} (${t(metricLabelKey(s.slug))})` })}
            axisLabelFormatter={(value) => formatGymDayMonth(new Date(value).toISOString().slice(0, 10), gym)}
          />
        </div>
      ))}
      <div style={innerCardStyle}>
        <span style={cardSectionLabelStyle}>{t('members.progress_readings')}</span>
        {error && <p style={formErrorStyle}>{error}</p>}
        {detail.readings.map((r) => {
          const editing = editingId === r.id && draft;
          return (
            <div key={r.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <span style={{ width: 70 }}>{formatGymDayMonth(r.logged_date, gym)}</span>
              {editing ? (
                <>
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
                </>
              ) : (
                <>
                  <span style={{ flex: '1 1 200px' }}>
                    {r.skipped ? t('members.progress_skipped') : (
                      <>
                        {r.sets.length > 0 && (
                          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr>
                                {['progress_col_set', 'progress_reps', 'progress_weight'].map((k) => (
                                  <th key={k} style={{ ...cardSectionLabelStyle, textAlign: 'left', padding: '2px 12px 2px 0' }}>{t(`members.${k}`)}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {[...r.sets].sort((a, b) => a.set_number - b.set_number).map((s) => (
                                <tr key={s.id}>
                                  <td style={{ padding: '2px 12px 2px 0' }}>{s.set_number}</td>
                                  <td style={{ padding: '2px 12px 2px 0' }}>{formatValue(s.reps, null, gym)}</td>
                                  <td style={{ padding: '2px 12px 2px 0' }}>{formatValue(s.weight, t('members.progress_unit_kg'), gym)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {r.duration_seconds !== null && <div>{formatValue(r.duration_seconds, t('members.progress_unit_seconds'), gym)}</div>}
                        {r.sets.length === 0 && r.duration_seconds === null && '—'}
                      </>
                    )}
                    {r.notes ? <em style={{ display: 'block' }}>{r.notes}</em> : null}
                  </span>
                  <ContextMenu
                    ariaLabel={t('members.progress_reading_actions')}
                    items={[
                      { label: t('members.progress_edit'), disabled: !canWrite, title: canWrite ? undefined : t('common.read_only_hint'),
                        onClick: () => { setEditingId(r.id); setDraft(draftFromReading(r)); setError(null); } },
                      { label: t('members.progress_delete'), danger: true, disabled: !canWrite, title: canWrite ? undefined : t('common.read_only_hint'),
                        onClick: () => setDeleting(r) },
                    ]}
                  />
                </>
              )}
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
