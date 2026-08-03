'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GymCharge {
  id: number;
  gym_id: string;
  charge_type_id: number;
  charge_type_code: string;
  charge_type_name: string;
  description: string | null;
  amount: string | null;
  currency: string;
  billing_frequency: string | null;
  availability: 'available' | 'unavailable';
  notes: string | null;
  created_at: string;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
}

type EditForm = {
  description: string;
  amount: string;
  currency: string;
  billing_frequency: string;
  availability: 'available' | 'unavailable';
  notes: string;
};

const BILLING_FREQUENCIES = ['once', 'week', 'month', 'year'] as const;
const AVAILABILITIES = ['available', 'unavailable'] as const;

function emptyEditForm(charge: GymCharge): EditForm {
  return {
    description: charge.description ?? '',
    amount: charge.amount != null ? parseFloat(charge.amount).toString() : '',
    currency: charge.currency ?? 'EUR',
    billing_frequency: charge.billing_frequency ?? '',
    availability: charge.availability,
    notes: charge.notes ?? '',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAmount(amount: string | null, currency: string) {
  if (amount == null) return '—';
  const sym = currency === 'EUR' ? '€' : currency;
  return `${parseFloat(amount).toFixed(2)}${sym}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GymChargesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [charges, setCharges] = useState<GymCharge[]>([]);
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [detailsCharge, setDetailsCharge] = useState<GymCharge | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await apiFetch<GymCharge[]>('/gym-charges');
      setCharges(data);
    } catch (err: any) {
      toast(err.message ?? t('gym_charges.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  // ─── Expand / collapse ──────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline edit ────────────────────────────────────────────────────────────

  function openEdit(charge: GymCharge) {
    setEditingId(charge.id);
    setEditForm(emptyEditForm(charge));
    setEditError(null);
    setExpanded((prev) => new Set(prev).add(charge.id));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function handleSave(charge: GymCharge) {
    if (!editForm) return;
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/gym-charges/${charge.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          description: editForm.description.trim() || null,
          amount: editForm.amount !== '' ? parseFloat(editForm.amount) : null,
          currency: editForm.currency || null,
          billing_frequency: editForm.billing_frequency || null,
          availability: editForm.availability,
          notes: editForm.notes.trim() || null,
        }),
      });
      setEditingId(null);
      setEditForm(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('gym_charges.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('gym_charges.title')}</h1>
      </div>

      {/* Column headers */}
      {!loading && charges.length > 0 && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('gym_charges.col_name')}</div>
          <div style={{ flex: 3 }}>{t('gym_charges.col_description')}</div>
          <div style={{ minWidth: 90 }}>{t('gym_charges.col_amount')}</div>
          <div style={{ minWidth: 90 }}>{t('gym_charges.col_frequency')}</div>
          <div style={{ minWidth: 100 }}>{t('gym_charges.col_availability')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>{t('gym_charges.loading')}</p>
      ) : charges.length === 0 ? (
        <p style={{ color: '#888' }}>{t('gym_charges.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {charges.map((charge) => {
            const isEditing = editingId === charge.id;
            const isExpanded = isEditing || expanded.has(charge.id);
            const descText = charge.description
              ? charge.description.length > 60 ? charge.description.slice(0, 60) + '…' : charge.description
              : '—';

            const menuItems: ContextMenuItem[] = [
              { label: t('gym_charges.details'), onClick: () => setDetailsCharge(charge) },
              { label: t('gym_charges.edit'), onClick: () => openEdit(charge) },
            ];

            const availStatus = charge.availability === 'available' ? 'active' : 'inactive';

            return (
              <div key={charge.id} style={cardStyle}>
                {/* Row header */}
                <div style={rowStyle} onClick={() => toggleExpand(charge.id)}>
                  <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {charge.charge_type_name}
                  </div>
                  <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {descText}
                  </div>
                  <div style={{ minWidth: 90, fontSize: 13, flexShrink: 0 }}>
                    {fmtAmount(charge.amount, charge.currency)}
                  </div>
                  <div style={{ minWidth: 90, fontSize: 13, flexShrink: 0 }}>
                    {charge.billing_frequency ? t(`gym_charges.frequency_${charge.billing_frequency}`) : '—'}
                  </div>
                  <div style={{ minWidth: 100, flexShrink: 0 }}>
                    <StatusBadge
                      status={availStatus}
                      label={t(`gym_charges.availability_${charge.availability}`)}
                    />
                  </div>
                  <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
                  <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                    <ContextMenu items={menuItems} ariaLabel={`Actions for ${charge.charge_type_name}`} />
                  </div>
                </div>

                {/* Expanded — edit mode */}
                {isExpanded && isEditing && editForm && (
                  <div style={{ padding: '16px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
                    <SectionHeader title={t('gym_charges.section_general')} />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={inlineLabelStyle}>{t('gym_charges.label_description')}</label>
                        <input
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                          style={inlineInputStyle}
                        />
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('gym_charges.label_availability')}</label>
                        <select
                          value={editForm.availability}
                          onChange={(e) => setEditForm({ ...editForm, availability: e.target.value as 'available' | 'unavailable' })}
                          style={inlineSelectStyle}
                        >
                          {AVAILABILITIES.map((a) => (
                            <option key={a} value={a}>{t(`gym_charges.availability_${a}`)}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <SectionHeader title={t('gym_charges.section_billing')} />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div>
                        <label style={inlineLabelStyle}>{t('gym_charges.label_amount')}</label>
                        <input
                          type="number" min="0" step="0.01"
                          value={editForm.amount}
                          onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                          style={inlineInputStyle}
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('gym_charges.label_currency')}</label>
                        <input
                          value={editForm.currency}
                          disabled
                          style={{ ...inlineInputStyle, background: '#f5f5f5', color: '#888', cursor: 'not-allowed' }}
                        />
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('gym_charges.label_frequency')}</label>
                        <select
                          value={editForm.billing_frequency}
                          onChange={(e) => setEditForm({ ...editForm, billing_frequency: e.target.value })}
                          style={inlineSelectStyle}
                        >
                          <option value="">—</option>
                          {BILLING_FREQUENCIES.map((f) => (
                            <option key={f} value={f}>{t(`gym_charges.frequency_${f}`)}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <SectionHeader title={t('gym_charges.section_notes')} />
                    <textarea
                      value={editForm.notes}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                      rows={3}
                      style={{ ...inlineInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                    />

                    {editError && <p style={{ color: '#c0392b', fontSize: 13, margin: '8px 0 0' }}>{editError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                      <button onClick={cancelEdit} style={btnSmall('#888')}>{t('gym_charges.cancel')}</button>
                      <button onClick={() => handleSave(charge)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                        {editSaving ? t('gym_charges.saving') : t('gym_charges.save')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Expanded — view mode */}
                {isExpanded && !isEditing && (
                  <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
                    <SectionHeader title={t('gym_charges.section_general')} />
                    <DetailRow label={t('gym_charges.label_description')} value={charge.description ?? '—'} />
                    <DetailRow label={t('gym_charges.label_availability')} value={t(`gym_charges.availability_${charge.availability}`)} />

                    <SectionHeader title={t('gym_charges.section_billing')} />
                    <DetailRow label={t('gym_charges.label_amount')} value={fmtAmount(charge.amount, charge.currency)} />
                    <DetailRow label={t('gym_charges.label_currency')} value={charge.currency} />
                    <DetailRow label={t('gym_charges.label_frequency')} value={charge.billing_frequency ? t(`gym_charges.frequency_${charge.billing_frequency}`) : '—'} />

                    <SectionHeader title={t('gym_charges.section_notes')} />
                    <DetailRow label="" value={charge.notes ?? '—'} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={detailsCharge !== null}
        title={t('gym_charges.details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('gym_charges.close')}
        saveLabel=""
        onCancel={() => setDetailsCharge(null)}
        onSave={() => setDetailsCharge(null)}
      >
        {detailsCharge && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <ModalSectionHeader title={t('gym_charges.section_general')} />
            <ModalField label={t('gym_charges.label_charge_type')} value={detailsCharge.charge_type_name} />
            <ModalField label={t('gym_charges.label_charge_type_code')} value={detailsCharge.charge_type_code.toUpperCase()} />
            <ModalField label={t('gym_charges.label_description')} value={detailsCharge.description ?? '—'} />
            <ModalField label={t('gym_charges.label_availability')} value={t(`gym_charges.availability_${detailsCharge.availability}`)} />

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <ModalSectionHeader title={t('gym_charges.section_billing')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('gym_charges.label_amount')} value={fmtAmount(detailsCharge.amount, detailsCharge.currency)} />
              <ModalField label={t('gym_charges.label_currency')} value={detailsCharge.currency} />
              <ModalField label={t('gym_charges.label_frequency')} value={detailsCharge.billing_frequency ? t(`gym_charges.frequency_${detailsCharge.billing_frequency}`) : '—'} />
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <ModalSectionHeader title={t('gym_charges.section_audit')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('gym_charges.audit_created_at')} value={fmtDate(detailsCharge.created_at)} />
              <ModalField label={t('gym_charges.audit_created_by')} value={detailsCharge.created_by_name ?? '—'} />
              <ModalField label={t('gym_charges.audit_modified_at')} value={fmtDate(detailsCharge.modified_at)} />
              <ModalField label={t('gym_charges.audit_modified_by')} value={detailsCharge.modified_by_name ?? '—'} />
              <ModalField label={t('gym_charges.audit_deleted_at')} value="—" />
              <ModalField label={t('gym_charges.audit_deleted_by')} value="—" />
            </div>
          </div>
        )}
      </CrudModal>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid #eee', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      {label && <span style={{ width: 180, flexShrink: 0, color: '#666' }}>{label}</span>}
      <span style={{ color: '#111', flex: 1, whiteSpace: 'pre-wrap' }}>{value}</span>
    </div>
  );
}

function ModalSectionHeader({ title }: { title: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
      {title}
    </div>
  );
}

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--gd-card-border, #e2e2e6)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'var(--gd-card-bg, #ffffff)',
};

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

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
