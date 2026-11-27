'use client';

import type { CSSProperties } from 'react';
import { MemberCollapsibleCard } from './MemberCollapsibleCard';
import { MemberPlanCard, type MemberPlanCardItem } from './MemberPlanCatalogue';

/**
 * #3539 — **Past Plans and Products** (was #1122's *Past Membership Plans*): the
 * member's finished Membership Plans and the Products they no longer hold, in
 * one compact card that is collapsed by default.
 *
 * The entries are **one flat list inside that one card**: each row is My Plans'
 * own plan row (`MemberPlanCard`, #3293) drawn `flat` — no card, border or
 * nested frame of its own, a hairline between rows — with the `PLAN` / `PRODUCT`
 * label the page resolved. A plan still expands into the items and Promotions it
 * was agreed with; a Product has nothing more to show, so it does not expand.
 *
 * It decides nothing: every string arrives already resolved by the page over
 * `lib/memberPlans.ts`, so this file calls no `t()`, reads no row and spells no
 * colour of its own (#983). The outer card is the app's one collapsible chrome
 * (`MemberCollapsibleCard`), and the page renders it only for a member who has
 * a history.
 */
export function PastPlansAndProductsCard({ title, summary, items }: {
  title: string;
  /** How many entries the history holds (plans + Products), resolved by the page. */
  summary?: string | null;
  /** Flat rows built by the page, each with its type label, no image and no action. */
  items: MemberPlanCardItem[];
}) {
  return (
    <MemberCollapsibleCard title={title} summary={summary} bodyStyle={styles.body}>
      <ul style={styles.list} data-past-entries>
        {items.map((item) => <MemberPlanCard key={item.key} item={{ ...item, flat: true }} />)}
      </ul>
    </MemberCollapsibleCard>
  );
}

const styles: Record<string, CSSProperties> = {
  body: { padding: '0 16px 4px' },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' },
};
