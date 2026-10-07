'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { memberTheme, rowDividerStyle, sectionCardStyle } from '@/lib/memberChrome';
import { MemberCollapsibleCard } from './MemberCollapsibleCard';

/**
 * #1123 — the look of the Members App's **Payments** card: the collapsible card
 * itself (§1), the three subcards inside it (§2/§4/§5) and the one Billing Event
 * card both the past and the forecast subcards list.
 *
 * It is this ticket's `NutritionItemRow` (#932): one place owns the chrome, so
 * the three subcards cannot drift into three looks, and it **resolves nothing** —
 * every label arrives already translated and every amount already formatted by
 * `lib/memberPayments.ts`, so this file calls no `t()`, reads no row and spells
 * no colour of its own (#983: a Members App visual value is spelled in exactly
 * one place, `memberChrome.ts`).
 *
 * Four of its answers are the rule rather than the implementation.
 *
 *  - **Expanding fetches nothing.** The page loads the ledger and the forecast
 *    with the rest of the screen, so opening a card is presentation and nothing
 *    else — #955's rule for the Admin's own collapsible billing periods, and
 *    #1115's for a member's goal cards.
 *  - **One Billing Event card serves both subcards.** §4 and §5 both ask for
 *    "the same Billing Event card structure", so a past event and a forecast one
 *    differ in what the page puts *in* the card (a status pill, a receipt link)
 *    and never in the card.
 *  - **The header is one button.** Its accessible name is the subcard's title and
 *    its state is `aria-expanded`, so the caret is decoration (`aria-hidden`) —
 *    the same shape `GoalReadings`' history toggle has.
 *  - **Nothing is laid out in a row that cannot wrap.** §7 forbids horizontal
 *    scrolling, so a card's date and total, and a line's name and price, are
 *    `flexWrap` pairs rather than a grid with a minimum width.
 */

/** One item of one Billing Event card, with every string already resolved. */
export interface BillingEventCardLine {
  key: string;
  /** What the item is — *Membership Plan*, *Product* — above its own name. */
  heading?: string | null;
  name: string;
  /** Quantity, treatment, notes: whatever the page composed for this line. */
  meta?: string | null;
  /** The amount actually charged, formatted; `null` renders `—`. */
  amount: string | null;
  /** The regular price, shown only where the page decided it differs. */
  regularAmount?: string | null;
  /** A status pill, a receipt button — the page's, because only it has them. */
  trailing?: ReactNode;
}

/**
 * The outer **Payments** card (§1): collapsed by default, with the three
 * subcards appearing underneath when it is opened.
 *
 * Since #1122 the card itself is `MemberCollapsibleCard` — the same chrome the
 * Past Membership Plans card wears — so this is only what Payments puts inside
 * one. A second collapsible card of its own is what that promotion removed.
 */
export function PaymentsCard({ title, summary, children }: {
  title: string;
  /** A one-line hint beside the title — the next payment, when there is one. */
  summary?: string | null;
  children: ReactNode;
}) {
  return (
    <MemberCollapsibleCard title={title} summary={summary} bodyStyle={styles.subcards}>
      {children}
    </MemberCollapsibleCard>
  );
}

/**
 * One of the three subcards. `defaultOpen` is §6's table in one prop — Next
 * Payment opens, the other two stay closed — and it is the *initial* state only,
 * so a member who opened Past Billing Events keeps it open while they read it.
 */
export function PaymentsSubcard({ title, summary, defaultOpen = false, children }: {
  title: string;
  summary?: string | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={styles.subcard}>
      <button type="button" onClick={() => setOpen((prev) => !prev)} aria-expanded={open} style={styles.subcardToggle}>
        <span style={styles.subcardTitle}>{title}</span>
        <span style={styles.toggleRight}>
          {summary && <span style={styles.summary}>{summary}</span>}
          <span style={styles.caret} aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && <div style={styles.subcardBody}>{children}</div>}
    </div>
  );
}

/**
 * One Billing Event: the date it falls on, what it costs, and the items that
 * make up that total — §4's and §5's card, and the breakdown §2/§3 ask Next
 * Payment for.
 *
 * `prominent` is Next Payment's own emphasis (§2: "the payment date and total
 * amount should be the most visually prominent information"). It changes two
 * type sizes and nothing else: the card is still the same card, so the three
 * subcards remain one structure.
 */
export function BillingEventCard({
  date, total, totalLabel, lines, badge, prominent = false, footer,
}: {
  date: string;
  total: string | null;
  totalLabel: string;
  lines: BillingEventCardLine[];
  /** A pill the page supplies: a status for a past event, *Forecast* for a projection. */
  badge?: ReactNode;
  prominent?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div style={styles.eventCard}>
      <div style={styles.eventHead}>
        <span style={prominent ? styles.eventDateLarge : styles.eventDate}>{date}</span>
        {badge}
      </div>
      <div style={styles.eventTotalRow}>
        <span style={styles.totalLabel}>{totalLabel}</span>
        <span style={prominent ? styles.eventTotalLarge : styles.eventTotal}>{total ?? '—'}</span>
      </div>
      {lines.length > 0 && (
        <ul style={styles.lineList}>
          {lines.map((line) => (
            <li key={line.key} style={styles.lineItem}>
              <div style={styles.lineMain}>
                {line.heading && <span style={styles.lineHeading}>{line.heading}</span>}
                <span style={styles.lineName}>{line.name}</span>
                {line.meta && <span style={styles.lineMeta}>{line.meta}</span>}
                {line.trailing && <span style={styles.lineTrailing}>{line.trailing}</span>}
              </div>
              <div style={styles.lineAmounts}>
                {line.regularAmount && <span style={styles.lineRegular}>{line.regularAmount}</span>}
                <span style={styles.lineAmount}>{line.amount ?? '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {footer && <div style={styles.eventFooter}>{footer}</div>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  toggleRight: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  summary: { fontSize: 12.5, color: memberTheme.textMuted },
  caret: { fontSize: 12, color: memberTheme.textMuted },
  subcards: { display: 'flex', flexDirection: 'column', gap: 10, padding: '0 12px 12px' },
  subcard: { ...sectionCardStyle, borderRadius: 10 },
  subcardToggle: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    width: '100%', padding: '11px 12px', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left', font: 'inherit',
  },
  subcardTitle: { fontSize: 13.5, fontWeight: 600, color: memberTheme.title3, fontFamily: memberTheme.title3Font },
  subcardBody: {
    ...rowDividerStyle,
    display: 'flex', flexDirection: 'column', gap: 10, padding: '12px',
  },
  eventCard: { ...sectionCardStyle, borderRadius: 10, padding: '12px 14px' },
  eventHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, flexWrap: 'wrap',
  },
  eventDate: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
  eventDateLarge: { fontSize: 17, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  eventTotalRow: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 8, flexWrap: 'wrap', marginTop: 4,
  },
  totalLabel: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: memberTheme.textMuted },
  eventTotal: { fontSize: 14.5, fontWeight: 700, color: memberTheme.text },
  eventTotalLarge: { fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  lineList: { ...rowDividerStyle, listStyle: 'none', margin: '10px 0 0', padding: '10px 0 0' },
  lineItem: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 10, flexWrap: 'wrap', padding: '5px 0',
  },
  lineMain: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 60%' },
  lineHeading: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: memberTheme.textMuted },
  lineName: { fontSize: 13.5, color: memberTheme.text },
  lineMeta: { fontSize: 12, color: memberTheme.textMuted },
  lineTrailing: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 },
  lineAmounts: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  lineRegular: { fontSize: 12, color: memberTheme.textMuted, textDecoration: 'line-through' },
  lineAmount: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
  eventFooter: { ...rowDividerStyle, marginTop: 10, paddingTop: 8, fontSize: 12, color: memberTheme.textMuted },
};
