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
import {
  draftFromReading, formatValue, progressChartPoints, readingPayload, resultUnitKey,
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
        const unitKey = resultUnitKey(item.best_result?.slug);
        const isOpen = open === item.exercise_id;
        return (
          <div key={item.exercise_id} style={innerCardStyle}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : item.exercise_id)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', width: '100%' }}
            >
              <strong style={{ flex: '1 1 160px' }}>{item.exercise_name}</strong>
              <Stat label={t('members.progress_days')} value={String(item.days_exercised)} />
              <Stat label={t('members.progress_max_weight')} value={formatValue(item.max_weight, t('members.progress_unit_kg'), gym)} />
              <Stat label={t('members.progress_best_result')} value={formatValue(item.best_result?.value ?? null, unitKey ? t(unitKey) : null, gym)} />
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

  const unitKey = resultUnitKey(item.result_kind?.slug);
  const unit = unitKey ? t(unitKey) : null;
  const points = useMemo(() => (detail ? progressChartPoints(detail.days, unit, gym) : []), [detail, unit, gym]);
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
      {points.some((p) => p.y !== null) && (
        <LineChart
          points={points}
          height={200}
          ariaLabel={t('members.progress_chart_aria', { name: item.exercise_name })}
          axisLabelFormatter={(value) => formatGymDayMonth(new Date(value).toISOString().slice(0, 10), gym)}
        />
      )}
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
                      [
                        ...r.sets.map((s) => `${formatValue(s.weight, t('members.progress_unit_kg'), gym)} × ${formatValue(s.reps, null, gym)}`),
                        r.duration_seconds !== null ? formatValue(r.duration_seconds, t('members.progress_unit_seconds'), gym) : null,
                      ].filter(Boolean).join(' · ') || '—'
                    )}
                    {r.notes ? <em style={{ marginLeft: 8 }}>{r.notes}</em> : null}
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
