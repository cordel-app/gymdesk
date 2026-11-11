'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CardSection } from '@/components/CardSection';
import {
  cardHintStyle,
  cardMutedTextStyle,
  formActionsRowStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  formValueStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import {
  TAX_CONFIGURATION_FIELDS,
  metadataText,
  regimeOptions,
  toTaxConfigurationForm,
  toTaxConfigurationPayload,
  type TaxConfiguration,
  type TaxConfigurationForm,
  type TaxConfigurationOptions,
} from './taxComplianceView';

/**
 * #2647 stage 2: Tax & Compliance → Tax Configuration. Read-only until Edit; the
 * offered regimes are the gym's fiscal country's (from the Tax Profile), and the
 * configuration changes no tax calculation.
 */
export function TaxConfigurationSection({
  country,
  options,
  canWrite,
  onChanged,
}: {
  country: string | null;
  options: TaxConfigurationOptions | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('tax_compliance');
  const { apiFetch } = useApiClient();
  const [config, setConfig] = useState<TaxConfiguration | null>(null);
  const [draft, setDraft] = useState<TaxConfigurationForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setConfig((await apiFetch('/system/tax-compliance/configuration')) as TaxConfiguration);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch]);

  const label = (field: string, value: string) => t(`${field}_${value}`);

  async function save() {
    if (!draft) return;
    const body = toTaxConfigurationPayload(draft);
    if (!body) {
      setError(t('error_metadata'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = (await apiFetch('/system/tax-compliance/configuration', { method: 'PUT', body: JSON.stringify(body) })) as TaxConfiguration;
      setConfig(next);
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const choices: Record<(typeof TAX_CONFIGURATION_FIELDS)[number], string[] | null> = {
    tax_regime: regimeOptions(options, country),
    tax_status: options?.tax_statuses ?? [],
    tax_calculation_method: options?.tax_calculation_methods ?? [],
    additional_tax_identification: null,
  };

  function readValue(key: (typeof TAX_CONFIGURATION_FIELDS)[number]): string {
    const v = config?.[key];
    if (v == null || v === '') return '—';
    return choices[key] ? label(key, v) : v;
  }

  return (
    <div style={{ ...innerCardStyle, marginTop: 16 }}>
      <CardSection label={t('section_configuration')} first>
        <p style={cardHintStyle}>{t('configuration_hint')}</p>
        {!config ? (
          <p style={cardMutedTextStyle}>{error ?? '…'}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {TAX_CONFIGURATION_FIELDS.map((key) => (
              <div key={key}>
                <label style={formFieldLabelStyle}>{t(`field_${key}`)}</label>
                {draft ? (
                  choices[key] ? (
                    <select style={formControlStyle} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
                      <option value="">—</option>
                      {/* A stored value the country no longer offers stays visible, disabled. */}
                      {draft[key] && !choices[key]!.includes(draft[key]) && (
                        <option value={draft[key]} disabled>{label(key, draft[key])}</option>
                      )}
                      {choices[key]!.map((v) => <option key={v} value={v}>{label(key, v)}</option>)}
                    </select>
                  ) : (
                    <input style={formControlStyle} value={draft[key]} aria-label={t(`field_${key}`)}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                  )
                ) : (
                  <div style={formValueStyle}>{readValue(key)}</div>
                )}
              </div>
            ))}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={formFieldLabelStyle}>{t('field_configuration_metadata')}</label>
              {draft ? (
                <textarea style={{ ...formControlStyle, minHeight: 90, fontFamily: 'monospace' }} value={draft.metadata}
                  aria-label={t('field_configuration_metadata')} placeholder='{ "key": "value" }'
                  onChange={(e) => setDraft({ ...draft, metadata: e.target.value })} />
              ) : (
                <pre style={{ ...formValueStyle, whiteSpace: 'pre-wrap', margin: 0 }}>{metadataText(config.configuration_metadata) || '—'}</pre>
              )}
            </div>
          </div>
        )}
        {error && config && <p style={formErrorStyle}>{error}</p>}
        {canWrite && config && (
          <div style={formActionsRowStyle}>
            {draft ? (
              <>
                <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
                <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setDraft(null); setError(null); }}>{t('cancel')}</button>
              </>
            ) : (
              <button style={primaryBtnSmall()} onClick={() => { setDraft(toTaxConfigurationForm(config)); setError(null); }}>{t('edit')}</button>
            )}
          </div>
        )}
      </CardSection>
    </div>
  );
}
