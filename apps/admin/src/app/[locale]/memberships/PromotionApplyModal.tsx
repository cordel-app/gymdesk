'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface Membership { id: number; member_name: string; plan_name: string | null; final_price: string | null }
interface Applied {
  id: number; promotion_id: number; promotion_name: string;
  applied_by: string; applied_at: string; status: 'applied' | 'consumed' | 'revoked';
}
interface Promotion { id: number; name: string }

/**
 * P4.5: apply/revoke promotions on the given membership. The "eligible" set
 * is scoped to promos whose plan targeting includes the membership's plan
 * and whose window covers today — /promotions?active_on=today filters the
 * date, we filter the plan client-side via a join against plan targets.
 */
export function PromotionApplyModal({ membership, onClose }: { membership: Membership; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [applied, setApplied] = useState<Applied[]>([]);
  const [eligible, setEligible] = useState<Promotion[]>([]);
  const [pickId, setPickId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [ap, active] = await Promise.all([
        apiFetch<Applied[]>(`/user-memberships/${membership.id}/promotions`),
        apiFetch<Promotion[]>(`/promotions?status=active&active_on=${today}`),
      ]);
      setApplied(ap);
      // We show all currently-active promos; the backend rejects mismatched
      // plan targeting with a 400 on POST, so an ineligible pick surfaces as
      // a toast rather than being silently hidden.
      setEligible(active);
    } catch (err: any) { toast(err.message ?? t('memberships.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [membership.id]);

  async function apply() {
    if (!pickId) return;
    setSaving(true);
    try {
      await apiFetch(`/user-memberships/${membership.id}/promotions`, { method: 'POST', body: JSON.stringify({ promotion_id: parseInt(pickId, 10) }) });
      setPickId('');
      load();
    } catch (err: any) { toast(err.message ?? t('memberships.error_generic')); }
    finally { setSaving(false); }
  }

  async function revoke(promoId: number) {
    try {
      await apiFetch(`/user-memberships/${membership.id}/promotions/${promoId}`, { method: 'DELETE' });
      load();
    } catch (err: any) { toast(err.message ?? t('memberships.error_generic')); }
  }

  const activeApplied = applied.filter((a) => a.status === 'applied');

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('memberships.promotions_title')}</h2>
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>
          {membership.member_name}{membership.plan_name ? ` — ${membership.plan_name}` : ''}
        </p>

        {loading ? <p>{t('memberships.loading')}</p> : (
          <>
            <h3 style={h3}>{t('memberships.promotions_applied')}</h3>
            {activeApplied.length === 0 ? <p style={hint}>{t('memberships.promotions_none')}</p> : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {activeApplied.map((a) => (
                  <li key={a.id} style={row}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{a.promotion_name}</div>
                      <div style={{ fontSize: 12, color: '#888' }}>
                        {t('memberships.applied_by', { by: a.applied_by?.slice(0, 12) ?? '—', at: a.applied_at.slice(0, 10) })}
                      </div>
                    </div>
                    <button onClick={() => revoke(a.promotion_id)} style={btnSmall('#c0392b')}>{t('memberships.revoke')}</button>
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ ...h3, marginTop: 16 }}>{t('memberships.promotions_apply')}</h3>
            {eligible.length === 0 ? <p style={hint}>{t('memberships.promotions_no_eligible')}</p> : (
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={pickId} onChange={(e) => setPickId(e.target.value)}
                        style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}>
                  <option value="">—</option>
                  {eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={apply} disabled={saving || !pickId} style={btnStyle('#6c63ff')}>
                  {saving ? t('memberships.saving') : t('memberships.promotions_apply_button')}
                </button>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('memberships.close')}</button>
        </div>
      </div>
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#333' };
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f4f4f4' };
const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
