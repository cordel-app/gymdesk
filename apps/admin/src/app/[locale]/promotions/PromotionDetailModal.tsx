'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

/**
 * P4.2 + P4.3: plan targeting + charge benefits + period benefits inside one drawer.
 * Loads all four sub-endpoints in parallel and lets admin edit them individually.
 */
interface Promotion { id: number; name: string }
interface Plan { id: number; name: string }
interface ChargeType { id: number; code: string }
interface ActionType { id: number; code: string }
interface ChargeBenefit { id: number; charge_type_id: number; action_type_id: number; value: string | null }
interface PeriodBenefit { id: number; required_paid_months: number; granted_free_periods: number }

export function PromotionDetailModal({ promotion, onClose }: { promotion: Promotion; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<Set<number>>(new Set());
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const [chargeBenefits, setChargeBenefits] = useState<ChargeBenefit[]>([]);
  const [periodBenefits, setPeriodBenefits] = useState<PeriodBenefit[]>([]);
  const [loading, setLoading] = useState(true);

  const [cbForm, setCbForm] = useState({ charge_type_id: '', action_type_id: '', value: '' });
  const [pbForm, setPbForm] = useState({ required_paid_months: '', granted_free_periods: '' });

  async function load() {
    setLoading(true);
    try {
      const [pl, ct, at, mine, cb, pb] = await Promise.all([
        apiFetch<Plan[]>('/membership-plans?status=active'),
        apiFetch<ChargeType[]>('/charge-types'),
        apiFetch<ActionType[]>('/action-types'),
        apiFetch<Plan[]>(`/promotions/${promotion.id}/plans`),
        apiFetch<ChargeBenefit[]>(`/promotions/${promotion.id}/charge-benefits`),
        apiFetch<PeriodBenefit[]>(`/promotions/${promotion.id}/period-benefits`),
      ]);
      setPlans(pl); setChargeTypes(ct); setActionTypes(at);
      setSelectedPlans(new Set(mine.map((p) => p.id)));
      setChargeBenefits(cb); setPeriodBenefits(pb);
    } catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [promotion.id]);

  async function savePlans() {
    try {
      await apiFetch(`/promotions/${promotion.id}/plans`, { method: 'PUT', body: JSON.stringify({ membership_plan_ids: Array.from(selectedPlans) }) });
      toast(t('promotions.saved'));
    } catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
  }

  async function addChargeBenefit() {
    const action = actionTypes.find((a) => a.id === parseInt(cbForm.action_type_id, 10));
    if (!cbForm.charge_type_id || !cbForm.action_type_id) return;
    const body: any = {
      charge_type_id: parseInt(cbForm.charge_type_id, 10),
      action_type_id: parseInt(cbForm.action_type_id, 10),
      value: action?.code === 'waive' ? null : parseFloat(cbForm.value),
    };
    try {
      await apiFetch(`/promotions/${promotion.id}/charge-benefits`, { method: 'POST', body: JSON.stringify(body) });
      setCbForm({ charge_type_id: '', action_type_id: '', value: '' });
      load();
    } catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
  }

  async function deleteChargeBenefit(id: number) {
    try { await apiFetch(`/promotions/${promotion.id}/charge-benefits/${id}`, { method: 'DELETE' }); load(); }
    catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
  }

  async function addPeriodBenefit() {
    if (!pbForm.required_paid_months || !pbForm.granted_free_periods) return;
    try {
      await apiFetch(`/promotions/${promotion.id}/period-benefits`, { method: 'POST', body: JSON.stringify({
        required_paid_months: parseInt(pbForm.required_paid_months, 10),
        granted_free_periods: parseInt(pbForm.granted_free_periods, 10),
      })});
      setPbForm({ required_paid_months: '', granted_free_periods: '' });
      load();
    } catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
  }

  async function deletePeriodBenefit(id: number) {
    try { await apiFetch(`/promotions/${promotion.id}/period-benefits/${id}`, { method: 'DELETE' }); load(); }
    catch (err: any) { toast(err.message ?? t('promotions.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 680, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('promotions.detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{promotion.name}</p>

        {loading ? <p>{t('promotions.loading')}</p> : (
          <>
            <section style={section}>
              <h3 style={h3}>{t('promotions.section_plans')}</h3>
              {plans.length === 0 ? <p style={hint}>{t('promotions.no_plans')}</p> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                  {plans.map((p) => (
                    <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={selectedPlans.has(p.id)}
                             onChange={(e) => {
                               const next = new Set(selectedPlans);
                               if (e.target.checked) next.add(p.id); else next.delete(p.id);
                               setSelectedPlans(next);
                             }} />
                      {p.name}
                    </label>
                  ))}
                </div>
              )}
              <button onClick={savePlans} style={{ ...btnStyle('#6c63ff'), marginTop: 10 }}>{t('promotions.save_plans')}</button>
            </section>

            <section style={section}>
              <h3 style={h3}>{t('promotions.section_charge_benefits')}</h3>
              {chargeBenefits.length === 0 ? <p style={hint}>{t('promotions.no_charge_benefits')}</p> : (
                <ul style={list}>
                  {chargeBenefits.map((cb) => {
                    const ct = chargeTypes.find((c) => c.id === cb.charge_type_id);
                    const at = actionTypes.find((a) => a.id === cb.action_type_id);
                    return (
                      <li key={cb.id} style={rowStyle}>
                        <span style={{ flex: 1 }}>
                          {ct ? t(`charge_type.${ct.code}`) : `#${cb.charge_type_id}`} — {at ? t(`action_type.${at.code}`) : `#${cb.action_type_id}`}
                          {cb.value !== null && ` (${cb.value})`}
                        </span>
                        <button onClick={() => deleteChargeBenefit(cb.id)} style={btnSmall('#c0392b')}>{t('promotions.delete')}</button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <select value={cbForm.charge_type_id} onChange={(e) => setCbForm({ ...cbForm, charge_type_id: e.target.value })} style={input}>
                  <option value="">{t('promotions.charge_type')}</option>
                  {chargeTypes.map((c) => <option key={c.id} value={c.id}>{t(`charge_type.${c.code}`)}</option>)}
                </select>
                <select value={cbForm.action_type_id} onChange={(e) => setCbForm({ ...cbForm, action_type_id: e.target.value })} style={input}>
                  <option value="">{t('promotions.action_type')}</option>
                  {actionTypes.map((a) => <option key={a.id} value={a.id}>{t(`action_type.${a.code}`)}</option>)}
                </select>
                <input type="number" min="0" step="0.01" placeholder={t('promotions.value')}
                       value={cbForm.value} onChange={(e) => setCbForm({ ...cbForm, value: e.target.value })}
                       style={{ ...input, width: 100 }} />
                <button onClick={addChargeBenefit} style={btnStyle('#6c63ff')}>{t('promotions.add')}</button>
              </div>
            </section>

            <section style={section}>
              <h3 style={h3}>{t('promotions.section_period_benefits')}</h3>
              {periodBenefits.length === 0 ? <p style={hint}>{t('promotions.no_period_benefits')}</p> : (
                <ul style={list}>
                  {periodBenefits.map((pb) => (
                    <li key={pb.id} style={rowStyle}>
                      <span style={{ flex: 1 }}>{t('promotions.pay_get', { paid: pb.required_paid_months, free: pb.granted_free_periods })}</span>
                      <button onClick={() => deletePeriodBenefit(pb.id)} style={btnSmall('#c0392b')}>{t('promotions.delete')}</button>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input type="number" min="1" step="1" placeholder={t('promotions.paid_months')}
                       value={pbForm.required_paid_months} onChange={(e) => setPbForm({ ...pbForm, required_paid_months: e.target.value })}
                       style={input} />
                <input type="number" min="1" step="1" placeholder={t('promotions.free_periods')}
                       value={pbForm.granted_free_periods} onChange={(e) => setPbForm({ ...pbForm, granted_free_periods: e.target.value })}
                       style={input} />
                <button onClick={addPeriodBenefit} style={btnStyle('#6c63ff')}>{t('promotions.add')}</button>
              </div>
            </section>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('promotions.close')}</button>
        </div>
      </div>
    </div>
  );
}

const section: React.CSSProperties = { marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid #eee' };
const h3: React.CSSProperties = { margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#333' };
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f5f5f5' };
const input: React.CSSProperties = { flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
