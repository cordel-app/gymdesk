'use client';

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { memberTheme, rowDividerStyle, sectionCardStyle, statusPillStyle } from '@/lib/memberChrome';

/**
 * #1123 — the look of the Members App's **Payments** section: the section
 * itself (the My Products tab since #2740), the three subcards inside it
 * (since #3297: Next Payment, Planned Payments, Past Payments), the prominent
 * card Next Payment draws and the row every payment list draws.
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
 *  - **Nothing scrolls sideways.** §7 forbids horizontal scrolling, so a card's
 *    date and total are a `flexWrap` pair, and a line item (#3242) keeps its
 *    chip and amount on its row by truncating the name between them rather
 *    than wrapping it under the price.
 */

/** One item of one Billing Event card, with every string already resolved. */
export interface BillingEventCardLine {
  key: string;
  /** What the item is — *Membership Plan*, *Product* — drawn as a chip before its name (#3242). */
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
 * The **Payments** tab of My Products (#2740): the three subcards laid out
 * directly in the tab, with no outer card around them. Until #2740 they sat
 * inside a collapsed `MemberCollapsibleCard` on the Plans & Products tab; the
 * tab is now the section, so a card that had to be opened before anything
 * showed would be a second step for nothing.
 */
export function PaymentsSection({ children }: { children: ReactNode }) {
  return <div style={styles.subcards}>{children}</div>;
}

/**
 * One of the three subcards. `defaultOpen` is §6's table in one prop — Next
 * Payment opens, the other two stay closed — and it is the *initial* state only,
 * so a member who opened Past Billing Events keeps it open while they read it.
 */
export function PaymentsSubcard({ title, summary, defaultOpen = false, forceOpen = false, children }: {
  title: string;
  summary?: string | null;
  defaultOpen?: boolean;
  /** #3235 — *View payment* opened this subcard to reach one of its payments. */
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
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
  title, date, total, totalLabel, lines, badge, prominent = false, documents, details, footer, anchorId, highlighted = false,
}: {
  /** #3299 — the payment's own name (a past payment's), above its date. */
  title?: string | null;
  /** #3299 — the payment's own documents, inside the payment they belong to (#3297). */
  documents?: ReactNode;
  /** #3299 — payment method and notes, under the lines and documents. */
  details?: ReactNode;
  /** #3235 — the DOM id *View payment* scrolls to. */
  anchorId?: string;
  /** #3235 — the payment *View payment* opened, outlined so the member finds it. */
  highlighted?: boolean;
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
    <div id={anchorId} style={highlighted ? { ...styles.eventCard, ...styles.eventCardHighlighted } : styles.eventCard}>
      {title && <div style={styles.eventTitle} title={title}>{title}</div>}
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
              <BillingEventLineRow line={line} />
            </li>
          ))}
        </ul>
      )}
      {documents && <div style={styles.eventDocuments}>{documents}</div>}
      {details && <div style={styles.eventDetails}>{details}</div>}
      {footer && <div style={styles.eventFooter}>{footer}</div>}
    </div>
  );
}

/** #3299 — several pills (status, payment type, refund type) as one card badge. */
export function BillingEventBadges({ children }: { children: ReactNode }) {
  return <span style={styles.eventBadges}>{children}</span>;
}

/**
 * #2937 — one **past** Billing Event: a compact header (at most two lines:
 * title and amount, then the issued date and the status) that expands into the
 * event's own lines and its payment details.
 *
 * It is one container and nothing is nested in it: the lines are rows of that
 * container separated by hairlines, never cards of their own, and nothing here
 * wears the Section Card border (whose themed edge is what drew a coloured bar
 * beside every line). Each row keeps its own open state, so opening one never
 * moves another, and opening fetches nothing (#955). The header is one button
 * whose state is `aria-expanded`; a row with nothing to show has no button.
 */
export function PastBillingEventRow({
  title, date, status, chips, amount, lines, documents, details, expandable = true, anchorId, highlighted = false,
}: {
  title: string;
  date: string;
  /** The status pill, rendered by the page from the server's status. */
  status: ReactNode;
  /** #3297 — the payment-type and refund-type chips, beside the status. */
  chips?: ReactNode;
  amount: string | null;
  lines: BillingEventCardLine[];
  /** #3297 — the payment's own documents, inside the payment they belong to. */
  documents?: ReactNode;
  /** Payment method and notes, under the lines. */
  details?: ReactNode;
  expandable?: boolean;
  /** #3235/#3297 — the DOM id *View payment* scrolls to. */
  anchorId?: string;
  /** #3235/#3297 — the payment *View payment* opened, outlined so the member finds it. */
  highlighted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const header = (
    <>
      <span style={styles.pastRow1}>
        <span style={styles.pastTitle}>{title}</span>
        <span style={styles.pastAmount}>{amount ?? '—'}</span>
      </span>
      <span style={styles.pastRow2}>
        <span style={styles.pastDate}>{date}</span>
        {status}
        {chips}
        {expandable && <span style={styles.pastCaret} aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </span>
    </>
  );
  return (
    <div id={anchorId} style={highlighted ? { ...styles.pastEvent, ...styles.eventCardHighlighted } : styles.pastEvent}>
      {expandable ? (
        <button type="button" onClick={() => setOpen((prev) => !prev)} aria-expanded={open} style={styles.pastHeader}>
          {header}
        </button>
      ) : (
        <div style={styles.pastHeader}>{header}</div>
      )}
      {expandable && open && (
        <div style={styles.pastBody}>
          {lines.length > 0 && (
            <ul style={styles.pastLineList}>
              {lines.map((line, index) => (
                <li key={line.key} style={index === 0 ? styles.pastLine : { ...styles.pastLine, ...rowDividerStyle }}>
                  <BillingEventLineRow line={line} />
                </li>
              ))}
            </ul>
          )}
          {documents && <div style={lines.length > 0 ? { ...styles.pastDocuments, ...rowDividerStyle } : styles.pastDocuments}>{documents}</div>}
          {details && <div style={lines.length > 0 || documents ? { ...styles.pastDetails, ...rowDividerStyle } : styles.pastDetails}>{details}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * #3242 — one line item of a Billing Event, one row per item in a vertical
 * list. The first row is the item's kind as a compact chip (*Membership Plan*,
 * *Product*), its name and its amount; the name truncates rather than wrapping
 * so the amount stays on the row beside it. Quantity, Promotion and the regular
 * price sit on a second, muted row under it.
 */
function BillingEventLineRow({ line }: { line: BillingEventCardLine }) {
  return (
    <div style={styles.lineRow}>
      <div style={styles.lineTop}>
        {line.heading && <span style={styles.lineChip}>{line.heading}</span>}
        <span style={styles.lineName} title={line.name}>{line.name}</span>
        <span style={styles.lineAmount}>{line.amount ?? '—'}</span>
      </div>
      {(line.meta || line.regularAmount) && (
        <div style={styles.lineSub}>
          <span style={styles.lineMeta}>{line.meta ?? ''}</span>
          {line.regularAmount && <span style={styles.lineRegular}>{line.regularAmount}</span>}
        </div>
      )}
      {line.trailing && <span style={styles.lineTrailing}>{line.trailing}</span>}
    </div>
  );
}

/** #3242 — one downloadable document, every string already resolved by the page. */
export interface PaymentDocumentListRow {
  key: string;
  date: string;
  /** The document type (*Receipt*, *Simplified invoice*, …), drawn as a chip. */
  type: string;
  identifier: string;
  /** The download action's accessible name, naming the document. */
  downloadLabel: string;
  downloading?: boolean;
}

/**
 * #3242 — a list of stored documents: date, type chip, identifier and a
 * download action on the right. Since #3297 it is drawn inside the payment the
 * documents belong to, never as a section of its own.
 * Each row is one block: when it does not fit on one line (a *Simplified
 * invoice* on a phone) the date and chip take the first line and the
 * identifier and the download action the second, so the action never drifts
 * away from the document it downloads. Rows for missing documents never reach
 * this component: the page lists only what the API offered.
 */
export function PaymentDocumentList({ rows, onDownload }: {
  rows: PaymentDocumentListRow[];
  onDownload: (key: string) => void;
}) {
  return (
    <ul style={styles.docList}>
      {rows.map((row, index) => (
        <li key={row.key} style={index === 0 ? styles.docRow : { ...styles.docRow, ...rowDividerStyle }}>
          <span style={styles.docLead}>
            <span style={styles.docDate}>{row.date}</span>
            <span style={styles.lineChip}>{row.type}</span>
          </span>
          <span style={styles.docTail}>
            <span style={styles.docId} title={row.identifier}>{row.identifier}</span>
            <button
              type="button"
              onClick={() => onDownload(row.key)}
              disabled={row.downloading}
              aria-label={row.downloadLabel}
              title={row.downloadLabel}
              style={row.downloading ? { ...styles.docDownload, ...styles.docDownloadBusy } : styles.docDownload}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M12 4v11" />
                <path d="M7 10l5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

const styles: Record<string, CSSProperties> = {
  toggleRight: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  summary: { fontSize: 12.5, color: memberTheme.textMuted },
  caret: { fontSize: 12, color: memberTheme.textMuted },
  subcards: { display: 'flex', flexDirection: 'column', gap: 10 },
  subcard: { ...sectionCardStyle },
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
  eventCard: { padding: '0' },
  eventCardHighlighted: { outline: `2px solid ${memberTheme.primaryButton}`, outlineOffset: 2 },
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
  lineItem: { display: 'flex', padding: '5px 0' },
  // #3242 — a line item: chip, name (truncated) and amount on one row.
  lineRow: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', minWidth: 0 },
  lineTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  lineChip: { ...statusPillStyle('neutral'), padding: '2px 8px', fontSize: 11, flexShrink: 0 },
  lineName: {
    fontSize: 13.5, color: memberTheme.text, flex: '1 1 auto', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  lineSub: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  lineMeta: { fontSize: 12, color: memberTheme.textMuted, minWidth: 0 },
  lineTrailing: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 },
  lineRegular: { fontSize: 12, color: memberTheme.textMuted, textDecoration: 'line-through', whiteSpace: 'nowrap' },
  lineAmount: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text, whiteSpace: 'nowrap', flexShrink: 0 },
  // #3242 — the Documents section.
  docList: { listStyle: 'none', margin: 0, padding: 0 },
  docRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '4px 10px', flexWrap: 'wrap', padding: '8px 0',
  },
  docLead: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  docDate: { fontSize: 12.5, color: memberTheme.textMuted, whiteSpace: 'nowrap' },
  docTail: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', minWidth: 0, maxWidth: '100%' },
  docId: {
    fontSize: 13, fontWeight: 600, color: memberTheme.text, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  docDownload: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: 32, height: 32, borderRadius: 8, border: `1px solid ${memberTheme.separator}`,
    background: memberTheme.surface, color: memberTheme.link, cursor: 'pointer', padding: 0,
  },
  docDownloadBusy: { opacity: 0.5, cursor: 'progress' },
  // #2937 — a past event's row. One hairline-bordered container in the
  // separator colour, never `sectionCardStyle` (whose themed edges repeated a
  // coloured bar on every nested card).
  pastEvent: { overflow: 'hidden' },
  pastHeader: {
    display: 'flex', flexDirection: 'column', gap: 3, width: '100%', padding: '9px 12px',
    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit',
  },
  pastRow1: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, minWidth: 0 },
  pastTitle: {
    fontSize: 13.5, fontWeight: 600, color: memberTheme.text, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  pastAmount: { fontSize: 14, fontWeight: 700, color: memberTheme.text, whiteSpace: 'nowrap' },
  pastRow2: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12, flexWrap: 'wrap' },
  pastDate: { fontSize: 12, color: memberTheme.textMuted, whiteSpace: 'nowrap' },
  pastCaret: { marginLeft: 'auto', fontSize: 12, color: memberTheme.textMuted },
  pastBody: { ...rowDividerStyle, padding: '4px 12px 10px' },
  pastLineList: { listStyle: 'none', margin: 0, padding: 0 },
  pastLine: { display: 'flex', padding: '7px 0' },
  pastDocuments: { paddingTop: 4 },
  pastDetails: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 8, fontSize: 12, color: memberTheme.textMuted },
  // #3299 — a past payment's name, documents and details on the detailed card.
  eventTitle: {
    fontSize: 13.5, fontWeight: 600, color: memberTheme.text, marginBottom: 2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  eventBadges: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  eventDocuments: { ...rowDividerStyle, marginTop: 10, paddingTop: 2 },
  eventDetails: {
    ...rowDividerStyle, marginTop: 10, paddingTop: 8,
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: memberTheme.textMuted,
  },
  eventFooter: { ...rowDividerStyle, marginTop: 10, paddingTop: 8, fontSize: 12, color: memberTheme.textMuted },
};
