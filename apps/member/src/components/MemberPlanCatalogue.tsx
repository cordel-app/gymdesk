'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #1122 §2–§5 — the look of the **Add Plan** catalogue: one card per plan a
 * member may choose, its price and cadence, the Promotions compatible with it
 * (each with its benefit, its duration and the action that applies it) and
 * the final price the chosen Promotion makes of it.
 *
 * It is `MemberProductsSection` (#1121) one entity over, and it resolves
 * nothing: every string arrives already translated and every amount already
 * formatted by `lib/memberPlanCatalogue.ts`, so this file calls no `t()`,
 * reads no row and spells no colour of its own (#983).
 */

export interface MemberPlanCardPromotion {
  key: string;
  heading: string;
  name: string;
  benefit?: string | null;
  duration?: string | null;
  /** *Apply promotion*, or the applied-state label. The page composes it. */
  action?: ReactNode;
}

export interface MemberPlanCardBenefit {
  key: string;
  name: string;
  /** *Mandatory* / *Optional* — already translated. */
  tag: string;
  mandatory: boolean;
  checked: boolean;
  onToggle: () => void;
}

export interface MemberPlanCardItem {
  key: string;
  name: string;
  description?: string | null;
  /** The catalogue price, formatted; `null` renders `—`. */
  price: string | null;
  frequency?: string | null;
  /** *Final price* — the label and the figure, shown only once a Promotion is applied. */
  finalPriceLabel?: string | null;
  finalPrice?: string | null;
  /** Benefits included in the plan; optional ones can be unticked (#1184 3b). */
  benefitsHeading?: string;
  benefits?: MemberPlanCardBenefit[];
  promotions?: MemberPlanCardPromotion[];
  /** The card's one action row: *Choose this plan*. */
  action?: ReactNode;
}

export function MemberPlanCatalogue({ title, emptyLabel, items, onClose, closeLabel }: {
  title: string;
  emptyLabel: string;
  items: MemberPlanCardItem[];
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <section style={styles.section}>
      <div style={styles.headRow}>
        <h2 style={styles.heading}>{title}</h2>
        <button type="button" onClick={onClose} style={styles.closeBtn}>{closeLabel}</button>
      </div>
      {items.length === 0 ? (
        <div style={styles.emptyCard}><p style={styles.empty}>{emptyLabel}</p></div>
      ) : (
        <ul style={styles.list}>
          {items.map((item) => (
            <li key={item.key} style={styles.card}>
              <div style={styles.head}>
                <span style={styles.name}>{item.name}</span>
                <span style={styles.priceGroup}>
                  <span style={styles.price}>{item.price ?? '—'}</span>
                  {item.frequency && <span style={styles.frequency}>/ {item.frequency}</span>}
                </span>
              </div>
              {item.description && <p style={styles.description}>{item.description}</p>}
              {(item.benefits ?? []).length > 0 && (
                <div style={styles.promotion}>
                  <span style={styles.promotionHeading}>{item.benefitsHeading}</span>
                  {item.benefits!.map((b) => (
                    <label key={b.key} style={styles.benefitRow}>
                      <input
                        type="checkbox"
                        checked={b.mandatory || b.checked}
                        disabled={b.mandatory}
                        onChange={b.onToggle}
                      />
                      <span style={styles.benefitName}>{b.name}</span>
                      <span style={styles.promotionBenefit}>{b.tag}</span>
                    </label>
                  ))}
                </div>
              )}
              {(item.promotions ?? []).map((promotion) => (
                <div key={promotion.key} style={styles.promotion}>
                  <span style={styles.promotionHeading}>{promotion.heading}</span>
                  <span style={styles.promotionName}>{promotion.name}</span>
                  {(promotion.benefit || promotion.duration) && (
                    <span style={styles.promotionBenefit}>
                      {[promotion.benefit, promotion.duration].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {promotion.action && <div style={styles.promotionAction}>{promotion.action}</div>}
                </div>
              ))}
              {item.finalPrice && (
                <div style={styles.finalRow}>
                  <span style={styles.finalLabel}>{item.finalPriceLabel}</span>
                  <span style={styles.finalPrice}>{item.finalPrice}</span>
                </div>
              )}
              {item.action && <div style={styles.action}>{item.action}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 16 },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 },
  heading: { margin: 0, fontSize: 16, fontWeight: 600, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  closeBtn: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: memberTheme.textMuted },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  card: { ...sectionCardStyle, padding: '12px 14px' },
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  name: { fontSize: 14.5, fontWeight: 600, color: memberTheme.text, minWidth: 0 },
  priceGroup: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' },
  price: { fontSize: 15, fontWeight: 700, color: memberTheme.text, fontVariantNumeric: 'tabular-nums' },
  frequency: { fontSize: 12.5, color: memberTheme.textMuted },
  description: { margin: '6px 0 0', fontSize: 13, color: memberTheme.textSecondary, lineHeight: 1.5 },
  promotion: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${memberTheme.separator}` },
  promotionHeading: { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: memberTheme.textMuted },
  promotionName: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
  benefitRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: memberTheme.text },
  benefitName: { flex: 1, minWidth: 0 },
  promotionBenefit: { fontSize: 12.5, color: memberTheme.textSecondary },
  promotionAction: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  finalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: `1px solid ${memberTheme.separator}` },
  finalLabel: { fontSize: 12.5, color: memberTheme.textSecondary },
  finalPrice: { fontSize: 15, fontWeight: 700, color: memberTheme.text, fontVariantNumeric: 'tabular-nums' },
  action: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  emptyCard: { ...sectionCardStyle, padding: '16px 14px' },
  empty: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
};
