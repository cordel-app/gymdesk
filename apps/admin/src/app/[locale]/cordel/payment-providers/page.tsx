'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall, cardSurfaceStyle } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

const STATUSES = ['active', 'inactive'] as const;
type ProviderStatus = typeof STATUSES[number];

interface PaymentProvider {
  id: number;
  name: string;
  provider_key: string;
  description: string | null;
  is_default: boolean;
  status: ProviderStatus;
  gym_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface Deployment {
  provider_key: string;
  environment: string | null;
  credentials_configured: boolean;
  missing_config: string[];
  webhook_url: string | null;
  supported_provider_keys: string[];
}

interface GymReference { id: string; name: string }

type EditForm = {
  name: string;
  provider_key: string;
  description: string;
  status: ProviderStatus;
  is_default: boolean;
};

type InlineNew = {
  name: string;
  provider_key: string;
  description: string;
  is_default: boolean;
  saving: boolean;
  error: string | null;
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CordelPaymentProvidersPage() {
  const t = useTranslations('payment_providers');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** §"Editing a provider may affect several gyms → system will launch a warning". */
  const [editImpact, setEditImpact] = useState<{ id: number; usageCount: number; references: GymReference[] } | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [details, setDetails] = useState<PaymentProvider | null>(null);
  const [deleting, setDeleting] = useState<PaymentProvider | null>(null);

  const providerKeys = deployment?.supported_provider_keys ?? ['monei'];

  useEffect(() => {
    if (gymLoading) return;
    if (!isSuperadmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (!gymLoading && isSuperadmin) load();
  }, [gymLoading, isSuperadmin, statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const [list, status] = await Promise.all([
        apiFetch<PaymentProvider[]>(`/platform/payment-providers${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiFetch<Deployment>('/platform/payment-providers/deployment'),
      ]);
      setProviders(list);
      setDeployment(status);
    } catch (err: any) {
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Accordion ──────────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({
      name: '',
      provider_key: providerKeys[0] ?? 'monei',
      description: '',
      is_default: providers.length === 0,
      saving: false,
      error: null,
    });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) { setInlineNew({ ...inlineNew, error: t('error_name_required') }); return; }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch('/platform/payment-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          provider_key: inlineNew.provider_key,
          description: inlineNew.description.trim() || null,
          is_default: inlineNew.is_default,
        }),
      });
      setInlineNew(null);
      await load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  async function openEdit(provider: PaymentProvider) {
    setEditingId(provider.id);
    setEditForm({
      name: provider.name,
      provider_key: provider.provider_key,
      description: provider.description ?? '',
      status: provider.status,
      is_default: provider.is_default,
    });
    setEditError(null);
    setEditImpact(null);
    setExpanded((prev) => new Set([...prev, provider.id]));

    // The warning is only meaningful when gyms actually point at this row, so
    // the names are fetched when the form opens rather than on every list read.
    if (provider.gym_count > 0) {
      try {
        const impact = await apiFetch<{ usageCount: number; references: GymReference[] }>(
          `/platform/payment-providers/${provider.id}/references`,
        );
        setEditImpact({ id: provider.id, usageCount: impact.usageCount, references: impact.references });
      } catch {
        // A failed warning must not block the edit — the count from the list row
        // is enough to tell the admin that other gyms are affected.
        setEditImpact({ id: provider.id, usageCount: provider.gym_count, references: [] });
      }
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
    setEditImpact(null);
  }

  async function handleSave(provider: PaymentProvider) {
    if (!editForm) return;
    if (!editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/platform/payment-providers/${provider.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          provider_key: editForm.provider_key,
          description: editForm.description.trim() || null,
          status: editForm.status,
          // Only ever sent when turning this row into the default: the API
          // refuses to clear the flag (another provider has to take it over).
          ...(editForm.is_default && !provider.is_default ? { is_default: true } : {}),
        }),
      });
      cancelEdit();
      await load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/payment-providers/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) cancelEdit();
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      await load();
    } catch (err: any) {
      // 409 with the linked gyms — §1's "system will launch an error in case
      // there are gyms linked to such payment provider".
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  function renderDeployment() {
    if (!deployment) return null;
    return (
      <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ padding: '14px 20px' }}>
          <SectionHeader title={t('section_deployment')} />
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#666' }}>{t('deployment_note')}</p>
          <DetailRow label={t('label_provider_key')} value={deployment.provider_key} />
          <DetailRow label={t('label_environment')} value={deployment.environment ?? '—'} />
          <DetailRow
            label={t('label_credentials')}
            value={deployment.credentials_configured ? t('credentials_configured') : t('credentials_incomplete')}
          />
          {deployment.missing_config.length > 0 && (
            <DetailRow label={t('label_missing_config')} value={deployment.missing_config.join(', ')} />
          )}
          <DetailRow label={t('label_webhook_url')} value={deployment.webhook_url ?? '—'} />
        </div>
      </div>
    );
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('placeholder_name')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_provider_key')} *</label>
              <select
                value={inlineNew.provider_key}
                onChange={(e) => setInlineNew({ ...inlineNew, provider_key: e.target.value })}
                style={inlineSelectStyle}
              >
                {providerKeys.map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                style={inlineInputStyle}
              />
            </div>
            <label style={{ ...inlineLabelStyle, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={inlineNew.is_default}
                onChange={(e) => setInlineNew({ ...inlineNew, is_default: e.target.checked })}
              />
              {t('label_is_default')}
            </label>
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setInlineNew(null)} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall('#6c63ff')}>
              {inlineNew.saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(provider: PaymentProvider) {
    const isExpanded = expanded.has(provider.id);
    const isEditing = editingId === provider.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(provider) },
      { label: t('edit'), onClick: () => openEdit(provider) },
      { label: t('delete'), onClick: () => setDeleting(provider), danger: true },
    ];

    return (
      <div key={provider.id} style={cardStyle}>
        {/* Collapsed header */}
        <div style={rowStyle} onClick={() => toggleExpand(provider.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.name}</span>
            {provider.is_default && <span style={defaultBadgeStyle}>{t('badge_default')}</span>}
          </div>
          <div style={{ flex: 1, fontSize: 13, color: '#666' }}>{provider.provider_key}</div>
          <div style={{ minWidth: 80, fontSize: 13, color: '#888', flexShrink: 0 }}>{provider.gym_count}</div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={provider.status} label={tStatus(provider.status)} />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${provider.name}`} />
          </div>
        </div>

        {/* Inline edit */}
        {isEditing && editForm && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            {editImpact?.id === provider.id && editImpact.usageCount > 0 && (
              <div style={warningStyle}>
                <strong>{t('warning_shared_title')}</strong>
                <p style={{ margin: '4px 0 0' }}>{t('warning_shared_body', { count: editImpact.usageCount })}</p>
                {editImpact.references.length > 0 && (
                  <p style={{ margin: '4px 0 0' }}>
                    {editImpact.references.map((g) => g.name).join(', ')}
                    {editImpact.usageCount > editImpact.references.length
                      ? ` ${t('warning_shared_more', { count: editImpact.usageCount - editImpact.references.length })}`
                      : ''}
                  </p>
                )}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  autoFocus
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_provider_key')} *</label>
                <select
                  value={editForm.provider_key}
                  onChange={(e) => setEditForm({ ...editForm, provider_key: e.target.value })}
                  style={inlineSelectStyle}
                >
                  {providerKeys.map((key) => <option key={key} value={key}>{key}</option>)}
                </select>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as ProviderStatus })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <label style={{ ...inlineLabelStyle, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_default}
                    disabled={provider.is_default}
                    title={provider.is_default ? t('hint_default_locked') : undefined}
                    onChange={(e) => setEditForm({ ...editForm, is_default: e.target.checked })}
                  />
                  {t('label_is_default')}
                </label>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={2}
                  style={{ ...inlineInputStyle, resize: 'vertical' }}
                />
              </div>
            </div>

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(provider)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <DetailRow label={t('label_provider_key')} value={provider.provider_key} />
            <DetailRow label={t('label_description')} value={provider.description ?? '—'} />
            <DetailRow label={t('label_status')} value={tStatus(provider.status)} />
            <DetailRow label={t('label_is_default')} value={provider.is_default ? t('yes') : t('no')} />

            <SectionHeader title={t('section_usage')} />
            <DetailRow label={t('label_gym_count')} value={String(provider.gym_count)} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#666' }}>{t('usage_note')}</p>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !isSuperadmin) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>
            {t('add')}
          </button>
        </div>
      </div>

      {renderDeployment()}

      {(providers.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 1 }}>{t('col_provider_key')}</div>
          <div style={{ minWidth: 80 }}>{t('col_gyms')}</div>
          <div style={{ minWidth: 90 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {renderInlineNewRow()}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : providers.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {providers.map(renderRow)}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        extraFooter={<ViewAuditLogButton entityType="payment_provider" entityId={details?.id} scope="platform" onNavigate={() => setDetails(null)} />}
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div>
              <span style={detailLabelStyle}>{t('label_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.name}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('label_provider_key')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}><code>{details.provider_key}</code></p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('label_is_default')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.is_default ? t('yes') : t('no')}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('label_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge status={details.status} label={tStatus(details.status)} />
                </div>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('label_gym_count')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.gym_count}</p>
              </div>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('label_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.description ? '#333' : '#aaa' }}>
                {details.description ?? '—'}
              </p>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>Audit</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{fmtDate(details.created_at)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{fmtDate(details.modified_at)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by_name ?? '—'}</p>
              </div>
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={deleting && deleting.gym_count > 0
          ? `${t('confirm_delete_title')}\n\n${t('warning_shared_body', { count: deleting.gym_count })}`
          : `${t('confirm_delete_title')}\n\n${t('confirm_delete_body')}`}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-card-border, #eee)', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 200, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1, wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = { ...inlineInputStyle };

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const errorStyle: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#c0392b' };

const warningStyle: React.CSSProperties = {
  margin: '0 0 12px', padding: '10px 12px', border: '1px solid #f0c36d', borderRadius: 8,
  background: '#fdf6e3', fontSize: 13, color: '#8a6d3b',
};

const defaultBadgeStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#2d6a4f', background: '#d8f3dc', borderRadius: 4,
  padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0,
};
