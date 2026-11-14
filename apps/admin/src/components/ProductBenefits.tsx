'use client';

/**
 * #635 stage 1 — the Session / One-off / Period Benefit editor, shared.
 *
 * Promotions have had these three sections since #550; the ticket asks that
 * Membership Plans get sections that "behave like the existing ... Benefits in
 * Promotions". Rather than copy the markup a second time, the two render
 * helpers that were inline in `promotions/page.tsx` live here, parameterised by
 * the only two things that differ between the sections (which category's active
 * items back the picker, and whether the read-only Frequency column shows).
 *
 * Deliberately presentational: the owning page keeps the draft state, decides
 * which section is editable, and owns Save/Cancel. That is what lets the same
 * pair of helpers serve Promotions' one-section-at-a-time editing (#627) and the
 * Plans page's per-section Edit buttons without either page's state leaking in.
 *
 * `t` is passed in rather than taken from `useTranslations()` here because the
 * two pages namespace their keys differently (`promotions.*` vs `plans.*`).
 * The one exception is a billing frequency, which #1128 gave a namespace of its
 * own precisely because it must read the same on every page: that label is
 * resolved here, through `@/lib/billingFrequency`, and never from a page's `t`.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  BILLING_FREQUENCY_NAMESPACE,
  billingFrequencyDurationLabel,
  billingFrequencyLabel,
} from '@/lib/billingFrequency';
import { primaryBtnSmall } from '@/components/ui';
import { rowRemoveBtnStyle } from '@/components/formChrome';
import {
  DEFAULT_BENEFIT_ACTION,
  ProductBenefitAction,
  ProductBenefitContext,
  benefitActionOf,
  benefitActionRequiresValue,
  benefitActionsFor,
  isPercentageBenefitAction,
  isRetiredBenefitAction,
} from '@/lib/productBenefitActions';
import {
  DEFAULT_PROMOTION_ITEM_REQUIREMENT,
  PROMOTION_ITEM_REQUIREMENTS,
  PromotionItemRequirement,
  promotionItemRequirementLabelKey,
  toPromotionItemRequirement,
} from '@/lib/promotionItemRequirement';
import {
  SESSION_BENEFIT_FREQUENCIES,
  SessionBenefitFrequency,
  sessionFrequencyLabelKey,
  toSessionBenefitFrequency,
} from '@/lib/sessionBenefitFrequency';

import {
  ProductBenefitRow,
  ProductOption,
  addBenefitRow,
  benefitRowOptions,
  clampBenefitValue,
  isMandatoryBenefitRow,
  updateBenefitRow,
  benefitRowKey,
} from '@/lib/benefitEditing';

export {
  addBenefitRow,
  benefitRowOptions,
  clampBenefitValue,
  invalidBenefitValueRow,
  isMandatoryBenefitRow,
  saveBenefitSection,
  toBenefitItems,
  updateBenefitRow,
} from '@/lib/benefitEditing';
export type {
  BenefitSectionAdapter,
  ProductBenefitRow,
  ProductOption,
  SaveBenefitSectionResult,
} from '@/lib/benefitEditing';

type Translate = (key: string, values?: Record<string, unknown>) => string;

type SetDraft = (fn: (prev: ProductBenefitRow[]) => ProductBenefitRow[]) => void;

/**
 * What a read-only row says its treatment is — the action's own label, plus the
 * configured value for the three that carry one. The currency suffix is the
 * page-wide `123.45€` convention (the Promotion timeline's Billing column uses
 * the same one), and the labels are the caller's namespace, which is what lets
 * the very same stored `no_benefit` read as *No promotion* on one screen and
 * *No benefit* on the other (§3/§4).
 */
export function benefitTreatmentLabel(
  t: Translate, context: ProductBenefitContext, row: ProductBenefitRow,
): string {
  const action = benefitActionOf(context, row.action);
  const label = t(`item_action_${action}`);
  if (!benefitActionRequiresValue(action)) return label;
  const n = Number(row.value);
  if (!Number.isFinite(n)) return label;
  if (isPercentageBenefitAction(action)) return `${label} (${n}%)`;
  return `${label} (${n.toFixed(2)}€)`;
}

const colHeaderSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const inlineSelectSt: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12, background: '#fff',
};
const thSt: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 4px 0', fontSize: 11, fontWeight: 600,
  color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const tdSt: React.CSSProperties = {
  padding: '4px 8px 4px 0', fontSize: 13, verticalAlign: 'top', wordBreak: 'break-word',
};
/**
 * #916: `table-layout: fixed` is what makes the shared column declaration
 * actually hold — without it a long Product name widens its cell and the
 * section stops lining up with the one above it, which is the defect the ticket
 * describes.
 */
const benefitTableSt: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed',
};
/** Tabular figures, so the two price columns compare vertically digit by digit. */
const moneySt: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
/** The line total under a unit price, when the quantity makes them differ. */
const lineTotalSt: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums',
};
const mutedValueSt: React.CSSProperties = { color: '#888' };
/**
 * #1135: the derived meaning under a Duration input — `3 months` under `3`. Same
 * secondary voice as the line total under a price, because it is the same kind
 * of thing: what the number above it works out to, never a second field.
 */
const derivedValueSt: React.CSSProperties = {
  display: 'block', fontSize: 11, color: '#888', marginTop: 2,
};
const hintSt: React.CSSProperties = { margin: 0, fontSize: 13, color: '#888' };
/** #2624: one value per line, cut with an ellipsis rather than widening its column. */
const truncatedLineSt: React.CSSProperties = {
  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
/** The same, as the flexible half of a thumbnail + name pair. */
const truncatedInlineSt: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
/**
 * #896 §14: the value input names itself, because what it holds depends on the
 * action beside it — *Promotion (%)*, *Promotion amount*, *Promotion price*.
 * A single column header could not say all three, and a row with no value must
 * say nothing at all.
 */
const valueLabelSt: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 600, color: '#888',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2,
};
/**
 * #997: the stored value of a retired treatment, shown as text where its input
 * used to be. It wears `formValueStyle`'s own reasoning — a value flush under
 * the label whose sibling rows carry an inset control would move the column —
 * so it keeps the control's padding and type size with no border or background
 * of its own, declaring no colour the Theme cannot move.
 */
const legacyValueSt: React.CSSProperties = {
  display: 'block', padding: '6px 0', fontSize: 13, color: '#666',
};
/**
 * #893 §2/§3: the pill that says *why* a row has no Remove control. Same
 * compact grey badge the Products list uses for `System`, so the two
 * screens read as one visual language.
 */
export const mandatoryTagStyle: React.CSSProperties = {
  marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#888', background: '#f0f0f0',
  borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap',
};

/* ── #916: the one column grid every Product section shares ─────────── */

/**
 * #916 — the read-only sections used to be three independent tables whose cells
 * were sized by their own content, so `QUANTITY`, `FREQUENCY` and `BENEFIT`
 * landed at a different horizontal position in each one and the three could not
 * be read as one data set. The columns are declared **once**, here, and every
 * section renders from the same declaration in the same order — which is the
 * ticket's central invariant:
 *
 *   > All Product sections must visually behave as one table with a shared
 *   > column grid, while remaining grouped into their existing semantic
 *   > sections.
 *
 * Which columns a *page* shows is still the page's choice (a Promotion does not
 * quote Plan prices), but it is one choice for all of that page's sections —
 * `productBenefitColumns()` takes the flags, not the section — so a column
 * a section has no value for renders an empty cell rather than disappearing and
 * shifting everything after it.
 */
export type ProductBenefitColumnKey =
  'item' | 'member' | 'quantity' | 'frequency' | 'action' | 'requirement' | 'original_price'
  | 'tax' | 'promotion' | 'promotion_benefit' | 'direct_discount' | 'final_price'
  | 'mandatory' | 'direct_discount_percent';

export interface ProductBenefitColumn {
  key: ProductBenefitColumnKey;
  /** Resolved in the caller's namespace, so a Plan and a Promotion can label the same column differently. */
  labelKey: string;
  /** Fixed width in px, or `null` for the one column that takes the rest. */
  width: number | null;
  align: 'left' | 'right';
}

/**
 * The column order the ticket fixes: Benefit sits **between** Frequency and the
 * two prices, never after them.
 */
export const PRODUCT_BENEFIT_COLUMNS: readonly ProductBenefitColumn[] = [
  { key: 'item', labelKey: 'col_product', width: null, align: 'left' },
  // #2657 stage 2: who an Individual Product's units are for, right after the
  // Product. Empty for a Shared Product. The Assigned Plan card only (`showMember`).
  { key: 'member', labelKey: 'col_benefit_member', width: 160, align: 'left' },
  { key: 'quantity', labelKey: 'col_quantity', width: 90, align: 'right' },
  { key: 'frequency', labelKey: 'col_frequency', width: 120, align: 'left' },
  { key: 'action', labelKey: 'col_item_action', width: 170, align: 'left' },
  // #2490 stage 3: a Membership Plan line's own Direct Discount (%), right after
  // the Benefit it is taken off after. The Assigned Plan card only
  // (`showDirectDiscount`); the Plans catalogue does not show it (#2808).
  { key: 'direct_discount_percent', labelKey: 'col_direct_discount_percent', width: 120, align: 'right' },
  // #959: Requirement comes after what the line *costs* and before the prices
  // that quote it — it is a property of the line, not a second treatment, and
  // Benefit stays between Frequency and the prices as #916 fixed it.
  { key: 'requirement', labelKey: 'col_requirement', width: 120, align: 'left' },
  { key: 'original_price', labelKey: 'col_original_price', width: 130, align: 'right' },
  // #2483 — the breakdown beside the price: the line's tax rate, the
  // Promotions that grant the same Product and what its own treatment took off.
  // Rendered only where a caller asks (`showBreakdown`), read from the server.
  { key: 'tax', labelKey: 'col_applied_tax', width: 90, align: 'right' },
  { key: 'promotion', labelKey: 'col_applied_promotion', width: 170, align: 'left' },
  // #2494 — what the applied Promotion does to this line, from the application's own frozen grant.
  { key: 'promotion_benefit', labelKey: 'col_promotion_benefit', width: 150, align: 'left' },
  { key: 'direct_discount', labelKey: 'col_direct_discount', width: 120, align: 'right' },
  { key: 'final_price', labelKey: 'col_final_price', width: 130, align: 'right' },
  // #1184 stage 2: a Membership Plan benefit's own Mandatory Yes/No is the last
  // data column, immediately before Actions — never between Frequency and
  // Benefit. It is the Plan relationship's flag and not `products.mandatory`
  // (the tag beside the item name) nor a Promotion line's Requirement above.
  { key: 'mandatory', labelKey: 'col_plan_mandatory', width: 100, align: 'left' },
];

/**
 * #918 — *which* Frequency the shared Frequency column shows.
 *
 *   `item`    — the Product's own `billing_frequency`, read-only. How
 *               often the item is priced; the answer for every section but one.
 *   `benefit` — the benefit row's own renewal Frequency, editable in the
 *               editor. How often the allowance comes back, which only a
 *               Membership Plan's Session Benefits configure.
 *
 * It is one column either way — the ticket's "the Frequency column must align
 * with the Frequency column used by the other Product sections" is why a
 * second column was not added beside it.
 */
export type BenefitFrequencyColumn = 'item' | 'benefit';

/**
 * #1135 — *what* the shared number column counts.
 *
 *   `quantity` — how many of the item the line carries. The answer for every
 *                section but one: a Session grant's units, a One-off's units, a
 *                Membership Plan's "units billed each occurrence".
 *   `duration`  — how many of the **item's own billing periods** the line
 *                applies to. A Promotion's Periodical grant, and only that one:
 *                `promotion_periodical.quantity` is what the billing engine
 *                counts periods with (`buildItemStream()` covers an occurrence
 *                while `occurrence < firstCovered + quantity`, and
 *                `collectBillableItems()` fixes such a grant's billed quantity
 *                to 1 — "the grant covers periods, it does not say how many
 *                lockers"), so the column is relabelled rather than joined by a
 *                second one, and nothing is stored differently.
 *
 * It is one column either way, for the reason `BenefitFrequencyColumn` is: the
 * three sections of a card read as one table (#916), so a per-section meaning is
 * a label and a caption, never a column of its own.
 */
export type BenefitQuantityColumn = 'quantity' | 'duration';

/** Which of the caller's keys heads that column. One place, both halves of the card. */
export function benefitQuantityLabelKey(column: BenefitQuantityColumn): string {
  return column === 'duration' ? 'col_duration' : 'col_quantity';
}

/** How little the flexible name column may be squeezed to before the table scrolls. */
export const BENEFIT_ITEM_COLUMN_MIN_WIDTH = 180;

/**
 * #2624 §6 — the Product column's fixed width on the dense breakdown grid (the
 * Assigned Plan card, `showBreakdown`). There the name column taking "the rest"
 * left a wide Product column beside narrow pricing and promotion columns, so it
 * is sized like every other column instead: with every width fixed, a
 * `table-layout: fixed` table spreads the spare room over all of them in
 * proportion. A long name is truncated in its cell, its full value in `title`.
 */
export const BENEFIT_ITEM_COMPACT_WIDTH = 200;

export function productBenefitColumns(opts: {
  showFrequency: boolean;
  showAction: boolean;
  showPrices: boolean;
  /** #2483 — Applied Tax, Applied Promotion and Direct Discount. Absent means not rendered. */
  showBreakdown?: boolean;
  /** #959 — a Promotion's Requirement column. Absent means not rendered at all. */
  showRequirement?: boolean;
  /** #1184 — a Membership Plan benefit's Mandatory column. Absent means not rendered at all. */
  showPlanMandatory?: boolean;
  /** #2490 stage 3 — a Membership Plan line's Direct Discount (%) column. Absent means not rendered at all. */
  showDirectDiscount?: boolean;
  /** #1135 — what the number column counts here. Defaults to a quantity. */
  quantityColumn?: BenefitQuantityColumn;
  /** #2657 stage 2 — the Assigned Plan card's Member column. Absent means not rendered at all. */
  showMember?: boolean;
}): ProductBenefitColumn[] {
  return PRODUCT_BENEFIT_COLUMNS.filter((col) => {
    if (col.key === 'member') return opts.showMember === true;
    if (col.key === 'frequency') return opts.showFrequency;
    if (col.key === 'action') return opts.showAction;
    if (col.key === 'requirement') return opts.showRequirement === true;
    if (col.key === 'mandatory') return opts.showPlanMandatory === true;
    if (col.key === 'direct_discount_percent') return opts.showDirectDiscount === true;
    if (col.key === 'original_price' || col.key === 'final_price') return opts.showPrices;
    if (col.key === 'tax' || col.key === 'promotion' || col.key === 'promotion_benefit' || col.key === 'direct_discount') {
      return opts.showPrices && opts.showBreakdown === true;
    }
    return true;
  }).map((col) => {
    // #1135: the same column, named for what it counts in this section. The
    // declaration stays the one place a column's width, order and alignment
    // live — only its label key moves.
    if (col.key === 'quantity') {
      return { ...col, labelKey: benefitQuantityLabelKey(opts.quantityColumn ?? 'quantity') };
    }
    // #2624 §6: on the breakdown grid the Product column stops taking the rest.
    if (col.key === 'item' && opts.showPrices && opts.showBreakdown === true) {
      return { ...col, width: BENEFIT_ITEM_COMPACT_WIDTH };
    }
    return col;
  });
}

/**
 * #2624 §7 — a cell listing several values (the Promotions touching a line, and
 * what each does to it) draws one per line, each truncated with its full text in
 * `title`, rather than joining them into one comma-separated string. `—` for none.
 */
function StackedCellValues({ values }: { values: string[] | null | undefined }) {
  if (!values || values.length === 0) return <>—</>;
  return (
    <>
      {values.map((v, i) => (
        <span key={i} title={v} style={truncatedLineSt}>{v}</span>
      ))}
    </>
  );
}

/**
 * The width below which the table scrolls horizontally instead of squashing its
 * columns out of alignment — the same answer #637 gave the Products list.
 */
export function benefitTableMinWidth(columns: ProductBenefitColumn[]): number {
  return columns.reduce(
    (total, col) => total + (col.width ?? BENEFIT_ITEM_COLUMN_MIN_WIDTH), 0,
  );
}

/** The page-wide `€100.00` form the Billing Event Simulation beside this table uses. */
export function formatBenefitPrice(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

/**
 * #2624 stage 2 (§5) — one agreed line of an Assigned Plan inside the section
 * editor: every fact is a value, the Direct Discount (%) is the one input, and
 * Remove exists only for an Optional line. It fills the same grid cells as an
 * editable row, so the columns stay aligned.
 */
function LockedBenefitRow({
  t, row, action, showFrequency, frequencyColumn, benefitContext, showDirectDiscount,
  showRequirement, showPlanMandatory, frequencyLabel, onDirectDiscount, onRemove,
}: {
  t: Translate;
  row: ProductBenefitRow;
  action: ProductBenefitAction | null;
  showFrequency: boolean;
  frequencyColumn: BenefitFrequencyColumn;
  benefitContext?: ProductBenefitContext;
  showDirectDiscount: boolean;
  showRequirement: boolean;
  showPlanMandatory: boolean;
  frequencyLabel: string;
  onDirectDiscount: (value: string) => void;
  onRemove: () => void;
}) {
  const optional = row.mandatory === false;
  const cell = { fontSize: 13 } as const;
  return (
    <div style={{ display: 'contents' }}>
      <span
        style={{ ...cell, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={row.member_name ? `${row.product_name} · ${row.member_name}` : row.product_name}
      >
        {row.product_name}
        {/* #2657 stage 3: an Individual Product is one line per member, so the row says whose. */}
        {row.member_name && <span style={{ color: '#666' }}> · {row.member_name}</span>}
        {!optional && <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>}
      </span>
      <span style={cell}>{row.quantity}</span>
      {showFrequency && (
        <span style={{ ...cell, color: '#666' }}>
          {frequencyColumn === 'benefit' ? t(sessionFrequencyLabelKey(row.frequency ?? null)) : frequencyLabel}
        </span>
      )}
      {benefitContext && <span style={cell}>{action ? t(`item_action_${action}`) : '—'}</span>}
      {benefitContext && (
        <span style={cell}>{action && benefitActionRequiresValue(action) ? (row.value ?? '—') : ''}</span>
      )}
      {showDirectDiscount && (
        <input
          type="number" min="0" max={100} step="1"
          value={row.direct_discount_percent ?? ''}
          onChange={(e) => onDirectDiscount(clampBenefitValue('percentage_discount', e.target.value) as string)}
          placeholder="0"
          aria-label={t('col_direct_discount_percent')}
          style={{ ...inlineSelectSt, width: '100%' }}
        />
      )}
      {showRequirement && <span />}
      {showPlanMandatory && <span />}
      {optional ? (
        <button
          onClick={onRemove}
          style={rowRemoveBtnStyle}
          aria-label={t('remove_optional_line', { product: row.product_name })}
        >✕</button>
      ) : <span />}
    </div>
  );
}


/** The editable grid: item picker + quantity (+ the item's own, read-only frequency). */
export function ProductBenefitEditor({
  t, addKey, draft, setDraft, categoryItems, showFrequency, enforceMandatory = false,
  benefitContext, frequencyColumn = 'item', quantityColumn = 'quantity',
  showRequirement = false, showPlanMandatory = false, showDirectDiscount = false,
  lockedProductIds,
}: {
  t: Translate;
  addKey: string;
  draft: ProductBenefitRow[];
  setDraft: SetDraft;
  categoryItems: ProductOption[];
  showFrequency: boolean;
  /**
   * #918: `'benefit'` turns the Frequency column into the row's own renewal
   * Frequency and makes it editable. Defaults to `'item'`, so every caller that
   * predates the ticket keeps the read-only item frequency it had.
   */
  frequencyColumn?: BenefitFrequencyColumn;
  /**
   * #1135: `'duration'` names the number column *Duration* and captions it with
   * how long that many of the item's own billing periods is (`3 months`). The
   * Promotion card's Periodical section, and nothing else — a Membership Plan's
   * periodical benefit quantity is units billed each occurrence, which is a
   * different question. Defaults to `'quantity'`, so every caller that predates
   * the ticket is unchanged, and the stored field is the same one either way.
   */
  quantityColumn?: BenefitQuantityColumn;
  /**
   * #896 stage 4: which option set the line's pricing treatment is chosen
   * from — `'promotion'` for all five, `'plan'` for the three a Membership Plan
   * may configure (§16). Omitted means the column is not rendered at all, which
   * is what keeps the Assigned Plan snapshot editor exactly as it was: its
   * endpoint takes quantity alone, so offering a dropdown there would be a
   * control that silently changes nothing.
   */
  benefitContext?: ProductBenefitContext;
  /**
   * #893: Membership Plan sections only. A mandatory row then renders its item
   * as a labelled value instead of a picker and has no Remove control — the
   * item can neither be dropped nor swapped for another one. The rule itself is
   * the API's (`domain/mandatoryPlanBenefits.ts`); this is presentation, so a
   * client that bypasses it changes nothing. Promotions pass nothing and keep
   * their existing behaviour unchanged (§9).
   */
  enforceMandatory?: boolean;
  /**
   * #959: a **Promotion** line's Requirement — Mandatory, or Optional for an
   * item the member may decline when the Promotion is assigned. Promotions only,
   * per the ticket thread (Membership Plans are excluded), and off by default so
   * every other caller's grid is exactly what it was. The value is stored on the
   * Promotion ↔ Product row and is not the catalogue item's own #893
   * `mandatory` flag beside it.
   */
  showRequirement?: boolean;
  /**
   * #1184 stage 2: a **Membership Plan** benefit's Mandatory Yes/No, a checkbox
   * at the end of the line's configuration. The Plans page only; off by default
   * so every other caller's grid is exactly what it was. Independent of
   * `enforceMandatory` above, which is the catalogue's flag.
   */
  showPlanMandatory?: boolean;
  /**
   * #2490 stage 3: a **Membership Plan** line's own Direct Discount (%), an
   * input beside its Benefit. The Plans page only; off by default.
   */
  showDirectDiscount?: boolean;
  /**
   * #2624 stage 2 (§5): the Assigned Plan's lines already agreed. Such a row is
   * read-only except its Direct Discount (%), and it carries the Remove control
   * only when it is Optional (`mandatory === false`) — the API refuses the rest
   * (`mandatoryLineRefusal()`). A row added in this edit is not in the set and
   * keeps the ordinary controls. Omitted means no row is locked.
   */
  lockedProductIds?: ReadonlySet<number>;
}) {
  // #1128: a billing frequency reads the same on every page, so its label is
  // the one shared namespace's and not the caller's `t`.
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const hasMoreToAdd = categoryItems.some((c) => !draft.some((d) => d.product_id === c.id));
  // #893 §3: the user must not have to guess why a row has no Remove control.
  // A form's explanatory sentence stays in the form (#797), so it is rendered
  // here and never beside the read-only values.
  const hasMandatory = enforceMandatory && draft.some(isMandatoryBenefitRow);
  // The action column and the value beside it are one unit: both appear only
  // when the caller named a context, so the grid is the same three or four
  // columns it has always been for a caller that did not.
  // #1653: fixed tracks are wide enough for their control and the product
  // track has a real minimum (`minmax(0, …)` is not one: it let the name
  // select shrink under the neighbours). When the sum does not fit, the grid
  // scrolls inside its wrapper instead of overlapping.
  const PRODUCT_MIN = 200;
  const fixedTracks = [
    quantityColumn === 'duration' ? 120 : 90,
    ...(showFrequency ? [130] : []),
    ...(benefitContext ? [160, 120] : []),
    ...(showDirectDiscount ? [110] : []),
    ...(showRequirement ? [130] : []),
    ...(showPlanMandatory ? [110] : []),
    32,
  ];
  const columns = [`minmax(${PRODUCT_MIN}px, 1.6fr)`, ...fixedTracks.map((w) => `${w}px`)].join(' ');
  const gridMinWidth = PRODUCT_MIN + fixedTracks.reduce((a, b) => a + b, 0) + fixedTracks.length * 12;
  return (
    <>
      {draft.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 8 }}>
        <div
          style={{
            display: 'grid', gridTemplateColumns: columns, minWidth: gridMinWidth,
            gap: '6px 12px', alignItems: 'center',
          }}
        >
          <span style={colHeaderSt}>{t('col_product')}</span>
          <span style={colHeaderSt}>{t(benefitQuantityLabelKey(quantityColumn))}</span>
          {showFrequency && <span style={colHeaderSt}>{t('col_frequency')}</span>}
          {benefitContext && <span style={colHeaderSt}>{t('col_item_action')}</span>}
          {benefitContext && <span />}
          {showDirectDiscount && <span style={colHeaderSt}>{t('col_direct_discount_percent')}</span>}
          {showRequirement && <span style={colHeaderSt}>{t('col_requirement')}</span>}
          {showPlanMandatory && <span style={colHeaderSt}>{t('col_plan_mandatory')}</span>}
          <span />
          {draft.map((row, idx) => {
            const mandatory = enforceMandatory && isMandatoryBenefitRow(row);
            const action = benefitContext ? benefitActionOf(benefitContext, row.action) : null;
            if (lockedProductIds?.has(row.product_id)) {
              return (
                <LockedBenefitRow
                  key={benefitRowKey(row)}
                  t={t}
                  row={row}
                  action={action}
                  showFrequency={showFrequency}
                  frequencyColumn={frequencyColumn}
                  benefitContext={benefitContext}
                  showDirectDiscount={showDirectDiscount}
                  showRequirement={showRequirement}
                  showPlanMandatory={showPlanMandatory}
                  frequencyLabel={billingFrequencyLabel(row.product_billing_frequency, tFreq) ?? '—'}
                  onDirectDiscount={(v) => updateBenefitRow(setDraft, categoryItems, idx, { direct_discount_percent: v })}
                  onRemove={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                />
              );
            }
            return (
              <div key={benefitRowKey(row)} style={{ display: 'contents' }}>
                {mandatory ? (
                  <span style={{ fontSize: 13 }}>
                    {row.product_name}
                    <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>
                  </span>
                ) : (
                  <select
                    value={row.product_id}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { product_id: parseInt(e.target.value, 10) })}
                    style={inlineSelectSt}
                  >
                    {benefitRowOptions(categoryItems, row).map((o) => (
                      <option key={o.id} value={o.id}>{o.inactive ? `${o.name} ${t('inactive_item_tag')}` : o.name}</option>
                    ))}
                  </select>
                )}
                <span>
                  <input
                    type="number" min="1" step="1" value={row.quantity}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { quantity: parseInt(e.target.value, 10) || 1 })}
                    style={{ ...inlineSelectSt, width: '100%' }}
                  />
                  {/* #1135: `3` is what is stored and typed; `3 months` is what
                      it means, derived from the item's own frequency and never
                      asked for. An item whose frequency names no period (`Once`,
                      a legacy `Per session`) gets no caption rather than a
                      sentence about three of nothing. */}
                  {quantityColumn === 'duration' && (
                    <span style={derivedValueSt}>
                      {billingFrequencyDurationLabel(
                        row.product_billing_frequency, Number(row.quantity), tFreq,
                      ) ?? '\u00a0'}
                    </span>
                  )}
                </span>
                {showFrequency && (frequencyColumn === 'benefit' ? (
                  // #918: the one editable Frequency — how often this benefit's
                  // sessions are renewed. `—` is a real stored value (no
                  // frequency, a one-time allowance), not a placeholder.
                  <select
                    value={row.frequency ?? ''}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                      frequency: toSessionBenefitFrequency(e.target.value),
                    })}
                    style={inlineSelectSt}
                  >
                    <option value="">{t(sessionFrequencyLabelKey(null))}</option>
                    {SESSION_BENEFIT_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>{t(sessionFrequencyLabelKey(f))}</option>
                    ))}
                  </select>
                ) : (
                  <span style={{ fontSize: 13, color: '#666' }}>
                    {billingFrequencyLabel(row.product_billing_frequency, tFreq) ?? '—'}
                  </span>
                ))}
                {benefitContext && action && (
                  <select
                    value={action}
                    // §16: the typed value is *kept* when the action changes, so
                    // switching away and back restores it. What stops a stale
                    // number being charged is `toBenefitItems()`, which submits
                    // only the value the selected action takes.
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                      action: e.target.value as ProductBenefitAction,
                    })}
                    style={inlineSelectSt}
                  >
                    {benefitActionsFor(benefitContext).map((a) => (
                      <option key={a} value={a}>{t(`item_action_${a}`)}</option>
                    ))}
                    {/*
                      #997: the treatment this line is *stored* with, when it is
                      one the context no longer offers. Rendered **disabled**, so
                      the row still says what it costs and the value can never be
                      picked again — dropping it would make the select read
                      `No benefit` for a line that bills a discount, and the
                      first unrelated save would make that true.
                    */}
                    {isRetiredBenefitAction(benefitContext, action) && (
                      <option value={action} disabled>{t(`item_action_${action}`)}</option>
                    )}
                  </select>
                )}
                {benefitContext && action && (
                  benefitActionRequiresValue(action) ? (
                    <span>
                      <span style={valueLabelSt}>{t(`item_action_value_${action}`)}</span>
                      {isRetiredBenefitAction(benefitContext, action) ? (
                        // #997 §2 — no percentage *input* inside a Membership
                        // Plan. The stored number is still shown, because it is
                        // what this line bills until somebody corrects the
                        // treatment, and a blank cell would read as no discount.
                        <span style={legacyValueSt}>{row.value ?? '—'}</span>
                      ) : (
                        <input
                          type="number" min="0" step={isPercentageBenefitAction(action) ? '1' : '0.01'}
                          max={isPercentageBenefitAction(action) ? 100 : undefined}
                          value={row.value ?? ''}
                          // A percentage is clamped as it is typed, the same way
                          // the Membership Fee Benefit's duration is capped —
                          // the API refuses anything above 100 anyway.
                          onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                            value: clampBenefitValue(action, e.target.value),
                          })}
                          placeholder="0"
                          style={{ ...inlineSelectSt, width: '100%' }}
                        />
                      )}
                    </span>
                  ) : <span />
                )}
                {showDirectDiscount && (
                  // #2490 stage 3: the line's own percentage, clamped as typed
                  // like the treatment's value; blank means none.
                  <input
                    type="number" min="0" max={100} step="1"
                    value={row.direct_discount_percent ?? ''}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                      direct_discount_percent: clampBenefitValue('percentage_discount', e.target.value),
                    })}
                    placeholder="0"
                    aria-label={t('col_direct_discount_percent')}
                    style={{ ...inlineSelectSt, width: '100%' }}
                  />
                )}
                {showRequirement && (
                  // #959: the existing inline select, not a new control — the
                  // ticket asks for the application's own patterns and no custom
                  // visual pattern where one already serves. There is no `—`
                  // option: the column is NOT NULL and `Mandatory` is what an
                  // unconfigured line means.
                  <select
                    value={toPromotionItemRequirement(row.requirement)}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                      requirement: toPromotionItemRequirement(e.target.value),
                    })}
                    style={inlineSelectSt}
                  >
                    {PROMOTION_ITEM_REQUIREMENTS.map((r) => (
                      <option key={r} value={r}>{t(promotionItemRequirementLabelKey(r))}</option>
                    ))}
                  </select>
                )}
                {showPlanMandatory && (
                  // #1184: Yes by default; checked means the member must keep it.
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={row.mandatory !== false}
                      onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, {
                        mandatory: e.target.checked,
                      })}
                      aria-label={t('col_plan_mandatory')}
                    />
                    {row.mandatory !== false ? t('plan_mandatory_yes') : t('plan_mandatory_no')}
                  </label>
                )}
                {mandatory ? <span /> : (
                  <button
                    onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                    style={rowRemoveBtnStyle}
                  >✕</button>
                )}
              </div>
            );
          })}
        </div>
        </div>
      )}
      {hasMandatory && <p style={{ ...hintSt, marginBottom: 8 }}>{t('mandatory_benefit_hint')}</p>}
      {/* #918: what the Frequency column means, and that `—` and `Once` are the
          same one-time allowance. A form's explanatory sentence stays in the
          form (#797), so it is never rendered beside the read-only values. */}
      {frequencyColumn === 'benefit' && showFrequency && (
        <p style={{ ...hintSt, marginBottom: 8 }}>{t('session_frequency_hint')}</p>
      )}
      {/* #1135: what Duration counts, and that the Product keeps billing at its
          regular price once the promotion has run out (§15). A form's
          explanatory sentence stays in the form (#797), so it is never rendered
          beside the read-only values. */}
      {quantityColumn === 'duration' && draft.length > 0 && (
        <p style={{ ...hintSt, marginBottom: 8 }}>{t('item_duration_hint')}</p>
      )}
      {/* #959: what Mandatory and Optional mean for the member. A form's
          explanatory sentence stays in the form (#797), so it is never rendered
          beside the read-only values. */}
      {showRequirement && draft.length > 0 && (
        <p style={{ ...hintSt, marginBottom: 8 }}>{t('item_requirement_hint')}</p>
      )}
      {/* #1184: what Mandatory means for the member at assignment. */}
      {showPlanMandatory && draft.length > 0 && (
        <p style={{ ...hintSt, marginBottom: 8 }}>{t('plan_mandatory_hint')}</p>
      )}
      {hasMoreToAdd && (
        <button
          onClick={() => addBenefitRow(
            setDraft, categoryItems, draft,
            // A new line carries the key only where the caller configures it, so
            // a section that does not keeps submitting payloads without it.
            {
              ...(showRequirement ? { requirement: DEFAULT_PROMOTION_ITEM_REQUIREMENT } : {}),
              ...(showPlanMandatory ? { mandatory: true } : {}),
              ...(showDirectDiscount ? { direct_discount_percent: null } : {}),
            },
          )}
          style={primaryBtnSmall()}
        >{t(addKey)}</button>
      )}
    </>
  );
}

/**
 * One read-only price cell: the Product's own price (or the same price
 * after the row's treatment), plus the line total whenever the quantity makes
 * the two differ.
 *
 * Both numbers are the server's (#916, #817 — no arithmetic in a page). The
 * secondary line exists so a quantity-5 row cannot quote €25 next to a Billing
 * Event Simulation charging €125, and it is omitted when it would merely repeat
 * the figure above it.
 */
function BenefitPriceCell({
  t, unit, line,
}: {
  t: Translate;
  unit: number | null | undefined;
  line: number | null | undefined;
}) {
  // An item with no price at all reads "—". €0.00 would claim it is free.
  if (unit == null) return <span style={mutedValueSt}>—</span>;
  return (
    <>
      <span style={moneySt}>{formatBenefitPrice(unit)}</span>
      {line != null && line !== unit && (
        <span style={lineTotalSt}>
          {t('benefit_total_price', { amount: formatBenefitPrice(line) })}
        </span>
      )}
    </>
  );
}

/** Read-only counterpart — what a section shows until its own Edit button is pressed. */
export function ProductBenefitView({
  t, emptyKey, rows, showFrequency, enforceMandatory = false, benefitContext,
  showPrices = false, showBreakdown = false, frequencyColumn = 'item', quantityColumn = 'quantity',
  showRequirement = false, showPlanMandatory = false, showDirectDiscount = false,
  showMember = false, renderItemPrefix, renderNestedRow,
}: {
  t: Translate;
  emptyKey: string;
  rows: ProductBenefitRow[];
  /**
   * #2478 — drawn immediately left of a row's Product name (the circular
   * thumbnail). Whatever it returns owns its own click; `null` draws nothing
   * and reserves no space.
   */
  renderItemPrefix?: (row: ProductBenefitRow, index: number) => React.ReactNode;
  /**
   * #2478 — content drawn in a full-width row directly under a row (the
   * Promotions applied to that Product). `null` adds no row, so the grid's
   * columns stay aligned.
   */
  renderNestedRow?: (row: ProductBenefitRow, index: number) => React.ReactNode;
  showFrequency: boolean;
  /** #918 — see `BenefitFrequencyColumn`. The read-only half of the same column. */
  frequencyColumn?: BenefitFrequencyColumn;
  /**
   * #1135 — see `BenefitQuantityColumn`. The read-only half of the same column,
   * so the card says what the editor behind `⋮ → Edit` holds (#797).
   */
  quantityColumn?: BenefitQuantityColumn;
  /**
   * #896 stage 4: renders the line's configured treatment as a column of its
   * own, so the read-only half of the card says exactly what the editor behind
   * `⋮ → Edit` holds (#797 — the two halves are one field list).
   */
  benefitContext?: ProductBenefitContext;
  /** #893: tags a mandatory item here too, so the read-only half of the card
   *  says the same thing the editor does. */
  enforceMandatory?: boolean;
  /**
   * #916: the Original / Final Price pair the row carries. Opt-in, because the
   * two amounts are a Membership Plan's — a Promotion's grants are priced
   * against the assignment they are applied to, not against the Promotion, and
   * the Assigned Plan snapshot sections quote their own frozen prices.
   */
  showPrices?: boolean;
  /** #2483 — tax / promotion / direct-discount columns. */
  showBreakdown?: boolean;
  /**
   * #959: the read-only half of the Requirement column, so the card says exactly
   * what the editor behind `⋮ → Edit` holds (#797 — the two halves are one field
   * list). See `ProductBenefitEditor`'s own prop.
   */
  showRequirement?: boolean;
  /** #1184: the read-only half of the Plan benefit's Mandatory column. */
  showPlanMandatory?: boolean;
  /** #2490 stage 3: the read-only half of a Plan line's Direct Discount (%) column. */
  showDirectDiscount?: boolean;
  /** #2657 stage 2: the Member column (the row's `member_name`, empty for a Shared Product). */
  showMember?: boolean;
}) {
  // #1128: a billing frequency reads the same on every page, so its label is
  // the one shared namespace's and not the caller's `t`.
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  if (rows.length === 0) return <p style={hintSt}>{t(emptyKey)}</p>;
  // One grid for every section of this page, whatever each section has values
  // for: a column with nothing to say renders an empty cell rather than
  // vanishing and shifting the columns after it out of line (#916).
  const columns = productBenefitColumns({
    showFrequency, showAction: benefitContext != null, showPrices, showBreakdown, showRequirement,
    showPlanMandatory, showDirectDiscount, quantityColumn, showMember,
  });

  const cell = (col: ProductBenefitColumn, row: ProductBenefitRow, index: number): React.ReactNode => {
    switch (col.key) {
      case 'item': {
        const prefix = renderItemPrefix ? renderItemPrefix(row, index) : null;
        const name = (
          <>
            {row.product_name}{row.product_status !== 'active' && ` ${t('inactive_item_tag')}`}
            {enforceMandatory && isMandatoryBenefitRow(row) && (
              <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>
            )}
          </>
        );
        // #2624 §6: the name truncates inside its fixed column rather than
        // widening it; the full name stays in `title`.
        const nameTitle = row.product_name ?? undefined;
        return prefix
          ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {prefix}<span title={nameTitle} style={truncatedInlineSt}>{name}</span>
            </span>
          )
          : <span title={nameTitle} style={truncatedLineSt}>{name}</span>;
      }
      case 'member':
        // #2657 stage 2: a Shared Product belongs to the whole plan, so its cell is empty.
        return row.member_name ?? '';
      case 'quantity':
        // #1135: a Duration reads as what it means — `3 months` rather than `3`,
        // from the item's own frequency. The stored number is the fallback, for
        // an item whose frequency names no period at all.
        if (quantityColumn === 'duration') {
          return billingFrequencyDurationLabel(
            row.product_billing_frequency, Number(row.quantity), tFreq,
          ) ?? row.quantity;
        }
        return row.quantity;
      case 'frequency':
        // #918: a Session Benefit section shows the renewal Frequency the Plan
        // configured; every other section shows the item's own. Either way the
        // cell stays, and a row with no frequency reads "—".
        if (frequencyColumn === 'benefit') return t(sessionFrequencyLabelKey(row.frequency));
        return billingFrequencyLabel(row.product_billing_frequency, tFreq) ?? '—';
      case 'action':
        return benefitContext ? benefitTreatmentLabel(t, benefitContext, row) : null;
      case 'requirement':
        // #959: the stored value, normalized — a line written before the column
        // existed reads `Mandatory`, which is what it means, never an empty cell.
        return t(promotionItemRequirementLabelKey(row.requirement));
      case 'direct_discount_percent': {
        // #2490 stage 3: the stored percentage, or `—` for none.
        const pct = Number(row.direct_discount_percent);
        return row.direct_discount_percent != null && row.direct_discount_percent !== '' && pct > 0
          ? `${pct}%` : '—';
      }
      case 'mandatory':
        // #1184: a row written before the column reads Yes, which is what it means.
        return row.mandatory === false ? t('plan_mandatory_no') : t('plan_mandatory_yes');
      case 'original_price':
        return (
          <BenefitPriceCell
            t={t} unit={row.original_price_incl_tax}
            line={row.original_line_price_incl_tax}
          />
        );
      case 'tax':
        return row.applied_tax_percent != null ? `${row.applied_tax_percent}%` : '—';
      case 'promotion':
        return <StackedCellValues values={row.applied_promotions} />;
      case 'promotion_benefit':
        return <StackedCellValues values={row.applied_promotion_benefits} />;
      case 'direct_discount':
        return row.direct_discount_line_incl_tax != null && row.direct_discount_line_incl_tax > 0
          ? <BenefitPriceCell t={t} unit={row.direct_discount_line_incl_tax} line={null} />
          : '—';
      case 'final_price':
        return (
          <BenefitPriceCell
            t={t} unit={row.final_price_incl_tax}
            line={row.final_line_price_incl_tax}
          />
        );
    }
  };

  return (
    // #637's answer, one screen over: the table scrolls rather than squashing
    // its columns when the viewport is too narrow.
    <div style={{ overflowX: 'auto' }}>
      <table style={{ ...benefitTableSt, minWidth: benefitTableMinWidth(columns) }}>
        <colgroup>
          {columns.map((col) => (
            <col key={col.key} style={col.width == null ? undefined : { width: col.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ ...thSt, textAlign: col.align }}>{t(col.labelKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* #924 stage 2: the index rides along in the key because a caller may
              render rows whose Product is gone — an applied Promotion's
              grants keep the item's identity after it is deleted, and two such
              lines would otherwise share one key. */}
          {rows.map((r, idx) => {
            const nested = renderNestedRow ? renderNestedRow(r, idx) : null;
            return (
              <React.Fragment key={`${r.product_id}-${idx}`}>
                <tr>
                  {columns.map((col) => (
                    <td key={col.key} style={{ ...tdSt, textAlign: col.align }}>{cell(col, r, idx)}</td>
                  ))}
                </tr>
                {nested != null && (
                  <tr>
                    <td colSpan={columns.length} style={{ ...tdSt, paddingTop: 0 }}>{nested}</td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

