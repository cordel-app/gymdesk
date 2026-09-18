// #547 — live VAT recalculation for the Membership Plans Pricing section.
// Mirrors the backend's computePriceFields() (api/src/api/sellable-items.ts)
// rounding/semantics exactly, so the admin sees the same net/gross split
// live, before saving, that the API will compute on read.

export type TaxBehavior = 'inclusive' | 'exclusive';

export interface VatPreview {
  amount_excl_tax: number;
  amount_incl_tax: number;
}

export function computeVatPreview(amount: number, ratePercent: number, behavior: TaxBehavior): VatPreview {
  const factor = 1 + ratePercent / 100;
  const amount_excl_tax = behavior === 'inclusive' ? amount / factor : amount;
  const amount_incl_tax = behavior === 'exclusive' ? amount * factor : amount;
  return {
    amount_excl_tax: parseFloat(amount_excl_tax.toFixed(2)),
    amount_incl_tax: parseFloat(amount_incl_tax.toFixed(2)),
  };
}

// Req. 8/12: when the VAT rate or behavior changes, the net price already
// applied to the plan is preserved and only the resulting gross (customer-
// facing) price is recalculated — never the other way around.
export function computeGrossFromPreservedNet(netAmount: number, newRatePercent: number): number {
  return parseFloat((netAmount * (1 + newRatePercent / 100)).toFixed(2));
}
