'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import {
  formActionsRowStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  formValueStyle,
  cardMutedTextStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { formatGymDateOnly } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import {
  TAX_PROFILE_LAYOUT,
  missingRequired,
  taxIdTypeOptions,
  toTaxProfileForm,
  toTaxProfilePayload,
  withCountry,
  type TaxProfile,
  type TaxProfileField,
  type TaxProfileForm,
  type TaxProfileOptions,
} from './taxComplianceView';

const ROOT = '/system/tax-compliance/profile';

/**
 * #2647 stage 1 / #2648 stage 8: the gym's fiscal identity (legal name, tax
 * number, fiscal address…), read-only until Edit. One editor, two hosts:
 * Settings → Tax & Compliance (the selected gym) and Cordel → Gyms → [Gym]
 * (the row's gym, through `apiFetch`'s `gymId`, #1052's device). It names the
 * tenant-scoped route only; the permission stays the server's (SYSTEM write)
 * and the host decides `canWrite`.
 */
export function TaxProfileSection({
  gymId,
  canWrite,
  onChanged,
}: {
  gymId?: string;
  canWrite: boolean;
  onChanged?: (profile: TaxProfile) => void;
}) {
  const t = useTranslations('tax_compliance');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();

  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [options, setOptions] = useState<TaxProfileOptions | null>(null);
  const [draft, setDraft] = useState<TaxProfileForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countryName = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { names = null; }
    return (code: string) => names?.of(code) ?? code;
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setDraft(null);
    setError(null);
    (async () => {
      try {
        const [p, o] = await Promise.all([
          apiFetch(ROOT, { gymId }) as Promise<TaxProfile>,
          apiFetch(`${ROOT}/options`, { gymId }) as Promise<TaxProfileOptions>,
        ]);
        if (cancelled) return;
        setProfile(p);
        setOptions(o);
        onChanged?.(p);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // onChanged is a notification, not an input of the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch, gymId]);

  const taxIdTypeLabel = (type: string) => t(`tax_id_type_${type}`);

  async function save() {
    if (!draft) return;
    const missing = missingRequired(draft);
    if (missing.length > 0) {
      setError(t('error_required', { fields: missing.map((k) => t(`field_${k}`)).join(', ') }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = (await apiFetch(ROOT, {
        method: 'PUT',
        gymId,
        body: JSON.stringify(toTaxProfilePayload(draft)),
      })) as TaxProfile;
      setProfile(next);
      setDraft(null);
      onChanged?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function readValue(key: TaxProfileField): string {
    const v = profile?.[key];
    if (v == null || v === '') return '—';
    if (key === 'country_code') return countryName(v);
    if (key === 'tax_id_type') return taxIdTypeLabel(v);
    if (key === 'tax_registration_date') return formatGymDateOnly(v, fmt);
    return v;
  }

  function control(key: TaxProfileField) {
    if (!draft) return null;
    const set = (v: string) => setDraft({ ...draft, [key]: v });
    if (key === 'country_code') {
      return (
        <select style={formControlStyle} value={draft.country_code} onChange={(e) => setDraft(withCountry(draft, e.target.value, options))} aria-label={t('field_country_code')}>
          <option value="">—</option>
          {(options?.countries ?? [])
            .map((c) => ({ c, label: countryName(c) }))
            .sort((a, b) => a.label.localeCompare(b.label, locale))
            .map(({ c, label }) => <option key={c} value={c}>{label}</option>)}
        </select>
      );
    }
    if (key === 'tax_id_type') {
      return (
        <select style={formControlStyle} value={draft.tax_id_type} disabled={!draft.country_code} onChange={(e) => set(e.target.value)} aria-label={t('field_tax_id_type')}>
          <option value="">—</option>
          {taxIdTypeOptions(options, draft.country_code).map((ty) => <option key={ty} value={ty}>{taxIdTypeLabel(ty)}</option>)}
        </select>
      );
    }
    return (
      <input
        style={formControlStyle}
        type={key === 'tax_registration_date' ? 'date' : 'text'}
        value={draft[key]}
        onChange={(e) => set(e.target.value)}
        aria-label={t(`field_${key}`)}
      />
    );
  }

  const editing = draft !== null;

  if (!profile) return <p style={cardMutedTextStyle}>{error ?? '…'}</p>;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {TAX_PROFILE_LAYOUT.map(({ key, required, full }) => (
          <div key={key} style={full ? { gridColumn: '1 / -1' } : undefined}>
            <label style={formFieldLabelStyle}>
              {t(`field_${key}`)}{editing && required ? ' *' : ''}
            </label>
            {editing ? control(key) : <div style={formValueStyle}>{readValue(key)}</div>}
          </div>
        ))}
      </div>
      {error && <p style={formErrorStyle}>{error}</p>}
      {canWrite && (
        <div style={formActionsRowStyle}>
          {editing ? (
            <>
              <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
              <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setDraft(null); setError(null); }}>{t('cancel')}</button>
            </>
          ) : (
            <button style={primaryBtnSmall()} onClick={() => { setDraft(toTaxProfileForm(profile)); setError(null); }}>{t('edit')}</button>
          )}
        </div>
      )}
    </>
  );
}
