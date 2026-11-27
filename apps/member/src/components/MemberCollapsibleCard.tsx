'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';

/**
 * The Members App's one **collapsible section card**: a Section Card whose whole
 * header is the toggle, with a title, an optional one-line summary beside it and
 * a caret.
 *
 * It was #1123's Payments card, and #1122 §7 asks for the same thing again for
 * Past Membership Plans — so it is promoted here rather than copied, the way the
 * Admin's `Tabs` was promoted out of the Nutrition Library's own strip (#961).
 * A second card chrome or a second expand affordance in this app is the thing
 * that rule exists to prevent (#1115).
 *
 * Three of its answers are the rule rather than the implementation.
 *
 *  - **It resolves nothing.** The title and the summary arrive already
 *    translated and already formatted, so this file calls no `t()`, reads no row
 *    and spells no colour of its own (#983: a Members App visual value is
 *    spelled in exactly one place, `memberChrome.ts`).
 *  - **The header is one button.** Its accessible name is the card's title and
 *    its state is `aria-expanded`, so the caret is decoration (`aria-hidden`) —
 *    the shape `GoalReadings`' history toggle and `MemberGoalCard` already have.
 *  - **Expanding fetches nothing.** The page loads what a card holds with the
 *    rest of the screen, so opening one is presentation and nothing else
 *    (#955's rule for the Admin's collapsible billing periods, #1115's for a
 *    member's goal cards).
 */
export function MemberCollapsibleCard({
  title, summary, subtitle, center, amount, defaultOpen = false, bodyStyle, cardStyle, children,
}: {
  title: string;
  /** A one-line hint beside the title — the next payment, how many past plans. */
  summary?: string | null;
  /** #3495: a second line under the title (a date). */
  subtitle?: string | null;
  /**
   * #3495: content centred in the header row (a status chip). With it, the header is three columns —
   * title left, this centred, the summary / amount and caret right.
   */
  center?: ReactNode;
  /** #3495: a prominent figure at the right of the header, before the caret (an amount). */
  amount?: string | null;
  /** The *initial* state only, so a member reading an open card keeps it open. */
  defaultOpen?: boolean;
  /** What the body is laid out as, which is the caller's and not the chrome's. */
  bodyStyle?: CSSProperties;
  /** Extra card chrome from the caller — e.g. #1224's exercise image behind the header. */
  cardStyle?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={cardStyle ? { ...styles.card, ...cardStyle } : styles.card}>
      <button type="button" onClick={() => setOpen((prev) => !prev)} aria-expanded={open}
        style={center != null ? styles.toggleCentered : styles.toggle}>
        <span style={styles.heading}>
          <span style={styles.title}>{title}</span>
          {subtitle && <span style={styles.subtitle}>{subtitle}</span>}
        </span>
        {center != null && <span style={styles.center}>{center}</span>}
        <span style={styles.right}>
          {summary && <span style={styles.summary}>{summary}</span>}
          {amount && <span style={styles.amount}>{amount}</span>}
          <span style={styles.caret} aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && <div style={bodyStyle}>{children}</div>}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  card: { ...sectionCardStyle, marginTop: 16, overflow: 'hidden' },
  toggle: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    width: '100%', padding: '14px 16px', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left', font: 'inherit',
  },
  toggleCentered: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: 12,
    width: '100%', padding: '14px 16px', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left', font: 'inherit',
  },
  heading: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  subtitle: { fontSize: 12, color: memberTheme.textMuted },
  center: { justifySelf: 'center' },
  amount: { fontSize: 18, fontWeight: 700, color: memberTheme.text, whiteSpace: 'nowrap' },
  title: { fontSize: 15, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  summary: { fontSize: 12.5, color: memberTheme.textMuted },
  caret: { fontSize: 12, color: memberTheme.textMuted },
};
