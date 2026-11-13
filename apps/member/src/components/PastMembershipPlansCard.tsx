'use client';

import { type CSSProperties, useState } from 'react';
import { memberTheme, rowDividerStyle } from '@/lib/memberChrome';
import { MemberCollapsibleCard } from './MemberCollapsibleCard';

/**
 * #1122 §7/§8 — **Past Membership Plans**: the member's finished plans, in a
 * compact card that is collapsed by default and occupies the minimum vertical
 * space while it is.
 *
 * It draws and decides nothing: every string arrives already resolved by the
 * page over `lib/memberPlans.ts`, so this file calls no `t()`, reads no row and
 * spells no colour of its own (#983). The card itself is the app's one
 * collapsible chrome (`MemberCollapsibleCard`), shared with the Payments card
 * (#1123), so the two cannot drift into two looks.
 *
 * Two of its answers are the rule rather than the implementation.
 *
 *  - **A past plan carries no action and no status pill** (§8: it must not
 *    compete with the current plan, and it must not show an active plan's
 *    actions). What happened to it is a muted line under its name — the pill is
 *    the current plan's emphasis, and repeating it here is exactly the
 *    competition §8 rules out.
 *  - **A card with nothing in it is absent**, which is why the page renders this
 *    only for a member who has a history: a collapsed card that opens onto *You
 *    have no past plans* is vertical space spent saying nothing (#1073's "a
 *    control that cannot work is absent, never broken", one surface over).
 */
/** One line of an expanded past plan: a name and its facts, already worded. */
export interface PastPlanDetailRow {
  key: string;
  name: string;
  facts: string;
}

/** One Promotion applied to the plan, as the page worded it. */
export interface PastPlanPromotionItem {
  key: string;
  name: string;
  /** `Revoked · 3 March 2026`, or `null` for one that stood. */
  note: string | null;
  facts: string | null;
  products: PastPlanDetailRow[];
}

/** #2779: what a past plan expands into, every string resolved by the page. */
export interface PastPlanExpanded {
  fee: { label: string; value: string } | null;
  linesHeading: string;
  lines: PastPlanDetailRow[];
  promotionsHeading: string;
  promotions: PastPlanPromotionItem[];
}

export interface PastMembershipPlanItem {
  key: string;
  name: string;
  /** #2779: `1 March 2026 – 31 August 2026`, visible without expanding. */
  period: string | null;
  /** What became of it — `Cancelled`. */
  meta: string;
  /** `null` for a plan with nothing recorded to expand into: no caret, no button. */
  details: PastPlanExpanded | null;
}

export function PastMembershipPlansCard({ title, summary, items }: {
  title: string;
  /** How many plans the history holds, resolved by the page. */
  summary?: string | null;
  items: PastMembershipPlanItem[];
}) {
  // #2779 §2: each plan opens and closes on its own, all closed to begin with;
  // expanding fetches nothing (#955) — the details came with the page.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <MemberCollapsibleCard title={title} summary={summary} bodyStyle={styles.body}>
      <ul style={styles.list}>
        {items.map((item) => {
          const isOpen = open.has(item.key);
          const header = (
            <>
              <span style={styles.headText}>
                <span style={styles.name}>{item.name}</span>
                {item.period && <span style={styles.period}>{item.period}</span>}
                <span style={styles.meta}>{item.meta}</span>
              </span>
              {item.details && <span style={styles.caret} aria-hidden="true">{isOpen ? '▾' : '▸'}</span>}
            </>
          );
          return (
            <li key={item.key} style={styles.item}>
              {item.details ? (
                <button type="button" onClick={() => toggle(item.key)} aria-expanded={isOpen} style={styles.head}>
                  {header}
                </button>
              ) : (
                <div style={styles.headStatic}>{header}</div>
              )}
              {item.details && isOpen && <PastPlanBody details={item.details} />}
            </li>
          );
        })}
      </ul>
    </MemberCollapsibleCard>
  );
}

function PastPlanBody({ details }: { details: PastPlanExpanded }) {
  return (
    <div style={styles.details}>
      {details.fee && (
        <div style={styles.feeRow}>
          <span style={styles.rowName}>{details.fee.label}</span>
          <span style={styles.rowName}>{details.fee.value}</span>
        </div>
      )}
      {details.lines.length > 0 && (
        <div>
          <div style={styles.subheading}>{details.linesHeading}</div>
          <ul style={styles.subList}>
            {details.lines.map((line) => (
              <li key={line.key} style={styles.subItem}>
                <span style={styles.rowName}>{line.name}</span>
                <span style={styles.meta}>{line.facts}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {details.promotions.length > 0 && (
        <div>
          <div style={styles.subheading}>{details.promotionsHeading}</div>
          <ul style={styles.subList}>
            {details.promotions.map((promo) => (
              <li key={promo.key} style={styles.subItem}>
                <span style={styles.rowName}>{promo.name}</span>
                {promo.note && <span style={styles.meta}>{promo.note}</span>}
                {promo.facts && <span style={styles.meta}>{promo.facts}</span>}
                {promo.products.map((g) => (
                  <span key={g.key} style={styles.meta}>{g.name} · {g.facts}</span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  body: { padding: '0 16px 12px' },
  list: { ...rowDividerStyle, listStyle: 'none', margin: 0, padding: '10px 0 0' },
  item: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0' },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer',
    textAlign: 'left', font: 'inherit', color: 'inherit',
  },
  headStatic: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  name: { fontSize: 14, fontWeight: 600, color: memberTheme.text },
  period: { fontSize: 12.5, color: memberTheme.textSecondary },
  meta: { fontSize: 12.5, color: memberTheme.textMuted },
  caret: { fontSize: 12, color: memberTheme.textMuted },
  details: { display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0 4px 12px' },
  feeRow: { display: 'flex', justifyContent: 'space-between', gap: 12 },
  subheading: { fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: memberTheme.textMuted, marginBottom: 4 },
  subList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  subItem: { display: 'flex', flexDirection: 'column', gap: 1 },
  rowName: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
};
