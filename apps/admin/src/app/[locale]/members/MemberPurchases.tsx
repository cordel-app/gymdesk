'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateTime } from '@/lib/gymFormat';
import { PurchaseHeading } from './PurchaseHeading';
import {
  cardDetailLabelStyle, cardDetailRowStyle, cardDetailValueStyle, cardExpandCaretStyle, cardExpandToggleStyle,
  cardMutedTextStyle, cardSubLabelStyle, cardTextLinkStyle, formErrorStyle, innerCardStyle,
} from '@/components/formChrome';
import { NormalizedPaymentStatusBadge, BillingEventStatusBadge } from '../payments/billing-events/BillingEventShared';
import {
  beneficiaryNameIfOther, otherBeneficiaryNames, productTypeLabelKey, purchaseEventPath, purchaseIsEmpty,
  type MemberPurchase, type PurchaseBillingEvent,
} from './purchasesTabView';

/**
 * #3273 — the Member card's **Purchases** tab. Read-only: one card per `purchases` row the Member
 * owns or benefits from (`GET /payments/purchases?member_id=`), newest first, each expanding into
 * the plans it contracted (with their included Products beneath them), its standalone Products, and
 * the payment of its own Billing Event. Every decision is the API's; this draws.
 */
export function MemberPurchases({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [items, setItems] = useState<MemberPurchase[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    apiFetch<{ items: MemberPurchase[] }>(`/payments/purchases?member_id=${memberId}&limit=200`)
      .then((r) => { setItems(r.items ?? []); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  if (failed) return <p style={formErrorStyle}>{t('members.purchases_error')}</p>;
  if (items === null) return <p style={cardMutedTextStyle}>{t('members.purchases_loading')}</p>;
  if (items.length === 0) return <p style={cardMutedTextStyle}>{t('members.purchases_empty')}</p>;

  const toggle = (id: number) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const typeLabel = (type: string | null) => { const k = productTypeLabelKey(type); return k ? t(k as any) : (type ?? ''); };
  const forName = (name: string | null) => (name ? ` · ${t('members.purchases_for', { name })}` : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((p) => {
        const expanded = open.has(p.id);
        const event = p.billing_events[0];
        return (
          <div key={p.id} style={innerCardStyle}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(p.id)}
              style={{ ...cardExpandToggleStyle, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', width: '100%' }}
            >
              <span style={{ ...cardExpandCaretStyle, transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
              {/* #3270's name: the translated label and the creation instant in the browser's locale. */}
              <PurchaseHeading purchase={{ id: p.id, name: p.name ?? p.created_at, status: p.status }} />
              <span style={cardMutedTextStyle}>#{p.id}</span>
              {event && <span style={cardMutedTextStyle}>· {t('members.purchases_event_ref', { id: event.id })}</span>}
            </button>

            {expanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                <div style={cardDetailRowStyle}>
                  <span style={cardDetailLabelStyle}>{t('members.purchases_buyer')}</span>
                  <span style={cardDetailValueStyle}>{p.owner.name ?? `#${p.owner.id}`}</span>
                </div>

                {p.plans.length > 0 && (
                  <div>
                    <div style={cardSubLabelStyle}>{t('members.purchases_plans')}</div>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {p.plans.map((plan) => {
                        const others = otherBeneficiaryNames(plan, p.owner);
                        return (
                          <li key={plan.plan_snapshot_id}>
                            {plan.name ?? `#${plan.membership_plan_id ?? plan.plan_snapshot_id}`}
                            {others.length > 0 && <span style={cardMutedTextStyle}>{forName(others.join(', '))}</span>}
                            {plan.products.length > 0 && (
                              <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
                                {plan.products.map((line, i) => (
                                  <li key={`${line.kind}-${line.product_id}-${i}`} style={cardMutedTextStyle}>
                                    {line.name ?? '—'} · {typeLabel(line.product_type)} · ×{line.quantity}
                                    {forName(beneficiaryNameIfOther(line.beneficiary, p.owner))}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {p.products.length > 0 && (
                  <div>
                    <div style={cardSubLabelStyle}>{t('members.purchases_products')}</div>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {p.products.map((line, i) => (
                        <li key={`${line.kind}-${line.line_id}-${i}`}>
                          {line.name ?? '—'} <span style={cardMutedTextStyle}>· {typeLabel(line.product_type)} · ×{line.quantity}
                            {forName(beneficiaryNameIfOther(line.beneficiary, p.owner))}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {purchaseIsEmpty(p) && <p style={cardMutedTextStyle}>{t('members.purchases_no_items')}</p>}

                <div>
                  <div style={cardSubLabelStyle}>{t('members.purchases_payment')}</div>
                  {p.billing_events.length === 0
                    ? <p style={cardMutedTextStyle}>{t('members.purchases_not_paid')}</p>
                    : p.billing_events.map((e) => (
                      <PaymentDetails key={e.id} event={e} locale={locale} gym={gym} t={t} />
                    ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PaymentDetails({ event, locale, gym, t }: {
  event: PurchaseBillingEvent; locale: string; gym: ReturnType<typeof useGymFormatSettings>; t: ReturnType<typeof useTranslations>;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div style={cardDetailRowStyle}>
      <span style={cardDetailLabelStyle}>{label}</span>
      <span style={cardDetailValueStyle}>{value}</span>
    </div>
  );
  return (
    <div style={{ marginTop: 4 }}>
      {row(t('members.purchases_billing_event'), (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href={purchaseEventPath(locale, event.id)} style={cardTextLinkStyle}>
            {event.name ?? t('members.purchases_event_ref', { id: event.id })}
          </Link>
          <BillingEventStatusBadge row={event} t={t as any} />
          {event.amount != null && <span>{formatGymAmount(Number(event.amount), gym)}</span>}
        </span>
      ))}
      {row(t('members.purchases_payment_method'), event.payment_method_name ?? '—')}
      {row(t('members.purchases_payment_status'), <NormalizedPaymentStatusBadge status={event.payment_status} t={t as any} />)}
      {row(t('members.purchases_payment_date'), event.paid_at ? formatGymDateTime(event.paid_at, gym) : '—')}
    </div>
  );
}
