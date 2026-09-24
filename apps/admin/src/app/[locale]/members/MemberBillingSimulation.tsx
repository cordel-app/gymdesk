'use client';

// #629 (stage 1) — the Member's consolidated Billing Simulation.
//
// Placed at Member level, in its own section, per the #629 thread's Q4 answer
// ("land the engine once and render it where #634 wants it from the start"):
// #634 requires the simulation to be a section of its own, never nested inside
// a Membership Plan card, and to cover everything the Member pays for.
//
// Read-only and non-persisted: it renders whatever
// GET /user-memberships/member/:id/billing-simulation computes on the spot, so
// it always reflects the current configuration. All of the money/benefit
// resolution happens server-side — this file formats, it never recomputes
// (CLAUDE.md: no business logic duplicated in the frontend).

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';

type BenefitAction = 'no_benefit' | 'waive' | 'percentage_discount' | 'fixed_discount' | 'fixed_price' | 'included';
type PeriodStatus = 'free_promotion' | 'pay_promotion' | 'prepaid_promotion' | 'bonus_promotion' | 'pay_regular';
// #635 stage 8 — the Plan's own Billing & Duration. Only the two periods that
// waive the Membership Fee ever reach a benefit line; the others are the
// regular price and carry no explanation.
type PlanPeriodStatus = 'free_plan' | 'pay_plan' | 'bonus_plan' | 'pay_regular';

interface SimulationBenefit {
  /** `membership_plan` = the assignment's own Free Period / Bonus Duration. */
  source: 'promotion' | 'membership_plan';
  name: string | null;
  action: BenefitAction;
  value: number | null;
  period_status: PeriodStatus | PlanPeriodStatus | null;
}

interface SimulationLine {
  kind: 'membership_fee' | 'sellable_item';
  label: string;
  user_membership_id: number;
  plan_name: string | null;
  gym_charge_id: number | null;
  quantity: number;
  unit_price: number;
  regular_price: number;
  benefits: SimulationBenefit[];
  actual_charge: number;
  price_may_change: boolean;
}

interface SimulationEvent {
  date: string;
  period_end: string | null;
  lines: SimulationLine[];
  total: number;
}

interface SimulationSection {
  section: string;
  events: SimulationEvent[];
  total: number;
}

interface BillingSimulation {
  available: boolean;
  reason: string | null;
  currency: string;
  start_date: string | null;
  horizon_date: string | null;
  truncated: boolean;
  sections: SimulationSection[];
  total: number;
}

// The server decides the order of `sections`; this only maps each to its label.
const SECTION_LABEL_KEY: Record<string, string> = {
  one_off: 'billing_simulation_section_one_off',
  year: 'billing_simulation_section_year',
  month: 'billing_simulation_section_month',
  four_weeks: 'billing_simulation_section_four_weeks',
  week: 'billing_simulation_section_week',
  session: 'billing_simulation_section_session',
  other: 'billing_simulation_section_other',
};

const PERIOD_STATUS_KEY: Record<PeriodStatus, string> = {
  free_promotion: 'timeline_free',
  pay_promotion: 'timeline_pay_promo',
  prepaid_promotion: 'timeline_prepaid_promo',
  bonus_promotion: 'timeline_bonus',
  pay_regular: 'timeline_pay_regular',
};

// The Plan's own periods read in the `members` namespace, not the Promotions
// one: "Plan free period" and a Promotion's "Free (promotion)" are different
// statements and can appear on the same charge's neighbours.
const PLAN_PERIOD_STATUS_KEY: Record<PlanPeriodStatus, string> = {
  free_plan: 'billing_simulation_plan_free',
  bonus_plan: 'billing_simulation_plan_bonus',
  pay_plan: 'billing_simulation_plan_paid',
  pay_regular: 'billing_simulation_plan_regular',
};

/** DD/MM/YYYY from a plain YYYY-MM-DD, without going through Date (no timezone shift). */
function fmtDay(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

function fmtMoney(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

export function MemberBillingSimulation({ memberId }: { memberId: number }) {
  const t = useTranslations('members');
  const tPromo = useTranslations('promotions');
  const { apiFetch } = useApiClient();
  const loadedRef = useRef(false);

  const [simulation, setSimulation] = useState<BillingSimulation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        setSimulation(await apiFetch<BillingSimulation>(`/user-memberships/member/${memberId}/billing-simulation`));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function benefitLabel(benefit: SimulationBenefit): string {
    const parts: string[] = [];
    if (benefit.period_status && benefit.period_status !== 'pay_regular') {
      parts.push(benefit.source === 'membership_plan'
        ? t(PLAN_PERIOD_STATUS_KEY[benefit.period_status as PlanPeriodStatus])
        : tPromo(PERIOD_STATUS_KEY[benefit.period_status as PeriodStatus]));
    }
    switch (benefit.action) {
      case 'included': parts.push(t('billing_simulation_benefit_included')); break;
      case 'waive': parts.push(t('billing_simulation_benefit_waive')); break;
      case 'fixed_price': parts.push(t('billing_simulation_benefit_fixed_price', { amount: fmtMoney(benefit.value ?? 0) })); break;
      case 'percentage_discount': parts.push(t('billing_simulation_benefit_percentage', { value: benefit.value ?? 0 })); break;
      case 'fixed_discount': parts.push(t('billing_simulation_benefit_fixed_discount', { amount: fmtMoney(benefit.value ?? 0) })); break;
      default: break;
    }
    if (benefit.name) parts.push(benefit.name);
    return parts.join(' · ');
  }

  if (loading) return <p style={dim}>{t('billing_simulation_loading')}</p>;
  if (error) return <p style={dim}>{t('billing_simulation_error')}</p>;
  if (!simulation) return null;
  if (!simulation.available) {
    return <p style={dim}>{simulation.reason ?? t('billing_simulation_unavailable')}</p>;
  }

  const anyPriceMayChange = simulation.sections.some(
    (s) => s.events.some((e) => e.lines.some((l) => l.price_may_change)),
  );

  return (
    <div>
      {simulation.sections.map((section) => (
        <div key={section.section} style={{ marginBottom: 14 }}>
          <div style={subLabelStyle}>{t(SECTION_LABEL_KEY[section.section] ?? 'billing_simulation_section_other')}</div>
          {section.events.map((event) => (
            <div key={`${event.date}-${event.period_end ?? ''}`} style={card}>
              <div style={eventHeader}>
                <span>
                  {fmtDay(event.date)}
                  {event.period_end && <span style={{ color: '#888' }}> → {fmtDay(event.period_end)}</span>}
                </span>
                <span>{fmtMoney(event.total)}</span>
              </div>
              {event.lines.map((line, i) => (
                <div key={`${line.user_membership_id}-${line.gym_charge_id ?? 'fee'}-${i}`} style={lineRow}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13 }}>
                      {line.label}
                      {line.quantity > 1 && <span style={{ color: '#888' }}> ×{line.quantity}</span>}
                      {line.price_may_change && <span style={{ color: '#888' }}> *</span>}
                    </div>
                    {/* #634 §7: with several Membership Plans consolidated into
                        one simulation, each charge has to say which plan
                        generated it. */}
                    {line.plan_name && (
                      <div style={{ fontSize: 12, color: '#888' }}>{line.plan_name}</div>
                    )}
                    <div style={{ fontSize: 12, color: '#888' }}>
                      {t('billing_simulation_regular')}: {fmtMoney(line.regular_price)}
                      {line.benefits.map((b, bi) => (
                        <span key={bi}> · {benefitLabel(b)}</span>
                      ))}
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmtMoney(line.actual_charge)}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div style={sectionTotalRow}>
            <span>{t('billing_simulation_section_total')}</span>
            <span>{fmtMoney(section.total)}</span>
          </div>
        </div>
      ))}

      <div style={totalRow}>
        <span>{t('billing_simulation_total')}</span>
        <span>{fmtMoney(simulation.total)}</span>
      </div>

      {anyPriceMayChange && <p style={footnote}>{t('billing_simulation_price_note')}</p>}
      {simulation.truncated && <p style={footnote}>{t('billing_simulation_truncated')}</p>}
    </div>
  );
}

const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const card: React.CSSProperties = {
  background: '#fff', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '8px 12px', marginBottom: 6,
};
const subLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 4,
};
const eventHeader: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8,
  fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4,
};
const lineRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 12, padding: '4px 0', borderTop: '1px solid #f4f4f6',
};
const sectionTotalRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8,
  fontSize: 12, color: '#888', padding: '0 12px',
};
const totalRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 8,
  fontSize: 14, fontWeight: 700, borderTop: '1px solid #e8e8ed',
  paddingTop: 8, marginTop: 4,
};
const footnote: React.CSSProperties = { color: '#888', fontSize: 12, margin: '8px 0 0' };
