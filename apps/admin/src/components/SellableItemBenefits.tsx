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
    const line = { gym_charge_id: b.gym_charge_id, quantity: b.quantity };
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
const tdSt: React.CSSProperties = { padding: '4px 8px 4px 0', fontSize: 13 };
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

/** The editable grid: item picker + quantity (+ the item's own, read-only frequency). */
export function SellableItemBenefitEditor({
  t, addKey, draft, setDraft, categoryItems, showFrequency, enforceMandatory = false,
  benefitContext,
}: {
  t: Translate;
  addKey: string;
  draft: SellableItemBenefitRow[];
  setDraft: SetDraft;
  categoryItems: SellableItemOption[];
  showFrequency: boolean;
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
                {showFrequency && (
                  <span style={{ fontSize: 13, color: '#666' }}>
                    {row.gym_charge_billing_frequency ? t(`frequency_${row.gym_charge_billing_frequency}`) : '—'}
                  </span>
                )}
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
      {hasMoreToAdd && (
        <button onClick={() => addBenefitRow(setDraft, categoryItems, draft)} style={btnSmall('#6c63ff')}>{t(addKey)}</button>
      )}
    </>
  );
}

/** Read-only counterpart — what a section shows until its own Edit button is pressed. */
export function SellableItemBenefitView({
  t, emptyKey, rows, showFrequency, enforceMandatory = false, benefitContext,
}: {
  t: Translate;
  emptyKey: string;
  rows: SellableItemBenefitRow[];
  showFrequency: boolean;
  /**
   * #896 stage 4: renders the line's configured treatment as a column of its
   * own, so the read-only half of the card says exactly what the editor behind
   * `⋮ → Edit` holds (#797 — the two halves are one field list).
   */
  benefitContext?: SellableItemBenefitContext;
  /** #893: tags a mandatory item here too, so the read-only half of the card
   *  says the same thing the editor does. */
  enforceMandatory?: boolean;
}) {
  if (rows.length === 0) return <p style={hintSt}>{t(emptyKey)}</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={thSt}>{t('col_sellable_item')}</th>
          <th style={thSt}>{t('col_quantity')}</th>
          {showFrequency && <th style={thSt}>{t('col_frequency')}</th>}
          {benefitContext && <th style={thSt}>{t('col_item_action')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.gym_charge_id}>
            <td style={tdSt}>
              {r.gym_charge_name}{r.gym_charge_status !== 'active' && ` ${t('inactive_item_tag')}`}
              {enforceMandatory && isMandatoryBenefitRow(r) && (
                <span style={mandatoryTagStyle}>{t('mandatory_item_tag')}</span>
              )}
            </td>
            <td style={tdSt}>{r.quantity}</td>
            {showFrequency && (
              <td style={tdSt}>{r.gym_charge_billing_frequency ? t(`frequency_${r.gym_charge_billing_frequency}`) : '—'}</td>
            )}
            {benefitContext && (
              <td style={tdSt}>{benefitTreatmentLabel(t, benefitContext, r)}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
