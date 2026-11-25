'use client';

import React from 'react';
import type { DiscountEntry } from './productsWorkflowView';

/**
 * #3284 — one reason of a Billing Event Line: its label in bold, then the detail in normal text
 * (`**Manual adjustment** Direct discount 50%`, `**Initial payment**: waived`). What the label,
 * separator and detail are is `discountEntries()`'s; this only draws them. `translate` resolves a
 * key of the `members` namespace, so the Initial Payment Summary and Billing Event Details read one
 * set of keys.
 */
export function LineReasonText({ entry, translate }: {
  entry: DiscountEntry;
  translate: (key: string, values?: Record<string, string | number>) => string;
}) {
  const detail = entry.key ? translate(entry.key, entry.values) : entry.text;
  if (!entry.typeKey) return <>{detail}</>;
  return (
    <>
      <strong>{translate(entry.typeKey)}</strong>
      {entry.separator}
      {detail}
    </>
  );
}
