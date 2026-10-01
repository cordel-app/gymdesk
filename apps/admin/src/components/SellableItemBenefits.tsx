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
 */

import React from 'react';
import { btnSmall } from '@/components/ui';
import {
  DEFAULT_BENEFIT_ACTION,
  SellableItemBenefitAction,
  SellableItemBenefitContext,
  benefitActionOf,
  benefitActionRequiresValue,
  benefitActionsFor,
  isPercentageBenefitAction,
} from '@/lib/sellableItemBenefitActions';
import {
  SESSION_BENEFIT_FREQUENCIES,
  SessionBenefitFrequency,
  sessionFrequencyLabelKey,
  toSessionBenefitFrequency,
} from '@/lib/sessionBenefitFrequency';

/** One saved/drafted benefit row. `gym_charge_*` is joined server-side, so an
 *  item that has since gone inactive still renders with its real name. */
export interface SellableItemBenefitRow {
  gym_charge_id: number;
  quantity: number;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
  /**
   * #893: `gym_charges.mandatory`, joined server-side. Present only where the
   * caller enforces the rule (the Membership Plan sections) — a Promotion's
   * benefit rows do not carry it, which is why `enforceMandatory` is an
   * explicit prop rather than something inferred from the field being there.
   */
  gym_charge_mandatory?: boolean | number;
  /**
   * #893: a mandatory item the Plan has no stored row for yet. The section
   * shows it and the next save of the section persists it — the server decides
   * this, never the editor.
   */
  implicit?: boolean;
  /**
   * #896 §15: the line's own pricing treatment, stored on *this* relationship
   * and never on the Sellable Item — the same item may be waived by one Plan
   * and discounted 20% by a Promotion. Optional because a caller that does not
   * configure it (the Assigned Plan snapshot sections, whose endpoint takes
   * quantity alone) must keep submitting quantity-only payloads: the six
   * replace-all `PUT`s keep a line's stored pair when the request does not
   * mention it, which is what stops an unrelated edit clearing a discount.
   */
  action?: SellableItemBenefitAction;
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
   * #916 — what the row costs, VAT included, as the server computed it
   * (`domain/planBenefitPrices.ts` over `applyLineBenefit()`): the Sellable
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
export function isMandatoryBenefitRow(row: SellableItemBenefitRow): boolean {
  return row.gym_charge_mandatory === true || Number(row.gym_charge_mandatory) === 1;
}

/** A Sellable Item offered by the picker. `benefit_category` is computed
 *  server-side (#550) and is the only classification source of truth. */
export interface SellableItemOption {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  benefit_category: 'session' | 'oneoff' | 'periodical';
  /** #893: `gym_charges.mandatory` — served by `GET /sellable-items` since #832. */
  mandatory?: boolean | number;
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

type SetDraft = (fn: (prev: SellableItemBenefitRow[]) => SellableItemBenefitRow[]) => void;

/**
 * A row's own saved item is always offered, even after it drops out of the
 * active-only `categoryItems` — otherwise editing an unrelated section would
 * silently swap a deactivated item for another one (#550).
 */
export function benefitRowOptions(categoryItems: SellableItemOption[], row: SellableItemBenefitRow) {
  const opts = categoryItems.map((c) => ({ id: c.id, name: c.name, inactive: false }));
  if (!opts.some((o) => o.id === row.gym_charge_id)) {
    opts.unshift({ id: row.gym_charge_id, name: row.gym_charge_name, inactive: true });
  }
  return opts;
}

/** Appends the first category item not already in the draft. No-ops when every item is taken. */
export function addBenefitRow(setDraft: SetDraft, categoryItems: SellableItemOption[], draft: SellableItemBenefitRow[]) {
  const next = categoryItems.find((c) => !draft.some((d) => d.gym_charge_id === c.id));
  if (!next) return;
  setDraft((prev) => [
    ...prev,
    {
      gym_charge_id: next.id, quantity: 1, gym_charge_name: next.name,
      gym_charge_type: next.type, gym_charge_billing_frequency: next.billing_frequency,
      gym_charge_status: next.status, gym_charge_mandatory: next.mandatory ?? 0,
      // #896 §13: a new line starts neutral — it is included at the Sellable
      // Item's own price, and only an explicit choice can make it cheaper.
      action: DEFAULT_BENEFIT_ACTION, value: null,
    },
  ]);
}

/** Patches one draft row, re-deriving the joined item fields when the item itself changes. */
export function updateBenefitRow(
  setDraft: SetDraft,
  categoryItems: SellableItemOption[],
  idx: number,
  patch: Partial<SellableItemBenefitRow>,
) {
  setDraft((prev) => prev.map((r, i) => {
    if (i !== idx) return r;
    const next = { ...r, ...patch };
    if (patch.gym_charge_id != null) {
      const item = categoryItems.find((c) => c.id === patch.gym_charge_id);
      if (item) {
        next.gym_charge_name = item.name;
        next.gym_charge_type = item.type;
        next.gym_charge_billing_frequency = item.billing_frequency;
        next.gym_charge_status = item.status;
        next.gym_charge_mandatory = item.mandatory ?? 0;
      }
    }
    return next;
  }));
}

/**
 * Replace-all payload both the Promotion and the Plan benefit endpoints take.
 *
 * #896 stage 4: a line carries its `(action, value)` pair only when the draft
 * has one. That is not a formality — `parseSellableItemBenefitInput()` treats
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
export const toBenefitItems = (draft: SellableItemBenefitRow[]) =>
  draft.map((b) => {
    // #918: the Frequency travels under the same rule as the pair — only when
    // the draft row actually carries the key, so a section that does not
    // configure it cannot clear what is stored.
    const line: Record<string, unknown> = { gym_charge_id: b.gym_charge_id, quantity: b.quantity };
    if ('frequency' in b) line.frequency = b.frequency ?? null;
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
  draft: SellableItemBenefitRow[],
): SellableItemBenefitRow | null {
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
export function clampBenefitValue(action: SellableItemBenefitAction, raw: string): string {
  if (raw === '') return raw;
  if (!isPercentageBenefitAction(action)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Math.min(100, Math.max(0, n)));
}

/**
 * What a read-only row says its treatment is — the action's own label, plus the
 * configured value for the three that carry one. The currency suffix is the
 * page-wide `123.45€` convention (the Promotion timeline's Billing column uses
 * the same one), and the labels are the caller's namespace, which is what lets
 * the very same stored `no_benefit` read as *No promotion* on one screen and
 * *No benefit* on the other (§3/§4).
 */
export function benefitTreatmentLabel(
  t: Translate, context: SellableItemBenefitContext, row: SellableItemBenefitRow,
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
 * actually hold — without it a long Sellable Item name widens its cell and the
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
const hintSt: React.CSSProperties = { margin: 0, fontSize: 13, color: '#888' };
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
 * #893 §2/§3: the pill that says *why* a row has no Remove control. Same
 * compact grey badge the Sellable Items list uses for `System`, so the two
 * screens read as one visual language.
 */
export const mandatoryTagStyle: React.CSSProperties = {
  marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#888', background: '#f0f0f0',
  borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap',
};

/* ── #916: the one column grid every Sellable Item section shares ─────────── */

/**
 * #916 — the read-only sections used to be three independent tables whose cells
 * were sized by their own content, so `QUANTITY`, `FREQUENCY` and `BENEFIT`
 * landed at a different horizontal position in each one and the three could not
 * be read as one data set. The columns are declared **once**, here, and every
 * section renders from the same declaration in the same order — which is the
 * ticket's central invariant:
 *
 *   > All Sellable Item sections must visually behave as one table with a shared
 *   > column grid, while remaining grouped into their existing semantic
 *   > sections.
 *
 * Which columns a *page* shows is still the page's choice (a Promotion does not
 * quote Plan prices), but it is one choice for all of that page's sections —
 * `sellableItemBenefitColumns()` takes the flags, not the section — so a column
 * a section has no value for renders an empty cell rather than disappearing and
 * shifting everything after it.
 */
export type SellableItemBenefitColumnKey =
  'item' | 'quantity' | 'frequency' | 'action' | 'original_price' | 'final_price';

export interface SellableItemBenefitColumn {
  key: SellableItemBenefitColumnKey;
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
export const SELLABLE_ITEM_BENEFIT_COLUMNS: readonly SellableItemBenefitColumn[] = [
  { key: 'item', labelKey: 'col_sellable_item', width: null, align: 'left' },
  { key: 'quantity', labelKey: 'col_quantity', width: 90, align: 'right' },
  { key: 'frequency', labelKey: 'col_frequency', width: 120, align: 'left' },
  { key: 'action', labelKey: 'col_item_action', width: 170, align: 'left' },
  { key: 'original_price', labelKey: 'col_original_price', width: 130, align: 'right' },
  { key: 'final_price', labelKey: 'col_final_price', width: 130, align: 'right' },
];

/**
 * #918 — *which* Frequency the shared Frequency column shows.
 *
 *   `item`    — the Sellable Item's own `billing_frequency`, read-only. How
 *               often the item is priced; the answer for every section but one.
 *   `benefit` — the benefit row's own renewal Frequency, editable in the
 *               editor. How often the allowance comes back, which only a
 *               Membership Plan's Session Benefits configure.
 *
 * It is one column either way — the ticket's "the Frequency column must align
 * with the Frequency column used by the other Sellable Item sections" is why a
 * second column was not added beside it.
 */
export type BenefitFrequencyColumn = 'item' | 'benefit';

/** How little the flexible name column may be squeezed to before the table scrolls. */
export const BENEFIT_ITEM_COLUMN_MIN_WIDTH = 180;

export function sellableItemBenefitColumns(opts: {
  showFrequency: boolean;
  showAction: boolean;
  showPrices: boolean;
}): SellableItemBenefitColumn[] {
  return SELLABLE_ITEM_BENEFIT_COLUMNS.filter((col) => {
    if (col.key === 'frequency') return opts.showFrequency;
    if (col.key === 'action') return opts.showAction;
    if (col.key === 'original_price' || col.key === 'final_price') return opts.showPrices;
    return true;
  });
}

/**
 * The width below which the table scrolls horizontally instead of squashing its
 * columns out of alignment — the same answer #637 gave the Sellable Items list.
 */
export function benefitTableMinWidth(columns: SellableItemBenefitColumn[]): number {
  return columns.reduce(
    (total, col) => total + (col.width ?? BENEFIT_ITEM_COLUMN_MIN_WIDTH), 0,
  );
}

/** The page-wide `€100.00` form the Billing Event Simulation beside this table uses. */
export function formatBenefitPrice(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

/** The editable grid: item picker + quantity (+ the item's own, read-only frequency). */
export function SellableItemBenefitEditor({
  t, addKey, draft, setDraft, categoryItems, showFrequency, enforceMandatory = false,
  benefitContext, frequencyColumn = 'item',
}: {
  t: Translate;
  addKey: string;
  draft: SellableItemBenefitRow[];
  setDraft: SetDraft;
  categoryItems: SellableItemOption[];
  showFrequency: boolean;
  /**
   * #918: `'benefit'` turns the Frequency column into the row's own renewal
   * Frequency and makes it editable. Defaults to `'item'`, so every caller that
   * predates the ticket keeps the read-only item frequency it had.
   */
  frequencyColumn?: BenefitFrequencyColumn;
  /**
   * #896 stage 4: which option set the line's pricing treatment is chosen
   * from — `'promotion'` for all five, `'plan'` for the three a Membership Plan
   * may configure (§16). Omitted means the column is not rendered at all, which
   * is what keeps the Assigned Plan snapshot editor exactly as it was: its
   * endpoint takes quantity alone, so offering a dropdown there would be a
   * control that silently changes nothing.
   */
  benefitContext?: SellableItemBenefitContext;
  /**
   * #893: Membership Plan sections only. A mandatory row then renders its item
   * as a labelled value instead of a picker and has no Remove control — the
   * item can neither be dropped nor swapped for another one. The rule itself is
   * the API's (`domain/mandatoryPlanBenefits.ts`); this is presentation, so a
   * client that bypasses it changes nothing. Promotions pass nothing and keep
   * their existing behaviour unchanged (§9).
   */
  enforceMandatory?: boolean;
}) {
  const hasMoreToAdd = categoryItems.some((c) => !draft.some((d) => d.gym_charge_id === c.id));
  // #893 §3: the user must not have to guess why a row has no Remove control.
  // A form's explanatory sentence stays in the form (#797), so it is rendered
  // here and never beside the read-only values.
  const hasMandatory = enforceMandatory && draft.some(isMandatoryBenefitRow);
  // The action column and the value beside it are one unit: both appear only
  // when the caller named a context, so the grid is the same three or four
  // columns it has always been for a caller that did not.
  const columns = [
    '1.3fr', '80px',
    ...(showFrequency ? ['100px'] : []),
    ...(benefitContext ? ['130px', '110px'] : []),
    '28px',
  ].join(' ');
  return (
    <>
      {draft.length > 0 && (
        <div
          style={{
            display: 'grid', gridTemplateColumns: columns,
            gap: '3px 8px', alignItems: 'center', marginBottom: 8,
          }}
        >
          <span style={colHeaderSt}>{t('col_sellable_item')}</span>
          <span style={colHeaderSt}>{t('col_quantity')}</span>
          {showFrequency && <span style={colHeaderSt}>{t('col_frequency')}</span>}
          {benefitContext && <span style={colHeaderSt}>{t('col_item_action')}</span>}
          {benefitContext && <span />}
          <span />
          {draft.map((row, idx) => {
            const mandatory = enforceMandatory && isMandatoryBenefitRow(row);
            const action = benefitContext ? benefitActionOf(benefitContext, row.action) : null;
            return (
              <div key={row.gym_charge_id} style={{ display: 'contents' }}>
                {mandatory ? (
                  <span style={{ fontSize: 13 }}>
                    {row.gym_charge_name}
                    <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>
                  </span>
                ) : (
                  <select
                    value={row.gym_charge_id}
                    onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { gym_charge_id: parseInt(e.target.value, 10) })}
                    style={inlineSelectSt}
                  >
                    {benefitRowOptions(categoryItems, row).map((o) => (
                      <option key={o.id} value={o.id}>{o.inactive ? `${o.name} ${t('inactive_item_tag')}` : o.name}</option>
                    ))}
                  </select>
                )}
                <input
                  type="number" min="1" value={row.quantity}
                  onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { quantity: parseInt(e.target.value, 10) || 1 })}
                  style={{ ...inlineSelectSt, width: '100%' }}
                />
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
                    {row.gym_charge_billing_frequency ? t(`frequency_${row.gym_charge_billing_frequency}`) : '—'}
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
                      action: e.target.value as SellableItemBenefitAction,
                    })}
                    style={inlineSelectSt}
                  >
                    {benefitActionsFor(benefitContext).map((a) => (
                      <option key={a} value={a}>{t(`item_action_${a}`)}</option>
                    ))}
                  </select>
                )}
                {benefitContext && action && (
                  benefitActionRequiresValue(action) ? (
                    <span>
                      <span style={valueLabelSt}>{t(`item_action_value_${action}`)}</span>
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
                    </span>
                  ) : <span />
                )}
                {mandatory ? <span /> : (
                  <button
                    onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: 14, padding: 0 }}
                  >✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {hasMandatory && <p style={{ ...hintSt, marginBottom: 8 }}>{t('mandatory_benefit_hint')}</p>}
      {/* #918: what the Frequency column means, and that `—` and `Once` are the
          same one-time allowance. A form's explanatory sentence stays in the
          form (#797), so it is never rendered beside the read-only values. */}
      {frequencyColumn === 'benefit' && showFrequency && (
        <p style={{ ...hintSt, marginBottom: 8 }}>{t('session_frequency_hint')}</p>
      )}
      {hasMoreToAdd && (
        <button onClick={() => addBenefitRow(setDraft, categoryItems, draft)} style={btnSmall('#6c63ff')}>{t(addKey)}</button>
      )}
    </>
  );
}

/**
 * One read-only price cell: the Sellable Item's own price (or the same price
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
export function SellableItemBenefitView({
  t, emptyKey, rows, showFrequency, enforceMandatory = false, benefitContext,
  showPrices = false, frequencyColumn = 'item',
}: {
  t: Translate;
  emptyKey: string;
  rows: SellableItemBenefitRow[];
  showFrequency: boolean;
  /** #918 — see `BenefitFrequencyColumn`. The read-only half of the same column. */
  frequencyColumn?: BenefitFrequencyColumn;
  /**
   * #896 stage 4: renders the line's configured treatment as a column of its
   * own, so the read-only half of the card says exactly what the editor behind
   * `⋮ → Edit` holds (#797 — the two halves are one field list).
   */
  benefitContext?: SellableItemBenefitContext;
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
}) {
  if (rows.length === 0) return <p style={hintSt}>{t(emptyKey)}</p>;
  // One grid for every section of this page, whatever each section has values
  // for: a column with nothing to say renders an empty cell rather than
  // vanishing and shifting the columns after it out of line (#916).
  const columns = sellableItemBenefitColumns({
    showFrequency, showAction: benefitContext != null, showPrices,
  });

  const cell = (col: SellableItemBenefitColumn, row: SellableItemBenefitRow): React.ReactNode => {
    switch (col.key) {
      case 'item':
        return (
          <>
            {row.gym_charge_name}{row.gym_charge_status !== 'active' && ` ${t('inactive_item_tag')}`}
            {enforceMandatory && isMandatoryBenefitRow(row) && (
              <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>
            )}
          </>
        );
      case 'quantity':
        return row.quantity;
      case 'frequency':
        // #918: a Session Benefit section shows the renewal Frequency the Plan
        // configured; every other section shows the item's own. Either way the
        // cell stays, and a row with no frequency reads "—".
        if (frequencyColumn === 'benefit') return t(sessionFrequencyLabelKey(row.frequency));
        return row.gym_charge_billing_frequency
          ? t(`frequency_${row.gym_charge_billing_frequency}`)
          : '—';
      case 'action':
        return benefitContext ? benefitTreatmentLabel(t, benefitContext, row) : null;
      case 'original_price':
        return (
          <BenefitPriceCell
            t={t} unit={row.original_price_incl_tax}
            line={row.original_line_price_incl_tax}
          />
        );
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
          {rows.map((r) => (
            <tr key={r.gym_charge_id}>
              {columns.map((col) => (
                <td key={col.key} style={{ ...tdSt, textAlign: col.align }}>{cell(col, r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
