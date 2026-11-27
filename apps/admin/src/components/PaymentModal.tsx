'use client';

// #3498 — the one payment modal Save & Pay (Review your changes) and a Billing
// Event's Pay now both render. It is presentational: the title on the left, the
// amount being collected large at the top right (`0 €` when nothing is owed),
// the items being paid listed under one heading, then each flow's own content
// (Save & Pay's contracted / cancelled products and forecast, Pay now's
// checkout link) and the flow's own footer. It names no endpoint, decides no
// permission and computes no money — every figure is handed in by the flow.

import React, { type CSSProperties, type ReactNode } from 'react';
import { CrudModal } from './CrudModal';
import { cardHintStyle, cardSectionLabelStyle, formControlStyle } from './formChrome';
import { paymentItemLabel, paymentModalAmountLabel, type PaymentModalItem } from '@/lib/paymentModal';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

export function PaymentModal({
  title, amount, amountLabel, itemsLabel, items, error, saving, saveDisabled, hideSave,
  cancelLabel, saveLabel, onCancel, onSave, children,
}: {
  title: string;
  /** The authoritative amount of this action; `null` while unknown. */
  amount: number | string | null;
  /** Accessible name of the headline amount (e.g. "Amount to collect"). */
  amountLabel: string;
  itemsLabel: string;
  /** The items being paid, already drawn (a flow's own list, or `PaymentItemsTable`). */
  items: ReactNode;
  error?: string | null;
  saving?: boolean;
  saveDisabled?: boolean;
  hideSave?: boolean;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
  children?: ReactNode;
}) {
  const fmt = useGymFormatSettings();
  return (
    <CrudModal
      open
      title={title}
      headerAside={(
        <div data-payment-modal-amount aria-label={amountLabel} title={amountLabel} style={headlineAmount}>
          {paymentModalAmountLabel(amount, fmt)}
        </div>
      )}
      error={error}
      saving={saving}
      saveDisabled={saveDisabled}
      hideSave={hideSave}
      cancelLabel={cancelLabel}
      saveLabel={saveLabel}
      onCancel={onCancel}
      onSave={onSave}
    >
      <div data-payment-modal>
        <div style={cardSectionLabelStyle}>{itemsLabel}</div>
        <div data-payment-modal-items style={{ marginBottom: 14 }}>{items}</div>
        {children}
      </div>
    </CrudModal>
  );
}

/** The compact Item / Amount list of the items being paid, with its empty state. */
export function PaymentItemsTable({ items, itemHeader, amountHeader, emptyLabel }: {
  items: PaymentModalItem[];
  itemHeader: string;
  amountHeader: string;
  emptyLabel: string;
}) {
  const fmt = useGymFormatSettings();
  if (items.length === 0) return <p style={cardHintStyle} data-payment-items-empty>{emptyLabel}</p>;
  return (
    <table style={table}>
      <thead>
        <tr>
          <th style={th}>{itemHeader}</th>
          <th style={thNum}>{amountHeader}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.key} data-payment-item>
            <td style={tdItem}>{paymentItemLabel(it)}</td>
            <td style={tdNum}>{paymentModalAmountLabel(it.amount, fmt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface PaymentMethodOption { code: string; name: string; available: boolean; reason: string | null }

/** The payment-method selector both flows offer; the flow words an unavailable method. */
export function PaymentMethodSelect({ label, chooseLabel, methods, value, onChange, disabled, unavailableText, hint }: {
  label: string;
  chooseLabel: string;
  methods: PaymentMethodOption[];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  unavailableText: (m: PaymentMethodOption) => string;
  hint?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }} data-payment-method>
      <div style={cardSectionLabelStyle}>{label}</div>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...formControlStyle, maxWidth: 320 }}
      >
        <option value="">{chooseLabel}</option>
        {methods.map((m) => (
          <option key={m.code} value={m.code} disabled={!m.available} style={m.available ? undefined : { opacity: 0.5 }}>
            {m.name}{m.available ? '' : ` — ${unavailableText(m)}`}
          </option>
        ))}
      </select>
      {hint}
    </div>
  );
}

const headlineAmount: CSSProperties = { fontSize: 28, fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap', textAlign: 'right' };
const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 };
const th: CSSProperties = {
  textAlign: 'left', padding: '6px 8px', fontSize: 12, fontWeight: 600,
  color: 'var(--gd-text-secondary, #6b7280)', borderBottom: '1px solid var(--gd-card-border, #e5e7eb)',
};
const thNum: CSSProperties = { ...th, textAlign: 'right' };
const tdItem: CSSProperties = { padding: '6px 8px', width: '100%', overflowWrap: 'anywhere', borderBottom: '1px solid var(--gd-card-border, #e5e7eb)' };
const tdNum: CSSProperties = { padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--gd-card-border, #e5e7eb)' };
