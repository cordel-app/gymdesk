'use client';

// #647 stage 2 — the Member's weekly Personal Training slot grid.
//
// Monday through Sunday in parallel columns (§1), showing the *recurring*
// slots the Member could take over the next 2 months, not individual dates.
// Read-only in this stage: selecting slots and the Book button are stage 3,
// the rolling window job is stage 4.
//
// Everything shown here — which occurrences count, which Professional
// Services the Member holds, whether a date is bookable and why not — is
// decided by GET /members/:memberId/personal-training-slots. This file
// formats, it never recomputes (CLAUDE.md: no business logic in the frontend).
//
// A slot is kept in the grid even when some of its dates are taken, per the
// #647 thread's Q5 answer ("if a slot is already booked or it is a festivity,
// system will silently ignore it"): the count line says how many of the
// window's dates are actually free, so a partly-blocked Monday reads as
// "7 / 9" rather than disappearing.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';

type SlotDateStatus = 'available' | 'no_occurrence' | 'not_scheduled' | 'full' | 'already_booked';

interface SlotDate {
  date: string;
  calendar_event_id: number | null;
  status: SlotDateStatus;
}

interface WeeklySlot {
  weekday: number;
  start_time: string;
  end_time: string;
  professional_service_id: number;
  professional_service_name: string;
  activity_type_id: number;
  activity_type_name: string;
  center_id: number | null;
  center_name: string | null;
  dates: SlotDate[];
  occurrence_count: number;
  available_count: number;
  already_booked_count: number;
  fully_available: boolean;
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

interface PersonalTrainingSlots {
  timezone: string;
  window: { from: string; to: string; months: number };
  professional_services: MemberProfessionalService[];
  days: WeeklySlotDay[];
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

export function MemberPersonalTrainingSlots({ memberId }: { memberId: number }) {
  const t = useTranslations('members');
  const tWeekday = useTranslations('weekday');
  const { apiFetch } = useApiClient();
  const loadedRef = useRef(false);

  const [data, setData] = useState<PersonalTrainingSlots | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        setData(await apiFetch<PersonalTrainingSlots>(`/members/${memberId}/personal-training-slots`));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p style={dim}>{t('pt_slots_loading')}</p>;
  if (error) return <p style={dim}>{t('pt_slots_error')}</p>;
  if (!data) return null;

  if (data.professional_services.length === 0) {
    return <p style={dim}>{t('pt_slots_no_services')}</p>;
  }

  const hasAnySlot = data.days.some((d) => d.slots.length > 0);

  return (
    <div>
      <p style={dim}>
        {t('pt_slots_window', { from: fmtShortDay(data.window.from), to: fmtShortDay(data.window.to) })}
        {' · '}
        {data.professional_services.map((s) => `${s.name} (${s.sessions})`).join(', ')}
      </p>

      {!hasAnySlot ? (
        <p style={dim}>{t('pt_slots_none')}</p>
      ) : (
        <div style={grid}>
          {data.days.map((day) => (
            <div key={day.weekday} style={column}>
              <div style={columnHeader}>{tWeekday(weekdayKey(day.weekday))}</div>
              {day.slots.length === 0 ? (
                <div style={emptyCell}>—</div>
              ) : (
                day.slots.map((slot) => {
                  const key = `${slot.weekday}-${slot.start_time}-${slot.activity_type_id}-${slot.professional_service_id}-${slot.center_id ?? ''}`;
                  const isOpen = expanded === key;
                  return (
                    <div key={key} style={slot.available_count > 0 ? slotCard : slotCardBlocked}>
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : key)}
                        style={slotButton}
                        aria-expanded={isOpen}
                      >
                        <div style={slotTime}>{slot.start_time}–{slot.end_time}</div>
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
      )}
    </div>
  );
}

const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: '0 0 8px' };
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
const slotButton: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none',
  border: 'none', padding: '6px 8px', cursor: 'pointer', font: 'inherit',
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
