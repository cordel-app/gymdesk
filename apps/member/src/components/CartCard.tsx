'use client';

// #2895 — the one cart renderer. Home and My Products both draw the member's
// cart through this component, so the structure, the styling and the content
// cannot drift apart: the page supplies already-decided values and, where it
// has actions to offer (My Products), fills the `actions`, `itemAction` and
// `footer` slots. It decides nothing, prices nothing and calls no endpoint;
// every colour is `memberChrome.ts`'s.
import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  cartHeadingStyle,
  cartMutedStyle,
  cartSummaryStyle,
  cartTotalStyle,
} from '@/lib/memberChrome';

export interface CartCardItem {
  key: string;
  /** `plan` or `product`: the label before the name. */
  kind: 'plan' | 'product';
  name: string;
  /** Formatted amount, shown only where the item carries one. */
  amount?: string | null;
}

export interface CartCardProps {
  /** Full translation key of the heading. */
  headingKey: string;
  counts: string;
  total?: string | null;
  items: CartCardItem[];
  /** Full translation keys of the explanatory lines under the total. */
  hintKeys?: string[];
  /** A cart staff are still editing: says so (#2895). */
  staffEditing?: boolean;
  /** Extra lines (countdown, …) under the hints. */
  extra?: ReactNode;
  /** Rendered between the lines and the items (the Summary). */
  summary?: ReactNode;
  /** Buttons at the top right (Pay, Cancel). */
  actions?: ReactNode;
  /** A control at the end of an item's row (its own Cancel). */
  itemAction?: (item: CartCardItem) => ReactNode;
  /** Below the items: the Add buttons and the error line. */
  footer?: ReactNode;
  dataAttrs?: Record<string, boolean>;
}

const top: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 };
const info: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 };
const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' };
const list: CSSProperties = { listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 };
const row: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };

export function CartCard(p: CartCardProps) {
  const t = useTranslations();
  return (
    <div style={cartSummaryStyle} data-cart-card {...p.dataAttrs}>
      <div style={top}>
        <div style={info}>
          <h2 style={cartHeadingStyle}>{t(p.headingKey as any)}</h2>
          <span style={cartMutedStyle}>{p.counts}</span>
          {p.total && <span style={cartTotalStyle} data-cart-total>{p.total}</span>}
          {p.staffEditing && <span style={cartMutedStyle} data-cart-staff-editing>{t('membership.cart_staff_editing')}</span>}
          {(p.hintKeys ?? []).map((k) => <span key={k} style={cartMutedStyle}>{t(k as any)}</span>)}
          {p.extra}
        </div>
        {p.actions && <div style={actionsStyle}>{p.actions}</div>}
      </div>
      {p.summary && <div style={{ marginTop: 10 }}>{p.summary}</div>}
      <ul style={list}>
        {p.items.map((item) => (
          <li key={item.key} style={row}>
            <span style={cartMutedStyle}>{t(item.kind === 'plan' ? 'membership.cart_kind_plan' : 'membership.cart_kind_product')}</span>
            <span style={{ fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' }}>{item.name}</span>
            {item.amount && <span style={cartMutedStyle}>· {item.amount}</span>}
            {p.itemAction && <span style={{ marginLeft: 'auto' }}>{p.itemAction(item)}</span>}
          </li>
        ))}
      </ul>
      {p.footer}
    </div>
  );
}

/** The page's items as the card draws them: a purchase carries its formatted amount. */
export function toCartCardItems(
  items: Array<{ key: string; kind: 'plan' | 'purchase'; name: string; amount?: number | null; currency?: string | null }>,
  money: (amount: number | null | undefined, currency?: string | null) => string | null,
): CartCardItem[] {
  return items.map((i) => ({
    key: i.key,
    kind: i.kind === 'plan' ? 'plan' : 'product',
    name: i.name,
    amount: i.kind === 'purchase' ? money(i.amount, i.currency) : null,
  }));
}
