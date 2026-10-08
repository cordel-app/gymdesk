'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { formControlStyle, formFieldLabelStyle, secondaryBtnSmall } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { formatGymAmount, formatGymDateTime, type GymFormatSettings } from '@/lib/gymFormat';

// #1246 stage 1: the gym's Time & Localization settings. The accepted values
// are the API's (`api/src/domain/gymLocalization.ts`); the options below only
// mirror them for the dropdowns and the API stays the authority.
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
const TIME_FORMATS = ['24h', '12h'];
const NUMBER_FORMATS = ['comma_decimal', 'dot_decimal'];
const CURRENCIES = ['EUR'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function timeZones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return fn ? fn('timeZone') : ['Europe/Madrid'];
}

export default function LocalizationPage() {
  const t = useTranslations('localization');
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin } = useGym();
  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'SYSTEM'));
  const [saved, setSaved] = useState<GymFormatSettings | null>(null);
  const [draft, setDraft] = useState<GymFormatSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSaved((await apiFetch('/system/localization')) as GymFormatSettings);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch, activeGym?.id]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const next = (await apiFetch('/system/localization', { method: 'PUT', body: JSON.stringify(draft) })) as GymFormatSettings;
      setSaved(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!saved) return <div style={{ padding: 24 }}>{error ?? '…'}</div>;
  const view = editing && draft ? draft : saved;
  const set = (k: keyof GymFormatSettings, v: string | number) => setDraft({ ...(draft ?? saved), [k]: v });

  const field = (key: keyof GymFormatSettings, label: string, options: { value: string | number; label: string }[]) => (
    <div>
      <label style={formFieldLabelStyle}>{label}</label>
      {editing ? (
        <select
          style={formControlStyle}
          value={String(view[key])}
          onChange={(e) => set(key, key === 'first_day_of_week' ? Number(e.target.value) : e.target.value)}
        >
          {options.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
        </select>
      ) : (
        <div style={{ padding: '8px 10px', fontSize: 14, border: '1px solid transparent' }}>
          {options.find((o) => String(o.value) === String(view[key]))?.label ?? String(view[key])}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>{t('title')}</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {field('time_zone', t('time_zone'), timeZones().map((z) => ({ value: z, label: z })))}
        {field('first_day_of_week', t('first_day_of_week'), WEEKDAYS.map((d) => ({ value: d, label: t(`weekday_${d}`) })))}
        {field('date_format', t('date_format'), DATE_FORMATS.map((f) => ({ value: f, label: f })))}
        {field('time_format', t('time_format'), TIME_FORMATS.map((f) => ({ value: f, label: t(`time_format_${f}`) })))}
        {field('number_format', t('number_format'), NUMBER_FORMATS.map((f) => ({ value: f, label: t(`number_format_${f}`) })))}
        {field('currency', t('currency'), CURRENCIES.map((c) => ({ value: c, label: c })))}
      </div>
      <p style={{ color: '#666', fontSize: 13 }}>
        {t('preview')}: {formatGymDateTime(new Date(), view)} · {formatGymAmount(1234.5, view)}
      </p>
      {error && <p style={{ color: 'var(--gd-alert-text, #b91c1c)' }}>{error}</p>}
      {canWrite && (
        <div style={{ display: 'flex', gap: 8 }}>
          {editing ? (
            <>
              <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
              <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setEditing(false); setDraft(null); setError(null); }}>{t('cancel')}</button>
            </>
          ) : (
            <button style={primaryBtnSmall()} onClick={() => { setDraft(saved); setEditing(true); }}>{t('edit')}</button>
          )}
        </div>
      )}
    </div>
  );
}
