'use client';

import type { CSSProperties } from 'react';
import { MemberCollapsibleCard } from './MemberCollapsibleCard';
import { MemberPlanCard, type MemberPlanCardItem } from './MemberPlanCatalogue';

/**
 * #1122 §7/§8 — **Past Membership Plans**: the member's finished plans, in a
 * compact card that is collapsed by default and occupies the minimum vertical
 * space while it is.
 *
 * Since #3293 every past plan is drawn with **My Plans' own plan card**
 * (`MemberPlanCard`): the same collapsed header (name, status pill, agreed fee
 * and cadence, plan period) and the same expanded one-time / recurring item
 * groups, so a past plan is the same component as an active one. The page
 * builds the items and passes no picture, which `MemberPlanCard` answers by
 * drawing no image column at all — no empty space, nothing shifted.
 *
 * It decides nothing: every string arrives already resolved by the page over
 * `lib/memberPlans.ts`, so this file calls no `t()`, reads no row and spells no
 * colour of its own (#983). The outer card is the app's one collapsible chrome
 * (`MemberCollapsibleCard`), and the page renders it only for a member who has
 * a history — a collapsed card that opens onto nothing is vertical space spent
 * saying nothing.
 */
export function PastMembershipPlansCard({ title, summary, items }: {
  title: string;
  /** How many plans the history holds, resolved by the page. */
  summary?: string | null;
  /** My Plans' card items, built by the page with no image and no action. */
  items: MemberPlanCardItem[];
}) {
  return (
    <MemberCollapsibleCard title={title} summary={summary} bodyStyle={styles.body}>
      <ul style={styles.list} data-past-plans>
        {items.map((item) => <MemberPlanCard key={item.key} item={item} />)}
      </ul>
    </MemberCollapsibleCard>
  );
}

const styles: Record<string, CSSProperties> = {
  body: { padding: '0 16px 12px' },
  list: { listStyle: 'none', padding: '10px 0 0', margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
};
