'use client';

// #647 stages 2–3 — the Member's weekly Personal Training slot grid.
//
// Monday through Sunday in parallel columns (§1), showing the *recurring*
// slots the Member could take over the next 2 months, not individual dates.
// Stage 3 makes the grid interactive: each slot is a checkbox (§2, multiple
// slots across different days and times), and the Book button reserves the
// window for everything ticked (§3). The nightly rolling window is stage 4.
//
// Everything shown here — which occurrences count, which Professional
// Services the Member holds, whether a date is bookable and why not, and what
// a Book run actually did — is decided by
// /members/:memberId/personal-training-slots. This file formats, it never
// recomputes (CLAUDE.md: no business logic in the frontend).
//
// A slot is kept in the grid even when some of its dates are taken, per the
// #647 thread's Q5 answer ("if a slot is already booked or it is a festivity,
// system will silently ignore it"): the count line says how many of the
// window's dates are actually free, so a partly-blocked Monday reads as
// "7 / 9" rather than disappearing.
//
// Ticking a box does not write anything on its own — one Book request carries
// the whole selection, so the Member's weekly pattern and their bookings are
// stored in the same action. Unticking a slot and pressing Save drops the
// pattern without touching bookings already made (§5).

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { useModuleAccess } from '@/lib/useModuleAccess';

type SlotDateStatus = 'available' | 'no_occurrence' | 'not_scheduled' | 'full' | 'already_booked';

interface SlotDate {
  date: string;
  calendar_event_id: number | null;
  status: SlotDateStatus;
}

interface SlotIdentity {
  weekday: number;
  start_time: string;
  end_time: string;
  activity_type_id: number;
  professional_service_id: number;
  center_id: number | null;
}

interface WeeklySlot extends SlotIdentity {
  professional_service_name: string;
  activity_type_name: string;
  center_name: string | null;
  dates: SlotDate[];
  occurrence_count: number;
  available_count: number;
  already_booked_count: number;
  fully_available: boolean;
  selected: boolean;
}

interface WeeklySlotDay {
  weekday: number;
  slots: WeeklySlot[];
}

interface MemberProfessionalService {
  professional_service_id: number;
  name: string;
  sessions: number;
}

interface StoredSelection extends SlotIdentity {
  id: number;
  matched: boolean;
}

interface PersonalTrainingSlots {
  timezone: string;
  window: { from: string; to: string; months: number };
  professional_services: MemberProfessionalService[];
  selections: StoredSelection[];
  days: WeeklySlotDay[];
}

interface BookResult {
  date: string;
  outcome: 'booked' | 'skipped' | 'failed';
  reason?: string;
}

interface BookReport {
  created: number;
  skipped: number;
  failed: number;
  slots: { weekday: number; start_time: string; end_time: string; results: BookResult[] }[];
}

/**
 * The API returns ISO weekdays (1=Mon … 7=Sun) so the grid reads Monday-first
 * as §1 asks; the shared `weekday` label namespace is keyed 0=Sun … 6=Sat, so
 * Sunday (7) folds back to 0.
 */
function weekdayKey(isoWeekday: number): string {
  return String(isoWeekday % 7);
}

/** DD/MM from a plain YYYY-MM-DD, without going through Date (no timezone shift). */
function fmtShortDay(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

/** The slot identity the API keys selections on, as a string for local state. */
function slotKey(s: SlotIdentity): string {
  return [
    s.weekday, s.start_time, s.end_time,
    s.activity_type_id, s.professional_service_id, s.center_id ?? '',
  ].join('|');
}

function identityOf(s: SlotIdentity): SlotIdentity {
  return {
    weekday: s.weekday,
    start_time: s.start_time,
    end_time: s.end_time,
    activity_type_id: s.activity_type_id,
    professional_service_id: s.professional_service_id,
    center_id: s.center_id,
  };
}

export function MemberPersonalTrainingSlots({ memberId }: { memberId: number }) {
  const t = useTranslations('members');
  const tWeekday = useTranslations('weekday');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  // The API gates both writes on requireModuleWrite('MEMBERS'); a read-only
  // role still sees the grid, with the controls disabled and explained.
  const { canWrite, readOnlyTitle } = useModuleAccess('MEMBERS');
  const loadedRef = useRef(false);

  const [data, setData] = useState<PersonalTrainingSlots | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Ticked boxes, keyed by slot identity. Seeded from the stored selections.
  const [picked, setPicked] = useState<Record<string, SlotIdentity>>({});
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<BookReport | null>(null);

  function apply(payload: PersonalTrainingSlots) {
    setData(payload);
    const next: Record<string, SlotIdentity> = {};
    // Only selections the grid still offers can be re-submitted; an unmatched
    // one (the Member lost the service, §5) is reported below instead.
    for (const s of payload.selections) {
      if (s.matched) next[slotKey(s)] = identityOf(s);
    }
    setPicked(next);
  }

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        apply(await apiFetch<PersonalTrainingSlots>(`/members/${memberId}/personal-training-slots`));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(slot: WeeklySlot) {
    const key = slotKey(slot);
    setPicked((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = identityOf(slot);
      return next;
    });
  }

  async function submit(mode: 'save' | 'book') {
    if (saving) return;
    setSaving(true);
    setReport(null);
    const slots = Object.values(picked);
    try {
      if (mode === 'save') {
        await apiFetch(`/members/${memberId}/personal-training-slots/selections`, {
          method: 'PUT',
          body: JSON.stringify({ slots }),
        });
        toast(t('pt_slots_saved'), 'success');
      } else {
        const result = await apiFetch<BookReport>(`/members/${memberId}/personal-training-slots/book`, {
          method: 'POST',
          body: JSON.stringify({ slots }),
        });
        setReport(result);
        toast(
          t('pt_slots_book_summary', {
            created: result.created, skipped: result.skipped, failed: result.failed,
          }),
          result.failed > 0 ? 'error' : 'success',
        );
      }
      // Re-read: booking changes every affected date's status, and the stored
      // pattern is now whatever the server accepted.
      apply(await apiFetch<PersonalTrainingSlots>(`/members/${memberId}/personal-training-slots`));
    } catch (err) {
      toast((err as Error).message || t('pt_slots_error'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={dim}>{t('pt_slots_loading')}</p>;
  if (error) return <p style={dim}>{t('pt_slots_error')}</p>;
  if (!data) return null;

  if (data.professional_services.length === 0) {
    return <p style={dim}>{t('pt_slots_no_services')}</p>;
  }

  const hasAnySlot = data.days.some((d) => d.slots.length > 0);
  const unmatched = data.selections.filter((s) => !s.matched);
  const pickedCount = Object.keys(picked).length;

  return (
    <div>
      <p style={dim}>
        {t('pt_slots_window', { from: fmtShortDay(data.window.from), to: fmtShortDay(data.window.to) })}
        {' · '}
        {data.professional_services.map((s) => `${s.name} (${s.sessions})`).join(', ')}
      </p>

      {unmatched.length > 0 && (
        <p style={warn}>
          {t('pt_slots_unmatched', {
            count: unmatched.length,
            slots: unmatched
              .map((s) => `${tWeekday(weekdayKey(s.weekday))} ${s.start_time}`)
              .join(', '),
          })}
        </p>
      )}

      {!hasAnySlot ? (
        <p style={dim}>{t('pt_slots_none')}</p>
      ) : (
        <>
          <div style={grid}>
            {data.days.map((day) => (
              <div key={day.weekday} style={column}>
                <div style={columnHeader}>{tWeekday(weekdayKey(day.weekday))}</div>
                {day.slots.length === 0 ? (
                  <div style={emptyCell}>—</div>
                ) : (
                  day.slots.map((slot) => {
                    const key = slotKey(slot);
                    const isOpen = expanded === key;
                    const isPicked = Boolean(picked[key]);
                    return (
                      <div key={key} style={slot.available_count > 0 ? slotCard : slotCardBlocked}>
                        <label style={pickRow} title={readOnlyTitle}>
                          <input
                            type="checkbox"
                            checked={isPicked}
                            disabled={!canWrite || saving}
                            onChange={() => toggle(slot)}
                          />
                          <span style={slotTime}>{slot.start_time}–{slot.end_time}</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : key)}
                          style={slotButton}
                          aria-expanded={isOpen}
                        >
                          <div style={slotMeta}>{slot.professional_service_name}</div>
                          <div style={slotMeta}>{slot.activity_type_name}</div>
                          {slot.center_name && <div style={slotMeta}>{slot.center_name}</div>}
                          <div style={slot.fully_available ? countFull : countPartial}>
                            {t('pt_slots_available_count', {
                              available: slot.available_count,
                              total: slot.occurrence_count,
                            })}
                            {slot.already_booked_count > 0 && (
                              <span> · {t('pt_slots_already_booked_count', { count: slot.already_booked_count })}</span>
                            )}
                          </div>
                        </button>
                        {isOpen && (
                          <ul style={dateList}>
                            {slot.dates.map((d) => (
                              <li key={d.date} style={dateRow}>
                                <span>{fmtShortDay(d.date)}</span>
                                <span style={d.status === 'available' ? dateOk : dateBlocked}>
                                  {t(`pt_slots_status_${d.status}`)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            ))}
          </div>

          <div style={actions}>
            <span style={dim}>{t('pt_slots_selected_count', { count: pickedCount })}</span>
            <button
              type="button"
              onClick={() => submit('save')}
              disabled={!canWrite || saving}
              title={readOnlyTitle}
              style={secondaryButton}
            >
              {t('pt_slots_save')}
            </button>
            <button
              type="button"
              onClick={() => submit('book')}
              disabled={!canWrite || saving || pickedCount === 0}
              title={readOnlyTitle}
              style={primaryButton}
            >
              {saving ? t('pt_slots_booking') : t('pt_slots_book')}
            </button>
          </div>
        </>
      )}

      {report && (
        <div style={reportBox}>
          <p style={reportHeading}>
            {t('pt_slots_book_summary', {
              created: report.created, skipped: report.skipped, failed: report.failed,
            })}
          </p>
          {report.slots.map((s) => {
            const notBooked = s.results.filter((r) => r.outcome !== 'booked');
            if (notBooked.length === 0) return null;
            return (
              <div key={`${s.weekday}-${s.start_time}`} style={reportSlot}>
                <div style={slotMeta}>
                  {tWeekday(weekdayKey(s.weekday))} {s.start_time}–{s.end_time}
                </div>
                <ul style={dateList}>
                  {notBooked.map((r) => (
                    <li key={r.date} style={dateRow}>
                      <span>{fmtShortDay(r.date)}</span>
                      <span style={dateBlocked}>
                        {r.outcome === 'failed'
                          ? t('pt_slots_result_failed', { reason: r.reason ?? '' })
                          : t(`pt_slots_status_${(r.reason ?? 'no_occurrence') as SlotDateStatus}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: '0 0 8px' };
const warn: React.CSSProperties = { color: '#a06000', fontSize: 12, margin: '0 0 8px' };
const grid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(7, minmax(120px, 1fr))',
  gap: 8, overflowX: 'auto',
};
const column: React.CSSProperties = { minWidth: 120 };
const columnHeader: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 6, textAlign: 'center',
};
const emptyCell: React.CSSProperties = { color: '#ccc', fontSize: 12, textAlign: 'center', padding: '8px 0' };
const slotCard: React.CSSProperties = {
  background: '#fff', border: '1px solid #e8e8ed', borderRadius: 6, marginBottom: 6,
};
const slotCardBlocked: React.CSSProperties = { ...slotCard, background: '#fafafa', borderStyle: 'dashed' };
const pickRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 0', cursor: 'pointer',
};
const slotButton: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none',
  border: 'none', padding: '2px 8px 6px', cursor: 'pointer', font: 'inherit',
};
const slotTime: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const slotMeta: React.CSSProperties = { fontSize: 12, color: '#888' };
const countFull: React.CSSProperties = { fontSize: 11, color: '#2e7d32', marginTop: 2 };
const countPartial: React.CSSProperties = { fontSize: 11, color: '#a06000', marginTop: 2 };
const dateList: React.CSSProperties = {
  listStyle: 'none', margin: 0, padding: '0 8px 8px', borderTop: '1px solid #f4f4f6',
};
const dateRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '2px 0',
};
const dateOk: React.CSSProperties = { color: '#2e7d32' };
const dateBlocked: React.CSSProperties = { color: '#888' };
const actions: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
};
const primaryButton: React.CSSProperties = {
  padding: '6px 14px', borderRadius: 6, border: '1px solid #2e7d32',
  background: '#2e7d32', color: '#fff', fontSize: 13, cursor: 'pointer',
};
const secondaryButton: React.CSSProperties = {
  padding: '6px 14px', borderRadius: 6, border: '1px solid #ddd',
  background: '#fff', color: '#333', fontSize: 13, cursor: 'pointer',
};
const reportBox: React.CSSProperties = {
  marginTop: 10, padding: '8px 10px', background: '#fafafa',
  border: '1px solid #eee', borderRadius: 6,
};
const reportHeading: React.CSSProperties = { fontSize: 12, fontWeight: 600, margin: '0 0 6px' };
const reportSlot: React.CSSProperties = { marginBottom: 6 };
