'use client';

import { type CSSProperties } from 'react';
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
export interface PastMembershipPlanItem {
  key: string;
  name: string;
  /** What became of it and when — `Cancelled · 12 September 2026`. */
  meta: string;
}

export function PastMembershipPlansCard({ title, summary, items }: {
  title: string;
  /** How many plans the history holds, resolved by the page. */
  summary?: string | null;
  items: PastMembershipPlanItem[];
}) {
  return (
    <MemberCollapsibleCard title={title} summary={summary} bodyStyle={styles.body}>
      <ul style={styles.list}>
        {items.map((item) => (
          <li key={item.key} style={styles.item}>
            <span style={styles.name}>{item.name}</span>
            <span style={styles.meta}>{item.meta}</span>
          </li>
        ))}
      </ul>
    </MemberCollapsibleCard>
  );
}

const styles: Record<string, CSSProperties> = {
  body: { padding: '0 16px 12px' },
  list: { ...rowDividerStyle, listStyle: 'none', margin: 0, padding: '10px 0 0' },
  item: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0' },
  name: { fontSize: 14, fontWeight: 600, color: memberTheme.text },
  meta: { fontSize: 12.5, color: memberTheme.textMuted },
};
