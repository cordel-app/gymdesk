'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { FormLabel, FormInput } from '@/components/CrudModal';
import { btnSmall, btnStyle } from '@/components/ui';
import { PromotionDetailModal } from './PromotionDetailModal';

interface Promo {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  stackable: number;
  status: 'active' | 'inactive';
  created_at: string;
  created_by_name: string | null;
  primary_action_type: string | null;
  primary_value: string | null;
}

interface GymCharge { id: number; charge_type_name: string; charge_type_code: string; amount: string | null; }
interface ActionType { id: number; code: string }
interface MembershipPlan { id: number; name: string }

interface ChargeBenefit {
  id: number;
  gym_charge_id: number;
  gym_charge_name: string;
  gym_charge_code: string;
  action: string;
  value: string | null;
}

interface PeriodBenefit {
  id: number;
  membership_plan_id: number;
  membership_plan_name: string;
  action_type_id: number;
  action_code: string;
  value: string | null;
  duration_months: number;
}

const STATUSES = ['active', 'inactive'] as const;
const CHARGE_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount'] as const;
const iso = (v: string) => (v ? v.slice(0, 10) : '');

const emptyPromoForm = {
  name: '',
  description: '',
  starts_at: '',
  ends_at: '',
  stackable: false,
  status: 'active' as 'active' | 'inactive',
};

const emptyPbForm = { membership_plan_id: '', action_type_id: '', value: '', duration_months: '' };

export default function PromotionsPage() {
  const t = useTranslations('promotions');
  const tStatus = useTranslations('status');
  const tAction = useTranslations('action_type');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [gymCharges, setGymCharges] = useState<GymCharge[]>([]);
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyPromoForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [cbDraft, setCbDraft] = useState<Record<number, { action: string; value: string }>>({});
  const [periodBenefits, setPeriodBenefits] = useState<PeriodBenefit[]>([]);
  const [benefitsLoading, setBenefitsLoading] = useState(false);

  const [pbForm, setPbForm] = useState(emptyPbForm);
  const [cbSaving, setCbSaving] = useState(false);
  const [pbSaving, setPbSaving] = useState(false);

  const [detailFor, setDetailFor] = useState<Promo | null>(null);
  const [deleting, setDeleting] = useState<Promo | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) loadLookups();
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) load();
  }, [activeGymId, gymLoading, statusFilter, search]);

  async function loadLookups() {
    try {
      const [gc, at, pl] = await Promise.all([
        apiFetch<GymCharge[]>('/gym-charges'),
        apiFetch<ActionType[]>('/action-types'),
        apiFetch<MembershipPlan[]>('/membership-plans?status=active'),
      ]);
      setGymCharges(gc);
      setActionTypes(at);
      setPlans(pl);
    } catch { /* non-critical */ }
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      setRows(await apiFetch<Promo[]>(`/promotions${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadBenefits(promotionId: number) {
    setBenefitsLoading(true);
    try {
      const [cbs, pbs] = await Promise.all([
        apiFetch<ChargeBenefit[]>(`/promotions/${promotionId}/charge-benefits`),
        apiFetch<PeriodBenefit[]>(`/promotions/${promotionId}/period-benefits`),
      ]);
      const draft: Record<number, { action: string; value: string }> = {};
      for (const cb of cbs) {
        draft[cb.gym_charge_id] = { action: cb.action, value: cb.value ?? '' };
      }
      setCbDraft(draft);
      setPeriodBenefits(pbs);
    } catch { /* show empty */ }
    finally { setBenefitsLoading(false); }
  }

  function openEdit(promo: Promo) {
    if (expandedId === promo.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(promo.id);
    setEditForm({
      name: promo.name,
      description: promo.description ?? '',
      starts_at: iso(promo.starts_at),
      ends_at: iso(promo.ends_at),
      stackable: !!promo.stackable,
      status: promo.status,
    });
    setEditError(null);
    setCbDraft({});
    setPbForm(emptyPbForm);
    loadBenefits(promo.id);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }

  async function handleNew() {
    if (!activeGymId) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const row = await apiFetch<Promo>('/promotions', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Promotion', starts_at: today, ends_at: today, status: 'active' }),
      });
      await load();
      setExpandedId(row.id);
      setEditForm({
        name: row.name,
        description: '',
        starts_at: iso(row.starts_at),
        ends_at: iso(row.ends_at),
        stackable: false,
        status: row.status,
      });
      setEditError(null);
      setCbDraft({});
      setPbForm(emptyPbForm);
      setPeriodBenefits([]);
      setTimeout(() => nameInputRef.current?.focus(), 80);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleSave(promoId: number) {
    if (!editForm.name.trim() || !editForm.starts_at || !editForm.ends_at) {
      setEditError(t('error_required'));
      return;
    }
    if (new Date(editForm.starts_at) > new Date(editForm.ends_at)) {
      setEditError(t('error_dates'));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/promotions/${promoId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          starts_at: editForm.starts_at,
          ends_at: editForm.ends_at,
          stackable: editForm.stackable,
          status: editForm.status,
        }),
      });
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDuplicate(promo: Promo) {
    try {
      await apiFetch(`/promotions/${promo.id}/duplicate`, { method: 'POST' });
      load();
      toast(t('saved'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/promotions/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) setExpandedId(null);
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  /* ---- charge benefits ---- */

  async function saveChargeBenefits(promotionId: number) {
    setCbSaving(true);
    try {
      const items = Object.entries(cbDraft)
        .filter(([, v]) => v.action && v.action !== 'no_benefit')
        .map(([gcId, v]) => ({
          gym_charge_id: parseInt(gcId, 10),
          action: v.action,
          value: v.action === 'waive' ? null : v.value === '' ? null : parseFloat(v.value),
        }));
      await apiFetch(`/promotions/${promotionId}/charge-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items }),
      });
      toast(t('saved'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setCbSaving(false);
    }
  }

  /* ---- period benefits ---- */

  async function addPeriodBenefit(promotionId: number) {
    if (!pbForm.membership_plan_id || !pbForm.action_type_id || !pbForm.duration_months) return;
    const action = actionTypes.find((a) => a.id === parseInt(pbForm.action_type_id, 10));
    setPbSaving(true);
    try {
      await apiFetch(`/promotions/${promotionId}/period-benefits`, {
        method: 'POST',
        body: JSON.stringify({
          membership_plan_id: parseInt(pbForm.membership_plan_id, 10),
          action_type_id: parseInt(pbForm.action_type_id, 10),
          value: action?.code === 'waive' ? null : pbForm.value === '' ? null : parseFloat(pbForm.value),
          duration_months: parseInt(pbForm.duration_months, 10),
        }),
      });
      setPbForm(emptyPbForm);
      loadBenefits(promotionId);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setPbSaving(false);
    }
  }

  async function deletePeriodBenefit(promotionId: number, pbId: number) {
    try {
      await apiFetch(`/promotions/${promotionId}/period-benefits/${pbId}`, { method: 'DELETE' });
      loadBenefits(promotionId);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  /* ---- search debounce ---- */

  function handleSearchChange(val: string) {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 300);
  }

  if (gymLoading || !isAdmin) return null;

  /* ---- render helpers ---- */

  function fmtPeriod(starts: string, ends: string) {
    return `${iso(starts)} – ${iso(ends)}`;
  }

  function fmtValue(actionType: string | null, value: string | null) {
    if (!actionType) return '—';
    if (actionType === 'waive') return tAction('waive' as any);
    if (value == null) return '—';
    if (actionType === 'percentage_discount') return `${value}%`;
    return value;
  }

  function renderInlineEditor(promo: Promo) {
    if (expandedId !== promo.id) return null;
    const pbAction = actionTypes.find((a) => a.id === parseInt(pbForm.action_type_id, 10));
    const needsValue = (code?: string) => code && code !== 'waive';

    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {editError && <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <FormLabel>{t('label_name')} *</FormLabel>
            <input
              ref={nameInputRef}
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', marginBottom: 12 }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <FormLabel>{t('label_description')}</FormLabel>
            <FormInput
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
            />
          </div>
          <div>
            <FormLabel>{t('label_starts')} *</FormLabel>
            <FormInput
              type="date"
              value={editForm.starts_at}
              onChange={(e) => setEditForm({ ...editForm, starts_at: e.target.value })}
            />
          </div>
          <div>
            <FormLabel>{t('label_ends')} *</FormLabel>
            <FormInput
              type="date"
              value={editForm.ends_at}
              onChange={(e) => setEditForm({ ...editForm, ends_at: e.target.value })}
            />
          </div>
          <div>
            <FormLabel>{t('label_status')}</FormLabel>
            <select
              value={editForm.status}
              onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
              style={selectSt}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={editForm.stackable}
                onChange={(e) => setEditForm({ ...editForm, stackable: e.target.checked })}
              />
              {t('label_stackable')}
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(promo.id)} disabled={editSaving} style={btnSmall('#6c63ff')}>
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>

        {/* Charge Benefits */}
        <div style={sectionSt}>
          <p style={sectionTitle}>{t('section_charge_benefits')}</p>
          {benefitsLoading ? <p style={hintSt}>{t('loading')}</p> : (
            <>
              {gymCharges.length === 0 ? (
                <p style={hintSt}>{t('no_charge_benefits')}</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px 12px', alignItems: 'center', marginBottom: 12 }}>
                  {gymCharges.map((gc) => {
                    const draft = cbDraft[gc.id] ?? { action: 'no_benefit', value: '' };
                    return (
                      <>
                        <span key={`name-${gc.id}`} style={{ fontSize: 13 }}>{gc.charge_type_name}</span>
                        <select
                          key={`action-${gc.id}`}
                          value={draft.action}
                          onChange={(e) => setCbDraft({ ...cbDraft, [gc.id]: { ...draft, action: e.target.value } })}
                          style={{ ...inlineSel, minWidth: 160, flex: 'none' }}
                        >
                          {CHARGE_ACTIONS.map((a) => (
                            <option key={a} value={a}>{t(`cb_action_${a}` as any)}</option>
                          ))}
                        </select>
                        {draft.action !== 'no_benefit' && draft.action !== 'waive' ? (
                          <input
                            key={`value-${gc.id}`}
                            type="number" min="0" step="0.01"
                            value={draft.value}
                            onChange={(e) => setCbDraft({ ...cbDraft, [gc.id]: { ...draft, value: e.target.value } })}
                            style={{ ...inlineSel, width: 90, minWidth: 0, flex: 'none' }}
                          />
                        ) : (
                          <span key={`placeholder-${gc.id}`} />
                        )}
                      </>
                    );
                  })}
                </div>
              )}
              {gymCharges.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={() => saveChargeBenefits(promo.id)} disabled={cbSaving} style={btnSmall('#6c63ff')}>
                    {cbSaving ? t('saving') : t('save_charge_benefits')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Period Benefits */}
        <div style={sectionSt}>
          <p style={sectionTitle}>{t('section_period_benefits')}</p>
          {benefitsLoading ? <p style={hintSt}>{t('loading')}</p> : (
            <>
              {periodBenefits.length > 0 && (
                <table style={tableSt}>
                  <thead>
                    <tr>
                      <th style={thSt}>{t('col_plan')}</th>
                      <th style={thSt}>{t('col_action')}</th>
                      <th style={thSt}>{t('col_value')}</th>
                      <th style={thSt}>{t('col_duration')}</th>
                      <th style={{ ...thSt, width: 48 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {periodBenefits.map((pb) => (
                      <tr key={pb.id}>
                        <td style={tdSt}>{pb.membership_plan_name}</td>
                        <td style={tdSt}>{tAction(pb.action_code as any)}</td>
                        <td style={tdSt}>{pb.value ?? '—'}</td>
                        <td style={tdSt}>{t('duration_months').replace('{n}', String(pb.duration_months))}</td>
                        <td style={tdSt}>
                          <button onClick={() => deletePeriodBenefit(promo.id, pb.id)} style={btnSmall('#c0392b')}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {periodBenefits.length === 0 && <p style={hintSt}>{t('no_period_benefits')}</p>}

              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <select value={pbForm.membership_plan_id} onChange={(e) => setPbForm({ ...pbForm, membership_plan_id: e.target.value })} style={inlineSel}>
                  <option value="">{t('label_plan')}</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={pbForm.action_type_id} onChange={(e) => setPbForm({ ...pbForm, action_type_id: e.target.value })} style={inlineSel}>
                  <option value="">{t('label_action_type')}</option>
                  {actionTypes.map((a) => <option key={a.id} value={a.id}>{tAction(a.code as any)}</option>)}
                </select>
                {needsValue(pbAction?.code) && (
                  <input
                    type="number" min="0" step="0.01"
                    placeholder={t('label_value')}
                    value={pbForm.value}
                    onChange={(e) => setPbForm({ ...pbForm, value: e.target.value })}
                    style={{ ...inlineSel, width: 100 }}
                  />
                )}
                <input
                  type="number" min="1" step="1"
                  placeholder={t('label_duration_months')}
                  value={pbForm.duration_months}
                  onChange={(e) => setPbForm({ ...pbForm, duration_months: e.target.value })}
                  style={{ ...inlineSel, width: 130 }}
                />
                <button
                  onClick={() => addPeriodBenefit(promo.id)}
                  disabled={pbSaving || !pbForm.membership_plan_id || !pbForm.action_type_id || !pbForm.duration_months}
                  style={btnSmall('#6c63ff')}
                >
                  {t('add_period_benefit')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderRow(promo: Promo) {
    const isExpanded = expandedId === promo.id;
    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailFor(promo) },
      { label: t('edit'), onClick: () => openEdit(promo) },
      { label: t('duplicate'), onClick: () => handleDuplicate(promo) },
      { label: t('delete'), onClick: () => setDeleting(promo), danger: true },
    ];

    return (
      <div key={promo.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12 }}>
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{promo.name}</span>
            {promo.description && (
              <div style={{ color: '#666', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {promo.description}
              </div>
            )}
          </div>
          <div style={{ width: 110, flexShrink: 0, color: '#555', fontSize: 13 }}>
            {promo.primary_action_type ? tAction(promo.primary_action_type as any) : '—'}
          </div>
          <div style={{ width: 70, flexShrink: 0, color: '#555', fontSize: 13 }}>
            {fmtValue(promo.primary_action_type, promo.primary_value != null ? String(promo.primary_value) : null)}
          </div>
          <div style={{ width: 180, flexShrink: 0, color: '#888', fontSize: 13 }}>
            {fmtPeriod(promo.starts_at, promo.ends_at)}
          </div>
          <div style={{ width: 80, flexShrink: 0 }}>
            <StatusBadge status={promo.status} label={tStatus(promo.status)} />
          </div>
          <div style={{ width: 110, flexShrink: 0, color: '#888', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {promo.created_by_name ?? '—'}
          </div>
          <div style={{ width: 90, flexShrink: 0, color: '#888', fontSize: 13 }}>{iso(promo.created_at)}</div>
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
        {isExpanded && renderInlineEditor(promo)}
      </div>
    );
  }

  function renderHeader() {
    return (
      <div style={{ display: 'flex', padding: '6px 16px', marginBottom: 4, color: '#999', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', gap: 12 }}>
        <span style={{ flex: 2 }}>{t('col_name')}</span>
        <span style={{ width: 110, flexShrink: 0 }}>{t('col_type')}</span>
        <span style={{ width: 70, flexShrink: 0 }}>{t('col_value')}</span>
        <span style={{ width: 180, flexShrink: 0 }}>{t('col_period')}</span>
        <span style={{ width: 80, flexShrink: 0 }}>{t('col_status')}</span>
        <span style={{ width: 110, flexShrink: 0 }}>{t('col_created_by')}</span>
        <span style={{ width: 90, flexShrink: 0 }}>{t('col_created')}</span>
        <span style={{ width: 36, flexShrink: 0 }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 260 }}
          />
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleNew} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <>
          {renderHeader()}
          {rows.map(renderRow)}
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {detailFor && (
        <PromotionDetailModal
          promotionId={detailFor.id}
          promotionName={detailFor.name}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}

/* ---- styles ---- */
const selectSt: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
  marginBottom: 12,
};
const inlineSel: React.CSSProperties = {
  flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 13, boxSizing: 'border-box', background: '#fff', minWidth: 130,
};
const sectionSt: React.CSSProperties = { marginTop: 24, paddingTop: 20, borderTop: '1px solid #eee' };
const sectionTitle: React.CSSProperties = { margin: '0 0 12px', fontWeight: 600, fontSize: 13, color: '#333', textTransform: 'uppercase', letterSpacing: '0.04em' };
const tableSt: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thSt: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600, borderBottom: '1px solid #eee', fontSize: 12 };
const tdSt: React.CSSProperties = { padding: '7px 8px', borderBottom: '1px solid #f5f5f5', verticalAlign: 'middle' };
const hintSt: React.CSSProperties = { color: '#888', fontSize: 13, margin: '0 0 4px' };
