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

/** One Product as the card draws it, with every string already resolved. */
export interface MemberProductCardItem {
  key: string;
  name: string;
  description?: string | null;
  /** The price, formatted; `null` renders `—`. */
  price: string | null;
  /** *Monthly*, *Yearly*: shown beside the price for a recurring item only. */
  frequency?: string | null;
  /** Whatever the page composed about the item — its package size, its tax. */
  meta?: string | null;
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
                  <span style={styles.price}>{item.price ?? '—'}</span>
                  {item.frequency && <span style={styles.frequency}>/ {item.frequency}</span>}
                </span>
              </div>
              {item.description && <p style={styles.description}>{item.description}</p>}
              {item.meta && <p style={styles.meta}>{item.meta}</p>}
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
  frequency: { fontSize: 12.5, color: memberTheme.textMuted },
  description: { margin: '6px 0 0', fontSize: 13, color: memberTheme.textSecondary, lineHeight: 1.5 },
  meta: { margin: '4px 0 0', fontSize: 12, color: memberTheme.textMuted },
  // §8 puts the action at the card's trailing edge, and §9 forbids horizontal
  // scrolling — so it wraps onto its own line on a narrow phone rather than
  // squeezing the price.
  action: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  emptyCard: { ...sectionCardStyle, borderRadius: 10, padding: '16px 14px' },
  empty: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
};
