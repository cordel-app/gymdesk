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
  title, summary, defaultOpen = false, bodyStyle, children,
}: {
  title: string;
  /** A one-line hint beside the title — the next payment, how many past plans. */
  summary?: string | null;
  /** The *initial* state only, so a member reading an open card keeps it open. */
  defaultOpen?: boolean;
  /** What the body is laid out as, which is the caller's and not the chrome's. */
  bodyStyle?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={styles.card}>
      <button type="button" onClick={() => setOpen((prev) => !prev)} aria-expanded={open} style={styles.toggle}>
        <span style={styles.title}>{title}</span>
        <span style={styles.right}>
          {summary && <span style={styles.summary}>{summary}</span>}
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
  title: { fontSize: 15, fontWeight: 700, color: memberTheme.title2 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  summary: { fontSize: 12.5, color: memberTheme.textMuted },
  caret: { fontSize: 12, color: memberTheme.textMuted },
};
