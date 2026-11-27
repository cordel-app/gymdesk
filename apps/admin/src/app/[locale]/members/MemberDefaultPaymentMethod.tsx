'use client';

import React from 'react';
import { profileValueStyle } from './MemberProfileLayout';
import { type DefaultPaymentMethodOption } from './defaultPaymentMethod';

/**
 * #3497 — a payment method as the Profile shows it: the catalogue's own
 * thumbnail (the image the payment-method UI already uses) beside its label.
 * Presentational: the label arrives resolved and nothing is fetched here.
 */
export function PaymentMethodValue({ option, label }: { option: DefaultPaymentMethodOption | null; label: string }) {
  const src = option?.image_thumbnail_url ?? option?.image_url ?? null;
  return (
    <p style={{ ...profileValueStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
      {src && (
        <img src={src} alt="" width={24} height={24} style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: 4 }} />
      )}
      <span>{label}</span>
    </p>
  );
}

/** The confirmation's body: the persisted method, then the newly selected one, each with its thumbnail. */
export function DefaultPaymentMethodChange({
  previous, next, previousLabel, nextLabel, previousCaption, nextCaption,
}: {
  previous: DefaultPaymentMethodOption | null;
  next: DefaultPaymentMethodOption | null;
  previousLabel: string;
  nextLabel: string;
  previousCaption: string;
  nextCaption: string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{previousCaption}</span>
      <PaymentMethodValue option={previous} label={previousLabel} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{nextCaption}</span>
      <PaymentMethodValue option={next} label={nextLabel} />
    </div>
  );
}
