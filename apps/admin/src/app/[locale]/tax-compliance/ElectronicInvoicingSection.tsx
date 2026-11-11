'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CardSection } from '@/components/CardSection';
import { StatusBadge } from '@/components/StatusBadge';
import {
  cardHintStyle,
  cardMutedTextStyle,
  dashedAddBtnStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  formValueStyle,
  inlineActionsRowStyle,
  inlineEditorStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { formatGymDateOnly } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import {
  metadataText,
  newIntegrationForm,
  toIntegrationForm,
  toIntegrationPayload,
  withIntegrationIdentity,
  type ComplianceIntegration,
  type IntegrationForm,
  type TaxConfigurationOptions,
} from './taxComplianceView';

type Editing = { id: number | 'new'; form: IntegrationForm } | null;

/**
 * #2647 stage 2: Tax & Compliance → Electronic Invoicing. The integrations a gym has
 * configured; nothing here talks to a tax authority. An integration is created and
 * edited inline, enabled or disabled from its row, and never deleted.
 */
export function ElectronicInvoicingSection({
  country,
  countries,
  countryName,
  options,
  canWrite,
  onChanged,
}: {
  country: string | null;
  countries: string[];
  countryName: (code: string) => string;
  options: TaxConfigurationOptions | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('tax_compliance');
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const [rows, setRows] = useState<ComplianceIntegration[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setRows((await apiFetch('/system/tax-compliance/integrations')) as ComplianceIntegration[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch]);

  const replace = (row: ComplianceIntegration) =>
    setRows((prev) => {
      const list = prev ?? [];
      return list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
    });

  async function save() {
    if (!editing) return;
    const isNew = editing.id === 'new';
    const body = toIntegrationPayload(editing.form, isNew);
    if (!body) {
      setError(t('error_metadata'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const row = (await apiFetch(isNew ? '/system/tax-compliance/integrations' : `/system/tax-compliance/integrations/${editing.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      })) as ComplianceIntegration;
      replace(row);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: ComplianceIntegration) {
    setBusy(true);
    setError(null);
    try {
      replace((await apiFetch(`/system/tax-compliance/integrations/${row.id}/${row.enabled ? 'disable' : 'enable'}`, { method: 'POST' })) as ComplianceIntegration);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const date = (v: string | null) => (v ? formatGymDateOnly(v, fmt) : '—');

  function editor() {
    if (!editing) return null;
    const f = editing.form;
    const isNew = editing.id === 'new';
    const set = (patch: Partial<IntegrationForm>) => setEditing({ ...editing, form: { ...f, ...patch } });
    const field = (key: string, control: React.ReactNode) => (
      <div>
        <label style={formFieldLabelStyle}>{t(`field_${key}`)}</label>
        {control}
      </div>
    );
    return (
      <div style={{ ...inlineEditorStyle, marginTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          {field('integration_country', isNew ? (
            <select style={formControlStyle} value={f.country_code}
              onChange={(e) => setEditing({ ...editing, form: withIntegrationIdentity(f, { country_code: e.target.value }, options) })}>
              <option value="">—</option>
              {countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
          ) : <div style={formValueStyle}>{countryName(f.country_code)}</div>)}
          {field('provider', isNew ? (
            <select style={formControlStyle} value={f.provider} disabled={!f.country_code}
              onChange={(e) => setEditing({ ...editing, form: withIntegrationIdentity(f, { provider: e.target.value }, options) })}>
              <option value="">—</option>
              {(options?.providers[f.country_code] ?? []).map((p) => <option key={p} value={p}>{t(`provider_${p}`)}</option>)}
            </select>
          ) : <div style={formValueStyle}>{t(`provider_${f.provider}`)}</div>)}
          {field('integration_type', isNew ? (
            <select style={formControlStyle} value={f.integration_type} disabled={!f.provider}
              onChange={(e) => set({ integration_type: e.target.value })}>
              <option value="">—</option>
              {(options?.integration_types[f.provider] ?? []).map((ty) => <option key={ty} value={ty}>{t(`integration_type_${ty}`)}</option>)}
            </select>
          ) : <div style={formValueStyle}>{t(`integration_type_${f.integration_type}`)}</div>)}
          {field('authorization_status', (
            <select style={formControlStyle} value={f.authorization_status} onChange={(e) => set({ authorization_status: e.target.value })}>
              {(options?.authorization_statuses ?? []).map((s) => <option key={s} value={s}>{t(`authorization_status_${s}`)}</option>)}
            </select>
          ))}
          {field('authorization_date', <input type="date" style={formControlStyle} value={f.authorization_date} onChange={(e) => set({ authorization_date: e.target.value })} />)}
          {field('authorization_reference', <input style={formControlStyle} value={f.authorization_reference} onChange={(e) => set({ authorization_reference: e.target.value })} />)}
          {field('activation_date', <input type="date" style={formControlStyle} value={f.activation_date} onChange={(e) => set({ activation_date: e.target.value })} />)}
          <div style={{ gridColumn: '1 / -1' }}>
            {field('configuration_metadata', (
              <textarea style={{ ...formControlStyle, minHeight: 90, fontFamily: 'monospace' }} value={f.metadata}
                placeholder='{ "key": "value" }' onChange={(e) => set({ metadata: e.target.value })} />
            ))}
          </div>
        </div>
        {error && <p style={formErrorStyle}>{error}</p>}
        <div style={inlineActionsRowStyle}>
          <button style={primaryBtnSmall()} disabled={busy || !f.provider || !f.integration_type} onClick={save}>{t('save')}</button>
          <button style={secondaryBtnSmall} disabled={busy} onClick={() => { setEditing(null); setError(null); }}>{t('cancel')}</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...innerCardStyle, marginTop: 16 }}>
      <CardSection label={t('section_e_invoicing')} first>
        <p style={cardHintStyle}>{t('e_invoicing_hint')}</p>
        {rows === null ? (
          <p style={cardMutedTextStyle}>{error ?? '…'}</p>
        ) : (
          <>
            {rows.length === 0 && editing?.id !== 'new' && <p style={cardMutedTextStyle}>{t('e_invoicing_empty')}</p>}
            {rows.map((row) => (
              <div key={row.id} style={{ borderTop: '1px solid var(--gd-card-border, #ececf0)', padding: '12px 0' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                  <strong>{t(`provider_${row.provider}`)}</strong>
                  <span style={cardMutedTextStyle}>{t(`integration_type_${row.integration_type}`)} · {countryName(row.country_code)}</span>
                  <StatusBadge status={row.enabled ? 'active' : 'inactive'} label={t(row.enabled ? 'integration_enabled' : 'integration_disabled')} />
                  {canWrite && editing?.id !== row.id && (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <button style={secondaryBtnSmall} disabled={busy} onClick={() => { setEditing({ id: row.id, form: toIntegrationForm(row) }); setError(null); }}>{t('edit')}</button>
                      <button style={row.enabled ? secondaryBtnSmall : primaryBtnSmall()} disabled={busy} onClick={() => toggle(row)}>
                        {t(row.enabled ? 'action_disable' : 'action_enable')}
                      </button>
                    </span>
                  )}
                </div>
                {editing?.id === row.id ? editor() : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 8 }}>
                    <div><label style={formFieldLabelStyle}>{t('field_authorization_status')}</label><div style={formValueStyle}>{t(`authorization_status_${row.authorization_status}`)}</div></div>
                    <div><label style={formFieldLabelStyle}>{t('field_authorization_date')}</label><div style={formValueStyle}>{date(row.authorization_date)}</div></div>
                    <div><label style={formFieldLabelStyle}>{t('field_authorization_reference')}</label><div style={formValueStyle}>{row.authorization_reference ?? '—'}</div></div>
                    <div><label style={formFieldLabelStyle}>{t('field_activation_date')}</label><div style={formValueStyle}>{date(row.activation_date)}</div></div>
                    {row.configuration_metadata && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={formFieldLabelStyle}>{t('field_configuration_metadata')}</label>
                        <pre style={{ ...formValueStyle, whiteSpace: 'pre-wrap', margin: 0 }}>{metadataText(row.configuration_metadata)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {editing?.id === 'new' && editor()}
            {error && !editing && <p style={formErrorStyle}>{error}</p>}
            {canWrite && !editing && (
              <button style={{ ...dashedAddBtnStyle, marginTop: 12 }} onClick={() => { setEditing({ id: 'new', form: newIntegrationForm(country) }); setError(null); }}>
                {t('add_integration')}
              </button>
            )}
          </>
        )}
      </CardSection>
    </div>
  );
}
