'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { Tabs } from '@/components/Tabs';
import { CardSection } from '@/components/CardSection';
import {
  formFieldLabelStyle,
  innerCardStyle,
  cardMutedTextStyle,
} from '@/components/formChrome';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import {
  KNOWN_COMPLIANCE_EVENT_TYPES,
  TAX_COMPLIANCE_TABS,
  type TaxComplianceTab,
  type TaxProfile,
  type TaxProfileOptions,
  type TaxConfigurationOptions,
} from './taxComplianceView';
import { TaxConfigurationSection } from './TaxConfigurationSection';
import { ElectronicInvoicingSection } from './ElectronicInvoicingSection';
import { CredentialsSection } from './CredentialsSection';
import { TaxProfileSection } from './TaxProfileSection';

interface ComplianceEvent {
  id: number;
  provider: string | null;
  event_type: string;
  description: string;
  status: string;
  created_at: string;
  created_by: string | null;
}

/**
 * #2647: Settings → Tax & Compliance — Tax Profile, Tax Configuration, Electronic
 * Invoicing (stage 2), Certificates & Credentials (stage 3) and Compliance History.
 */
export default function TaxCompliancePage() {
  const t = useTranslations('tax_compliance');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin } = useGym();
  const fmt = useGymFormatSettings();
  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'SYSTEM'));

  const [tab, setTab] = useState<TaxComplianceTab>('profile');
  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [options, setOptions] = useState<TaxProfileOptions | null>(null);
  const [configOptions, setConfigOptions] = useState<TaxConfigurationOptions | null>(null);
  const [history, setHistory] = useState<ComplianceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const countryName = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { names = null; }
    return (code: string) => names?.of(code) ?? code;
  }, [locale]);

  useEffect(() => {
    (async () => {
      try {
        const [p, o, co] = await Promise.all([
          apiFetch('/system/tax-compliance/profile') as Promise<TaxProfile>,
          apiFetch('/system/tax-compliance/profile/options') as Promise<TaxProfileOptions>,
          apiFetch('/system/tax-compliance/configuration/options') as Promise<TaxConfigurationOptions>,
        ]);
        setProfile(p);
        setOptions(o);
        setConfigOptions(co);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch, activeGym?.id]);

  useEffect(() => {
    if (tab !== 'history') return;
    (async () => {
      try {
        setHistory((await apiFetch('/system/tax-compliance/history')) as ComplianceEvent[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch, activeGym?.id, tab]);

  const eventLabel = (type: string) =>
    (KNOWN_COMPLIANCE_EVENT_TYPES as readonly string[]).includes(type) ? t(`event_${type}`) : type;

  return (
    <div style={{ padding: 24, maxWidth: 860 }}>
      <h1 style={{ marginTop: 0 }}>{t('title')}</h1>
      <p style={{ ...cardMutedTextStyle, marginBottom: 16 }}>{t('intro')}</p>
      <Tabs tabs={TAX_COMPLIANCE_TABS} active={tab} onChange={setTab} label={(k) => t(k)} ariaLabel={t('title')} />

      {tab === 'profile' && (
        <div style={{ ...innerCardStyle, marginTop: 16 }}>
          <CardSection label={t('section_profile')} first>
            <TaxProfileSection
              key={activeGym?.id}
              canWrite={canWrite}
              onChanged={(p) => { setProfile(p); setHistory(null); }}
            />
          </CardSection>
        </div>
      )}

      {tab === 'configuration' && (
        <TaxConfigurationSection
          key={activeGym?.id}
          country={profile?.country_code ?? null}
          options={configOptions}
          canWrite={canWrite}
          onChanged={() => setHistory(null)}
        />
      )}

      {tab === 'e_invoicing' && (
        <ElectronicInvoicingSection
          key={activeGym?.id}
          country={profile?.country_code ?? null}
          countries={[...(options?.countries ?? [])].sort((a, b) => countryName(a).localeCompare(countryName(b), locale))}
          countryName={countryName}
          options={configOptions}
          canWrite={canWrite}
          onChanged={() => setHistory(null)}
        />
      )}

      {tab === 'credentials' && (
        <CredentialsSection key={activeGym?.id} canWrite={canWrite} onChanged={() => setHistory(null)} />
      )}

      {tab === 'history' && (
        <div style={{ ...innerCardStyle, marginTop: 16 }}>
          <CardSection label={t('section_history')} first>
            {history === null ? (
              <p style={cardMutedTextStyle}>{error ?? '…'}</p>
            ) : history.length === 0 ? (
              <p style={cardMutedTextStyle}>{t('history_empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
                  <thead>
                    <tr>
                      {['col_timestamp', 'col_event', 'col_description', 'col_provider', 'col_user', 'col_status'].map((k) => (
                        <th key={k} style={{ ...formFieldLabelStyle, textAlign: 'left', padding: '6px 8px' }}>{t(k)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((ev) => (
                      <tr key={ev.id} style={{ borderTop: '1px solid var(--gd-card-border, #ececf0)' }}>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatGymDateTime(ev.created_at, fmt)}</td>
                        <td style={{ padding: '6px 8px' }}>{eventLabel(ev.event_type)}</td>
                        <td style={{ padding: '6px 8px' }}>{ev.description}</td>
                        <td style={{ padding: '6px 8px' }}>{ev.provider ?? '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{ev.created_by ?? '—'}</td>
                        <td style={{ padding: '6px 8px' }}>{t(`status_${ev.status}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardSection>
        </div>
      )}
    </div>
  );
}
