'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CardSection } from '@/components/CardSection';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  alertTextColor,
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
  certificateFileError,
  credentialBadgeStatus,
  credentialTitle,
  type ComplianceCredential,
  type ComplianceIntegration,
  type CredentialOptions,
} from './taxComplianceView';

type Editing =
  | { mode: 'upload'; id: number | null; label: string; integrationId: string; file: File | null; password: string }
  | { mode: 'reference'; id: number | null; label: string; integrationId: string; reference: string }
  | { mode: 'details'; id: number; label: string; integrationId: string; status: 'active' | 'inactive' }
  | null;

/** The file's bytes as base64, read in the browser; the file is sent once and never shown back. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * #2647 stage 3: Tax & Compliance → Certificates & Credentials. A certificate is uploaded
 * with its password and kept encrypted by the API; this screen only ever sees what the
 * certificate says about itself. A centrally managed credential is registered by reference.
 */
export function CredentialsSection({ canWrite, onChanged }: { canWrite: boolean; onChanged: () => void }) {
  const t = useTranslations('tax_compliance');
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const [rows, setRows] = useState<ComplianceCredential[] | null>(null);
  const [options, setOptions] = useState<CredentialOptions | null>(null);
  const [integrations, setIntegrations] = useState<ComplianceIntegration[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState<ComplianceCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [r, o, i] = await Promise.all([
          apiFetch('/system/tax-compliance/credentials') as Promise<ComplianceCredential[]>,
          apiFetch('/system/tax-compliance/credentials/options') as Promise<CredentialOptions>,
          apiFetch('/system/tax-compliance/integrations') as Promise<ComplianceIntegration[]>,
        ]);
        setRows(r);
        setOptions(o);
        setIntegrations(i);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [apiFetch]);

  const replace = (row: ComplianceCredential) =>
    setRows((prev) => {
      const list = prev ?? [];
      return list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
    });

  const integrationName = (id: number | null) => {
    if (id == null) return '—';
    const i = integrations.find((x) => x.id === id);
    return i ? `${t(`provider_${i.provider}`)} · ${t(`integration_type_${i.integration_type}`)}` : `#${id}`;
  };
  const date = (v: string | null) => (v ? formatGymDateOnly(v, fmt) : '—');
  const integrationId = (v: string) => (v ? Number(v) : null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    if (editing.mode === 'upload') {
      const fileError = certificateFileError(editing.file, options);
      if (fileError) {
        setError(t(fileError, { max: Math.round((options?.certificate_max_bytes ?? 65536) / 1024) }));
        return;
      }
      await run(async () => {
        const body = {
          file_name: editing.file!.name,
          certificate_base64: await fileToBase64(editing.file!),
          password: editing.password,
          ...(editing.id == null ? { label: editing.label, integration_id: integrationId(editing.integrationId) } : {}),
        };
        const isNew = editing.id == null;
        replace((await apiFetch(isNew ? '/system/tax-compliance/credentials/certificate' : `/system/tax-compliance/credentials/${editing.id}/certificate`, {
          method: isNew ? 'POST' : 'PUT',
          body: JSON.stringify(body),
        })) as ComplianceCredential);
        setEditing(null);
      });
      return;
    }
    if (editing.mode === 'reference') {
      if (!editing.reference.trim()) {
        setError(t('error_reference_required'));
        return;
      }
      await run(async () => {
        replace((await apiFetch('/system/tax-compliance/credentials/reference', {
          method: 'POST',
          body: JSON.stringify({ label: editing.label, integration_id: integrationId(editing.integrationId), external_reference: editing.reference }),
        })) as ComplianceCredential);
        setEditing(null);
      });
      return;
    }
    await run(async () => {
      replace((await apiFetch(`/system/tax-compliance/credentials/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ label: editing.label || null, integration_id: integrationId(editing.integrationId), status: editing.status }),
      })) as ComplianceCredential);
      setEditing(null);
    });
  }

  async function remove(row: ComplianceCredential) {
    await run(async () => {
      await apiFetch(`/system/tax-compliance/credentials/${row.id}`, { method: 'DELETE' });
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      setConfirmDelete(null);
    });
  }

  const field = (key: string, control: React.ReactNode) => (
    <div>
      <label style={formFieldLabelStyle}>{t(`field_${key}`)}</label>
      {control}
    </div>
  );

  const integrationSelect = (value: string, onChange: (v: string) => void) => (
    <select style={formControlStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {integrations.map((i) => <option key={i.id} value={String(i.id)}>{integrationName(i.id)}</option>)}
    </select>
  );

  function editor() {
    if (!editing) return null;
    const set = (patch: Record<string, unknown>) => setEditing({ ...editing, ...patch } as Editing);
    const replacing = editing.mode === 'upload' && editing.id != null;
    return (
      <div style={{ ...inlineEditorStyle, marginTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          {!replacing && field('credential_label', <input style={formControlStyle} value={editing.label} onChange={(e) => set({ label: e.target.value })} />)}
          {!replacing && field('credential_integration', integrationSelect(editing.integrationId, (v) => set({ integrationId: v })))}
          {editing.mode === 'upload' && (
            <>
              {field('certificate_file', (
                <input
                  type="file"
                  accept={(options?.certificate_extensions ?? ['.p12', '.pfx']).join(',')}
                  style={formControlStyle}
                  onChange={(e) => set({ file: e.target.files?.[0] ?? null })}
                />
              ))}
              {field('certificate_password', (
                <input type="password" autoComplete="new-password" style={formControlStyle} value={editing.password}
                  onChange={(e) => set({ password: e.target.value })} />
              ))}
            </>
          )}
          {editing.mode === 'reference' && (
            <div style={{ gridColumn: '1 / -1' }}>
              {field('external_reference', <input style={formControlStyle} value={editing.reference} onChange={(e) => set({ reference: e.target.value })} />)}
            </div>
          )}
          {editing.mode === 'details' && field('credential_status', (
            <select style={formControlStyle} value={editing.status} onChange={(e) => set({ status: e.target.value })}>
              {(options?.statuses ?? ['active', 'inactive']).map((s) => <option key={s} value={s}>{t(`credential_status_${s}`)}</option>)}
            </select>
          ))}
        </div>
        {editing.mode === 'upload' && <p style={cardHintStyle}>{t('certificate_upload_hint')}</p>}
        {error && <p style={formErrorStyle}>{error}</p>}
        <div style={inlineActionsRowStyle}>
          <button style={primaryBtnSmall()} disabled={busy} onClick={save}>{t(editing.mode === 'upload' ? 'action_upload' : 'save')}</button>
          <button style={secondaryBtnSmall} disabled={busy} onClick={() => { setEditing(null); setError(null); }}>{t('cancel')}</button>
        </div>
      </div>
    );
  }

  function detail(key: string, value: React.ReactNode, full = false) {
    return (
      <div style={full ? { gridColumn: '1 / -1' } : undefined}>
        <label style={formFieldLabelStyle}>{t(`field_${key}`)}</label>
        <div style={{ ...formValueStyle, wordBreak: 'break-word' }}>{value}</div>
      </div>
    );
  }

  const newUpload = (): Editing => ({ mode: 'upload', id: null, label: '', integrationId: '', file: null, password: '' });
  const newReference = (): Editing => ({ mode: 'reference', id: null, label: '', integrationId: '', reference: '' });
  const isNew = editing != null && editing.mode !== 'details' && editing.id == null;

  return (
    <div style={{ ...innerCardStyle, marginTop: 16 }}>
      <CardSection label={t('section_credentials')} first>
        <p style={cardHintStyle}>{t('credentials_hint')}</p>
        {rows === null ? (
          <p style={cardMutedTextStyle}>{error ?? '…'}</p>
        ) : (
          <>
            {rows.length === 0 && !isNew && <p style={cardMutedTextStyle}>{t('credentials_empty')}</p>}
            {rows.map((row) => (
              <div key={row.id} style={{ borderTop: '1px solid var(--gd-card-border, #ececf0)', padding: '12px 0' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                  <strong style={{ wordBreak: 'break-word' }}>{credentialTitle(row)}</strong>
                  <span style={cardMutedTextStyle}>{t(`credential_type_${row.credential_type}`)}</span>
                  <StatusBadge status={credentialBadgeStatus(row)} label={t(`credential_status_${row.effective_status}`)} />
                  {row.expires_soon && <span style={{ fontSize: 12.5, color: alertTextColor }}>{t('credential_expires_soon', { date: date(row.expires_at) })}</span>}
                  {canWrite && editing?.id !== row.id && (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <button style={secondaryBtnSmall} disabled={busy} onClick={() => {
                        setEditing({ mode: 'details', id: row.id, label: row.label ?? '', integrationId: row.integration_id == null ? '' : String(row.integration_id), status: row.status });
                        setError(null);
                      }}>{t('edit')}</button>
                      {row.credential_type === 'certificate' && (
                        <button style={secondaryBtnSmall} disabled={busy} onClick={() => {
                          setEditing({ mode: 'upload', id: row.id, label: '', integrationId: '', file: null, password: '' });
                          setError(null);
                        }}>{t('action_replace_certificate')}</button>
                      )}
                      <button style={{ ...secondaryBtnSmall, color: alertTextColor }} disabled={busy} onClick={() => setConfirmDelete(row)}>{t('action_delete')}</button>
                    </span>
                  )}
                </div>
                {editing?.id === row.id ? editor() : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 8 }}>
                    {detail('credential_integration', integrationName(row.integration_id))}
                    {row.credential_type === 'certificate' ? (
                      <>
                        {detail('valid_from', date(row.valid_from))}
                        {detail('expires_at', date(row.expires_at))}
                        {detail('certificate_file', row.file_name ?? '—')}
                        {detail('certificate_subject', row.certificate_subject ?? '—', true)}
                        {detail('certificate_issuer', row.certificate_issuer ?? '—', true)}
                        {detail('certificate_serial_number', row.certificate_serial_number ?? '—')}
                        {detail('certificate_fingerprint', <code style={{ fontSize: 12 }}>{row.certificate_fingerprint ?? '—'}</code>, true)}
                        {detail('certificate_password', t('password_stored'))}
                      </>
                    ) : detail('external_reference', row.external_reference ?? '—', true)}
                    {detail('credential_created', `${date(row.created_at)}${row.created_by ? ` · ${row.created_by}` : ''}`)}
                    {detail('credential_updated', row.modified_at ? `${date(row.modified_at)}${row.modified_by ? ` · ${row.modified_by}` : ''}` : '—')}
                  </div>
                )}
              </div>
            ))}
            {isNew && editor()}
            {error && !editing && <p style={formErrorStyle}>{error}</p>}
            {canWrite && !editing && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
                <button style={dashedAddBtnStyle} onClick={() => { setEditing(newUpload()); setError(null); }}>{t('add_certificate')}</button>
                <button style={dashedAddBtnStyle} onClick={() => { setEditing(newReference()); setError(null); }}>{t('add_reference')}</button>
              </div>
            )}
          </>
        )}
      </CardSection>
      <ConfirmDialog
        open={confirmDelete != null}
        title={t('delete_credential_title')}
        message={t('delete_credential_message', { name: confirmDelete ? credentialTitle(confirmDelete) : '' })}
        confirmLabel={t('action_delete')}
        cancelLabel={t('cancel')}
        busy={busy}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
