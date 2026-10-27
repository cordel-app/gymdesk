/**
 * #2093 stage 1 — the benefit-row editing engine, context-agnostic.
 *
 * The row shape, the draft helpers, the replace-all payload and the client-side
 * value check used to live in `components/ProductBenefits.tsx` beside the JSX.
 * They know nothing about a Membership Plan, a Promotion or an Assigned Plan, so
 * they live here and every editor goes through them: the Plans card, the
 * Promotion card and the Assigned Plan card persist through different endpoints
 * (a `BenefitSectionAdapter`) but validate, shape and submit a section the same
 * way (`saveBenefitSection()`). `ProductBenefits.tsx` re-exports everything here,
 * so existing imports keep working.
 */

import {
  DEFAULT_BENEFIT_ACTION,
  ProductBenefitAction,
  benefitActionRequiresValue,
  isPercentageBenefitAction,
} from '@/lib/productBenefitActions';
import { PromotionItemRequirement } from '@/lib/promotionItemRequirement';
import { SessionBenefitFrequency } from '@/lib/sessionBenefitFrequency';

/** One saved/drafted benefit row. `product_*` is joined server-side, so an
 *  item that has since gone inactive still renders with its real name. */
export interface ProductBenefitRow {
  product_id: number;
  quantity: number;
  product_name: string;
  product_type: string;
  product_billing_frequency: string | null;
  product_status: string;
  /**
   * #893: `products.mandatory`, joined server-side. Present only where the
   * caller enforces the rule (the Membership Plan sections) — a Promotion's
   * benefit rows do not carry it, which is why `enforceMandatory` is an
   * explicit prop rather than something inferred from the field being there.
   */
  product_mandatory?: boolean | number;
  /**
   * #893: a mandatory item the Plan has no stored row for yet. The section
   * shows it and the next save of the section persists it — the server decides
   * this, never the editor.
   */
  implicit?: boolean;
  /**
   * #896 §15: the line's own pricing treatment, stored on *this* relationship
   * and never on the Product — the same item may be waived by one Plan
   * and discounted 20% by a Promotion. Optional because a caller that does not
   * configure it (the Assigned Plan snapshot sections, whose endpoint takes
   * quantity alone) must keep submitting quantity-only payloads: the six
   * replace-all `PUT`s keep a line's stored pair when the request does not
   * mention it, which is what stops an unrelated edit clearing a discount.
   */
  action?: ProductBenefitAction;
  /**
   * The percentage or the amount the action asks for, `null` for the two that
   * ask for none. A string while the editor holds a half-typed number — the
   * API normalizes and the page refuses an empty one before saving.
   */
  value?: number | string | null;
  /**
   * #918 — a **Session** Benefit's own renewal Frequency: how often the
   * included sessions come back ("2 per week"). Optional, and the key's absence
   * is load-bearing: the section `PUT`s are replace-all and the API keeps a
   * line's stored Frequency when the request does not mention it, so a caller
   * that does not configure it (the other two Plan sections, every Promotion
   * section, the Assigned Plan snapshot editor) must keep submitting payloads
   * without the key. `null` is the explicit `—`.
   */
  frequency?: SessionBenefitFrequency | null;
  /**
   * #959 — a **Promotion** line's Requirement: whether the member may decline
   * this item when the Promotion is assigned. Optional, and the key's absence is
   * load-bearing in the same way the two above are: the section `PUT`s are
   * replace-all and the API reads "no requirement named" as *keep what is
   * stored*, so a caller that does not configure it (every Membership Plan
   * section, the Assigned Plan snapshot editor) must keep submitting payloads
   * without the key rather than resetting an optional item to mandatory.
   *
   * Not `product_mandatory` above, which is the catalogue item's own #893
   * flag and answers a different question on a different row.
   */
  requirement?: PromotionItemRequirement;
  /**
   * #1184 stage 2 — a **Membership Plan** benefit's own Mandatory Yes/No: `true`
   * means the member must keep it when the Plan is assigned, `false` that they
   * may decline it. Optional, and the key's absence is load-bearing like the
   * three above: the section `PUT`s are replace-all and read "not mentioned" as
   * *keep what is stored*, so a section that does not configure it (every
   * Promotion section, the Assigned Plan snapshot editor) submits none.
   *
   * Not `product_mandatory` (the catalogue item's #893 flag) and not a
   * Promotion line's `requirement`.
   */
  mandatory?: boolean;
  /**
   * #916 — what the row costs, VAT included, as the server computed it
   * (`domain/planBenefitPrices.ts` over `applyLineBenefit()`): the Product
   * Item's own unit price, the same price after this row's treatment, and the
   * two line totals (`unit × quantity`) beside them.
   *
   * `null` means the item carries no price at all, which reads as "—" and never
   * as €0.00. Absent means the caller does not price this section — the
   * Promotion sections and the Assigned Plan snapshot editor — and the two
   * price columns are then not rendered at all.
   */
  original_price_incl_tax?: number | null;
  final_price_incl_tax?: number | null;
  original_line_price_incl_tax?: number | null;
  final_line_price_incl_tax?: number | null;
}

/** #893: `tinyint(1)` from MySQL, `boolean` from a literal. */
export function isMandatoryBenefitRow(row: ProductBenefitRow): boolean {
  return row.product_mandatory === true || Number(row.product_mandatory) === 1;
}

/** A Product offered by the picker. `benefit_category` is computed
 *  server-side (#550) and is the only classification source of truth. */
export interface ProductOption {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  benefit_category: 'session' | 'oneoff' | 'periodical';
  /** #893: `products.mandatory` — served by `GET /products` since #832. */
  mandatory?: boolean | number;
}

type SetDraft = (fn: (prev: ProductBenefitRow[]) => ProductBenefitRow[]) => void;

/**
 * A row's own saved item is always offered, even after it drops out of the
 * active-only `categoryItems` — otherwise editing an unrelated section would
 * silently swap a deactivated item for another one (#550).
 */
export function benefitRowOptions(categoryItems: ProductOption[], row: ProductBenefitRow) {
  const opts = categoryItems.map((c) => ({ id: c.id, name: c.name, inactive: false }));
  if (!opts.some((o) => o.id === row.product_id)) {
    opts.unshift({ id: row.product_id, name: row.product_name, inactive: true });
  }
  return opts;
}

/**
 * Appends the first category item not already in the draft. No-ops when every
 * item is taken.
 *
 * `seed` carries the defaults of the columns the *caller* configures — #959's
 * Requirement, today. It is a parameter rather than something decided here
 * because a key this draft row does not carry is a key `toBenefitItems()` does
 * not submit, which is what keeps a section that configures no Requirement from
 * sending one (see `requirement` on `ProductBenefitRow`).
 */
export function addBenefitRow(
  setDraft: SetDraft,
  categoryItems: ProductOption[],
  draft: ProductBenefitRow[],
  seed?: Partial<ProductBenefitRow>,
) {
  const next = categoryItems.find((c) => !draft.some((d) => d.product_id === c.id));
  if (!next) return;
  setDraft((prev) => [
    ...prev,
    {
      product_id: next.id, quantity: 1, product_name: next.name,
      product_type: next.type, product_billing_frequency: next.billing_frequency,
      product_status: next.status, product_mandatory: next.mandatory ?? 0,
      // #896 §13: a new line starts neutral — it is included at the Product
      // Item's own price, and only an explicit choice can make it cheaper.
      action: DEFAULT_BENEFIT_ACTION, value: null,
      ...seed,
    },
  ]);
}

/** Patches one draft row, re-deriving the joined item fields when the item itself changes. */
export function updateBenefitRow(
  setDraft: SetDraft,
  categoryItems: ProductOption[],
  idx: number,
  patch: Partial<ProductBenefitRow>,
) {
  setDraft((prev) => prev.map((r, i) => {
    if (i !== idx) return r;
    const next = { ...r, ...patch };
    if (patch.product_id != null) {
      const item = categoryItems.find((c) => c.id === patch.product_id);
      if (item) {
        next.product_name = item.name;
        next.product_type = item.type;
        next.product_billing_frequency = item.billing_frequency;
        next.product_status = item.status;
        next.product_mandatory = item.mandatory ?? 0;
      }
    }
    return next;
  }));
}

/**
 * Replace-all payload both the Promotion and the Plan benefit endpoints take.
 *
 * #896 stage 4: a line carries its `(action, value)` pair only when the draft
 * has one. That is not a formality — `parseProductBenefitInput()` treats
 * "the request named no action" as *keep what is stored*, so a caller that
 * never configures the pair (the Assigned Plan snapshot sections) must keep
 * sending quantity-only lines rather than a default that would overwrite a
 * configured treatment.
 *
 * Only the value belonging to the selected action is submitted (§16): the
 * editor deliberately *keeps* a typed number while you switch options, so that
 * switching back restores it, and this is where the one that no longer applies
 * is dropped.
 */
export const toBenefitItems = (draft: ProductBenefitRow[]) =>
  draft.map((b) => {
    // #918: the Frequency travels under the same rule as the pair — only when
    // the draft row actually carries the key, so a section that does not
    // configure it cannot clear what is stored.
    const line: Record<string, unknown> = { product_id: b.product_id, quantity: b.quantity };
    if ('frequency' in b) line.frequency = b.frequency ?? null;
    // #959: and the Requirement, under the same rule — only when the draft row
    // carries the key, so a section that does not configure it cannot reset what
    // is stored.
    if (b.requirement !== undefined) line.requirement = b.requirement;
    // #1184: and a Plan benefit's Mandatory flag, under the same rule.
    if (b.mandatory !== undefined) line.mandatory = b.mandatory;
    if (b.action === undefined) return line;
    return {
      ...line,
      action: b.action,
      value: benefitActionRequiresValue(b.action) ? (b.value ?? null) : null,
    };
  });

/**
 * §6 on the frontend's side: the first line whose action asks for a value it
 * does not have, or `null` when every line is complete. The API enforces the
 * same rule (`benefitConfigError()`) and is what actually decides — this exists
 * so a Save that would 400 names the offending item instead.
 *
 * A negative number and an out-of-range percentage are refused here too, so the
 * two halves cannot disagree about what "has a value" means.
 */
export function invalidBenefitValueRow(
  draft: ProductBenefitRow[],
): ProductBenefitRow | null {
  for (const row of draft) {
    if (row.action === undefined || !benefitActionRequiresValue(row.action)) continue;
    if (row.value === null || row.value === undefined || row.value === '') return row;
    const n = Number(row.value);
    if (!Number.isFinite(n) || n < 0) return row;
    if (isPercentageBenefitAction(row.action) && n > 100) return row;
  }
  return null;
}

/**
 * What the value input writes back. Empty stays empty (the row is incomplete
 * and `invalidBenefitValueRow()` is what says so); a percentage is clamped to
 * 0..100 as it is typed, so the editor cannot hold a number the API would
 * refuse. Monetary amounts are left alone beyond their `min`.
 */
export function clampBenefitValue(action: ProductBenefitAction, raw: string): string {
  if (raw === '') return raw;
  if (!isPercentageBenefitAction(action)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Math.min(100, Math.max(0, n)));
}

/**
 * Where a section's lines are loaded from and saved to. The only thing that
 * differs between the Plans card, the Promotion card and the Assigned Plan card:
 * the endpoint (and so which table the lines land in) is the adapter's, the
 * validation and the payload are the engine's.
 */
export interface BenefitSectionAdapter {
  /** Persists the replace-all payload for one section. */
  save(items: ReturnType<typeof toBenefitItems>): Promise<void>;
}

export type SaveBenefitSectionResult =
  | { ok: true }
  | { ok: false; reason: 'incomplete_value'; row: ProductBenefitRow };

/**
 * Validates every line first and only then sends anything, so an incomplete line
 * can never half-save a section. A failure of `adapter.save` propagates to the
 * caller, which keeps the editor open with the user's input intact.
 */
export async function saveBenefitSection(
  adapter: BenefitSectionAdapter,
  draft: ProductBenefitRow[],
): Promise<SaveBenefitSectionResult> {
  const row = invalidBenefitValueRow(draft);
  if (row) return { ok: false, reason: 'incomplete_value', row };
  await adapter.save(toBenefitItems(draft));
  return { ok: true };
}
