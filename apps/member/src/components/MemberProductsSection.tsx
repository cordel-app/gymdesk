'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * #1121 stages 1 and 2 — the look of the **Additional Products and Services**
 * subsection: the heading §3 asks for, one card per Product (§4), and the
 * action or state that card carries (§6).
 *
 * It is this ticket's `NutritionItemRow` (#932) and `MemberPaymentsCard`
 * (#1123): one place owns the chrome, and it **resolves nothing** — every
 * string arrives already translated and every amount already formatted by
 * `lib/memberProducts.ts`, so this file calls no `t()`, reads no row and spells
 * no colour of its own (#983: a Members App visual value is spelled in exactly
 * one place, `memberChrome.ts`).
 *
 * Three of its answers are the rule rather than the implementation.
 *
 *  - **A card holds no control of its own.** The Buy button and the
 *    *Purchased* / *Pending payment* pill arrive from the page as one
 *    `action` node, so this file decides neither what the action does nor
 *    whether it exists — a recurring Product simply has nothing in that slot
 *    (#1073: a control that cannot work is absent, never broken) — and there
 *    is no second card shape for a Product the member already holds.
 *  - **Nothing is laid out in a row that cannot wrap.** §9 forbids horizontal
 *    scrolling, so the name and the price are a `flexWrap` pair — the card
 *    narrows instead of scrolling.
 *  - **The price is the card's own emphasis and the only one.** §4 asks for
 *    name, description, price and the relevant quantity information; the
 *    quantity and the tax note are secondary lines under the name, so a long
 *    description cannot push the figure out of sight.
 */

/**
 * #1118 §4/§5 — the Promotion block under a Product's own information: what it
 * is called, what it does, how long it lasts and the action that applies it.
 *
 * Every string arrives resolved, and `applied` is what turns *Apply promotion*
 * into *Promotion applied* — the card decides neither.
 */
export interface MemberProductCardPromotion {
  key: string;
  /** The heading the block sits under — *Promotion*. */
  heading: string;
  name: string;
  /** *50% discount*; `null` for a treatment with nothing to say. */
  benefit?: string | null;
  /** *3 billing cycles*; `null` for a Promotion that names no period (§6). */
  duration?: string | null;
  /** The action, or the applied-state label. The page composes it. */
  action?: ReactNode;
}

/** One Product as the card draws it, with every string already resolved. */
export interface MemberProductCardItem {
  key: string;
  name: string;
  description?: string | null;
  /** The price, formatted; `null` renders `—`. */
  price: string | null;
  /**
   * The Product's own price, struck through, shown only where an applied
   * Promotion made it differ from `price` (#1118 §5). Never both the same
   * figure twice.
   */
  regularPrice?: string | null;
  /** *Monthly*, *Yearly*: shown beside the price for a recurring item only. */
  frequency?: string | null;
  /** Whatever the page composed about the item — its package size, its tax. */
  meta?: string | null;
  /** #1118 §4 — the Promotions offered on it, or the one it was bought under. */
  promotions?: MemberProductCardPromotion[];
  /**
   * The card's one action row: the Buy button, or the pill that says what the
   * member already holds. Nothing when neither applies.
   */
  action?: ReactNode;
}

export function MemberProductsSection({ title, emptyLabel, items }: {
  title: string;
  emptyLabel: string;
  items: MemberProductCardItem[];
}) {
  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>{title}</h2>
      {items.length === 0 ? (
        <div style={styles.emptyCard}>
          <p style={styles.empty}>{emptyLabel}</p>
        </div>
      ) : (
        <ul style={styles.list}>
          {items.map((item) => (
            <li key={item.key} style={styles.card}>
              <div style={styles.head}>
                <span style={styles.name}>{item.name}</span>
                <span style={styles.priceGroup}>
                  {item.regularPrice && (
                    <span style={styles.regularPrice}>{item.regularPrice}</span>
                  )}
                  <span style={styles.price}>{item.price ?? '—'}</span>
                  {item.frequency && <span style={styles.frequency}>/ {item.frequency}</span>}
                </span>
              </div>
              {item.description && <p style={styles.description}>{item.description}</p>}
              {item.meta && <p style={styles.meta}>{item.meta}</p>}
              {/* §4: directly below the Product's own information, and clearly
                  associated with it (§17) — inside the Product's card, never a
                  card of its own. */}
              {(item.promotions ?? []).map((promotion) => (
                <div key={promotion.key} style={styles.promotion}>
                  <span style={styles.promotionHeading}>{promotion.heading}</span>
                  <span style={styles.promotionName}>{promotion.name}</span>
                  {(promotion.benefit || promotion.duration) && (
                    <span style={styles.promotionBenefit}>
                      {[promotion.benefit, promotion.duration].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {promotion.action && (
                    <div style={styles.promotionAction}>{promotion.action}</div>
                  )}
                </div>
              ))}
              {item.action && <div style={styles.action}>{item.action}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 24 },
  heading: { margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: memberTheme.title2 },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  card: { ...sectionCardStyle, borderRadius: 10, padding: '12px 14px' },
  head: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 10, flexWrap: 'wrap',
  },
  name: { fontSize: 14.5, fontWeight: 600, color: memberTheme.text, minWidth: 0 },
  priceGroup: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' },
  price: { fontSize: 15, fontWeight: 700, color: memberTheme.text, fontVariantNumeric: 'tabular-nums' },
  // The price it was before the Promotion. Struck through and muted rather than
  // coloured: #983 keeps every Members App colour in `memberChrome.ts`, and a
  // discount is not one of the four status tones.
  regularPrice: {
    fontSize: 12.5, color: memberTheme.textMuted, textDecoration: 'line-through',
    fontVariantNumeric: 'tabular-nums',
  },
  frequency: { fontSize: 12.5, color: memberTheme.textMuted },
  description: { margin: '6px 0 0', fontSize: 13, color: memberTheme.textSecondary, lineHeight: 1.5 },
  meta: { margin: '4px 0 0', fontSize: 12, color: memberTheme.textMuted },
  // §8 puts the action at the card's trailing edge, and §9 forbids horizontal
  // scrolling — so it wraps onto its own line on a narrow phone rather than
  // squeezing the price.
  action: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  // The Promotion block: separated from the Product's own lines by the app's
  // one divider colour, with no border, background or hue of its own.
  promotion: {
    display: 'flex', flexDirection: 'column', gap: 2,
    marginTop: 10, paddingTop: 10,
    borderTop: `1px solid ${memberTheme.separator}`,
  },
  promotionHeading: {
    fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
    textTransform: 'uppercase', color: memberTheme.textMuted,
  },
  promotionName: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
  promotionBenefit: { fontSize: 12.5, color: memberTheme.textSecondary },
  // §17: an obvious, reachable action — its own line, at the card's trailing
  // edge, wrapping rather than squeezing the sentence beside it.
  promotionAction: {
    display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 8,
  },
  emptyCard: { ...sectionCardStyle, borderRadius: 10, padding: '16px 14px' },
  empty: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
};
