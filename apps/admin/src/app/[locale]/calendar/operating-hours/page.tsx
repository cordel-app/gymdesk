'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeeklyShift {
  id?: number;
  weekday: number; // 0=Sun..6=Sat
  start_time: string;
  end_time: string;
}

interface Holiday {
  id: number;
  date_start: string;
  date_end: string;
  start_time: string | null;
  end_time: string | null;
  is_closed: number;
  annual_renewal: number;
  label: string | null;
  created_by_name: string | null;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const emptyHolidayForm = {
  date_start: '',
  date_end: '',
  start_time: '',
  end_time: '',
  is_closed: false,
  annual_renewal: false,
  label: '',
};
type HolidayForm = typeof emptyHolidayForm;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OperatingHoursPage() {
  const t = useTranslations('operating_hours');
  const tWeekday = useTranslations('weekday');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [shifts, setShifts] = useState<WeeklyShift[]>([]);
  const [weeklySaving, setWeeklySaving] = useState(false);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);

  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [inlineNew, setInlineNew] = useState<HolidayForm | null>(null);
  const [inlineNewSaving, setInlineNewSaving] = useState(false);
  const [inlineNewError, setInlineNewError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<HolidayForm>(emptyHolidayForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
    load();
  }, [gymLoading, isAdmin, activeGymId]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [weekly, hol] = await Promise.all([
        apiFetch<WeeklyShift[]>('/operating-hours/weekly'),
        apiFetch<Holiday[]>('/operating-hours/holidays'),
      ]);
      setShifts(weekly);
      setHolidays(hol);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Weekly hours ────────────────────────────────────────────────────────────

  function shiftsForDay(weekday: number): WeeklyShift[] {
    return shifts
      .map((s, idx) => ({ ...s, _idx: idx }))
      .filter((s) => s.weekday === weekday) as (WeeklyShift & { _idx: number })[];
  }

  function addShift(weekday: number) {
    setShifts([...shifts, { weekday, start_time: '09:00', end_time: '17:00' }]);
  }

  function removeShift(idx: number) {
    setShifts(shifts.filter((_, i) => i !== idx));
  }

  function updateShift(idx: number, field: 'start_time' | 'end_time', value: string) {
    setShifts(shifts.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  }

  async function saveWeekly() {
    for (const s of shifts) {
      if (!s.start_time || !s.end_time || s.start_time >= s.end_time) {
        setWeeklyError(t('error_generic'));
        return;
      }
    }
    setWeeklySaving(true);
    setWeeklyError(null);
    try {
      const saved = await apiFetch<WeeklyShift[]>('/operating-hours/weekly', {
        method: 'PUT',
        body: JSON.stringify({
          shifts: shifts.map((s) => ({ weekday: s.weekday, start_time: s.start_time, end_time: s.end_time })),
        }),
      });
      setShifts(saved);
      toast(t('saved'));
    } catch (err: any) {
      setWeeklyError(err.message ?? t('error_generic'));
    } finally {
      setWeeklySaving(false);
    }
  }

  // ─── Holidays ────────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({ ...emptyHolidayForm });
    setInlineNewError(null);
  }

  function cancelInlineNew() {
    setInlineNew(null);
    setInlineNewError(null);
  }

  function validateHolidayForm(f: HolidayForm): string | null {
    if (!f.date_start || !f.date_end) return t('error_generic');
    if (f.date_end < f.date_start) return t('error_generic');
    if (!f.is_closed) {
      if (!f.start_time || !f.end_time || f.start_time >= f.end_time) return t('error_generic');
    }
    return null;
  }

  function holidayPayload(f: HolidayForm) {
    return {
      date_start: f.date_start,
      date_end: f.date_end,
      is_closed: f.is_closed,
      start_time: f.is_closed ? null : f.start_time,
      end_time: f.is_closed ? null : f.end_time,
      annual_renewal: f.annual_renewal,
      label: f.label.trim() || null,
    };
  }

  async function saveInlineNew() {
    if (!inlineNew) return;
    const err = validateHolidayForm(inlineNew);
    if (err) { setInlineNewError(err); return; }
    setInlineNewSaving(true);
    setInlineNewError(null);
    try {
      await apiFetch<Holiday>('/operating-hours/holidays', {
        method: 'POST',
        body: JSON.stringify(holidayPayload(inlineNew)),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNewError(err.message ?? t('error_generic'));
    } finally {
      setInlineNewSaving(false);
    }
  }

  function openEdit(h: Holiday) {
    setEditingId(h.id);
    setEditForm({
      date_start: h.date_start.slice(0, 10),
      date_end: h.date_end.slice(0, 10),
      start_time: h.start_time ?? '',
      end_time: h.end_time ?? '',
      is_closed: !!h.is_closed,
      annual_renewal: !!h.annual_renewal,
      label: h.label ?? '',
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(id: number) {
    const err = validateHolidayForm(editForm);
    if (err) { setEditError(err); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/operating-hours/holidays/${id}`, {
        method: 'PUT',
        body: JSON.stringify(holidayPayload(editForm)),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/operating-hours/holidays/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtHoliday(h: Holiday) {
    const dates = h.date_start === h.date_end ? fmtDate(h.date_start) : `${fmtDate(h.date_start)} – ${fmtDate(h.date_end)}`;
    return dates;
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{t('title')}</h1>

      {loading ? (
        <p style={{ color: '#888' }}>—</p>
      ) : (
        <>
          {/* Weekly hours */}
          <SectionHeader title={t('section_weekly')} />
          <div style={cardStyle}>
            <div style={{ padding: '16px 20px' }}>
              {WEEKDAYS.map((weekday) => {
                const dayShifts = shiftsForDay(weekday);
                return (
                  <div key={weekday} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--gd-card-border, #f0f0f0)' }}>
                    <div style={{ width: 110, flexShrink: 0, fontWeight: 600, fontSize: 14, paddingTop: 6 }}>
                      {tWeekday(String(weekday) as any)}
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {dayShifts.length === 0 && (
                        <span style={{ fontSize: 13, color: '#aaa', paddingTop: 6 }}>{t('weekday_closed')}</span>
                      )}
                      {dayShifts.map((s: any) => (
                        <div key={s._idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="time"
                            value={s.start_time}
                            onChange={(e) => updateShift(s._idx, 'start_time', e.target.value)}
                            style={inlineInputStyle}
                          />
                          <span style={{ color: '#888' }}>–</span>
                          <input
                            type="time"
                            value={s.end_time}
                            onChange={(e) => updateShift(s._idx, 'end_time', e.target.value)}
                            style={inlineInputStyle}
                          />
                          <button onClick={() => removeShift(s._idx)} style={btnSmall('#c0392b')}>{t('remove_shift')}</button>
                        </div>
                      ))}
                      <div>
                        <button onClick={() => addShift(weekday)} style={btnSmall('#6c63ff')}>{t('add_shift')}</button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {weeklyError && <p style={errorStyle}>{weeklyError}</p>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={saveWeekly} disabled={weeklySaving} style={btnStyle('#6c63ff')}>
                  {weeklySaving ? t('saving') : t('save_weekly')}
                </button>
              </div>
            </div>
          </div>

          {/* Holidays */}
          <div style={{ marginTop: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <SectionHeader title={t('section_holidays')} />
            <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>{t('add_holiday')}</button>
          </div>

          {inlineNew && (
            <div style={cardStyle}>
              <div style={{ padding: '16px 20px' }}>
                {renderHolidayForm(inlineNew, setInlineNew, t)}
                {inlineNewError && <p style={errorStyle}>{inlineNewError}</p>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
                  <button onClick={saveInlineNew} disabled={inlineNewSaving} style={btnSmall('#6c63ff')}>
                    {inlineNewSaving ? t('saving') : t('save_changes')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {holidays.length === 0 && !inlineNew ? (
            <p style={{ color: '#888', marginTop: 12 }}>{t('empty_holidays')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {holidays.length > 0 && (
                <div style={colHeaderStyle}>
                  <div style={{ flex: 2, minWidth: 160 }}>{t('col_dates')}</div>
                  <div style={{ flex: 2, minWidth: 140 }}>{t('col_hours')}</div>
                  <div style={{ minWidth: 90 }}>{t('col_annual_renewal')}</div>
                  <div style={{ flex: 2, minWidth: 140 }}>{t('col_label')}</div>
                  <div style={{ minWidth: 140 }}>{t('col_actions')}</div>
                </div>
              )}
              {holidays.map((h) => (
                <div key={h.id} style={cardStyle}>
                  {editingId === h.id ? (
                    <div style={{ padding: '16px 20px' }}>
                      {renderHolidayForm(editForm, setEditForm, t)}
                      {editError && <p style={errorStyle}>{editError}</p>}
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                        <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
                        <button onClick={() => saveEdit(h.id)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                          {editSaving ? t('saving') : t('save_changes')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 2, minWidth: 160, fontWeight: 600, fontSize: 14 }}>{fmtHoliday(h)}</div>
                      <div style={{ flex: 2, minWidth: 140, fontSize: 13, color: '#666' }}>
                        {h.is_closed ? t('label_is_closed') : `${h.start_time?.slice(0, 5)} – ${h.end_time?.slice(0, 5)}`}
                      </div>
                      <div style={{ minWidth: 90, fontSize: 13, color: '#666' }}>{h.annual_renewal ? t('yes') : t('no')}</div>
                      <div style={{ flex: 2, minWidth: 140, fontSize: 13, color: '#666' }}>{h.label ?? '—'}</div>
                      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                        <button onClick={() => openEdit(h)} style={btnSmall('#6c63ff')}>{t('edit_holiday')}</button>
                        <button onClick={() => setDeleting(h)} style={btnSmall('#c0392b')}>{t('delete_holiday')}</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={`${t('confirm_delete_title')}\n\n${t('confirm_delete_body')}`}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Shared holiday form ──────────────────────────────────────────────────────

function renderHolidayForm(
  form: HolidayForm,
  setForm: (f: HolidayForm) => void,
  t: ReturnType<typeof useTranslations>,
) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <label style={inlineLabelStyle}>{t('label_date_start')}</label>
        <input type="date" value={form.date_start} onChange={(e) => setForm({ ...form, date_start: e.target.value })} style={inlineInputStyleFull} />
      </div>
      <div>
        <label style={inlineLabelStyle}>{t('label_date_end')}</label>
        <input type="date" value={form.date_end} onChange={(e) => setForm({ ...form, date_end: e.target.value })} style={inlineInputStyleFull} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={form.is_closed}
            onChange={(e) => setForm({ ...form, is_closed: e.target.checked })}
            style={{ width: 15, height: 15 }}
          />
          {t('label_is_closed')}
        </label>
      </div>
      {!form.is_closed && (
        <>
          <div>
            <label style={inlineLabelStyle}>{t('label_start_time')}</label>
            <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} style={inlineInputStyleFull} />
          </div>
          <div>
            <label style={inlineLabelStyle}>{t('label_end_time')}</label>
            <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} style={inlineInputStyleFull} />
          </div>
        </>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={form.annual_renewal}
            onChange={(e) => setForm({ ...form, annual_renewal: e.target.checked })}
            style={{ width: 15, height: 15 }}
          />
          {t('label_annual_renewal')}
        </label>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={inlineLabelStyle}>{t('label_label')}</label>
        <input
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          placeholder={t('placeholder_label')}
          style={inlineInputStyleFull}
        />
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-card-border, #eee)', margin: '0 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff',
};

const inlineInputStyleFull: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const errorStyle: React.CSSProperties = {
  margin: '8px 0 0', fontSize: 13, color: '#c0392b',
};
