import { db } from '../infra/db';
import { draftExpiresInSeconds, DRAFT_TTL_MINUTES } from '../domain/productSet';
import { loadRecurringLinePromotions } from './member-product-promotions';
import { assignedMemberSql } from '../domain/productAssignee';

/**
 * #2496 stage 2 — the member's own view of one Product Set version, read from
 * its frozen line snapshots (`member_products_recurrent_snapshot`) and each
 * line's applied Promotions' own grant snapshots, so a Draft the Members App
 * builds is shown with the figures that will be committed. Nothing here
 * prices: the unit price, the list price and the direct discount are the
 * line's frozen columns, the Promotion steps are `loadRecurringLinePromotions()`
 * (the Admin's Products list reads the same), and the only live columns read are
 * the Product's own presentation (description and picture).
 *
 * A line is `added` when the version's predecessor has no line with its
 * `line_ref`, else `inherited`; a predecessor line the version no longer
 * carries is listed under `removed_lines`, since a Draft deletes a removed line
 * outright (#1882). `expires_in_seconds` is the server's own countdown (#2477),
 * for a Draft only.
 */
export interface MemberProductSetLine {
  id: number;
  product_id: number;
  product_name: string;
  product_type: string | null;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  quantity: number;
  billing_frequency: string | null;
  starts_at: string | null;
  currency: string;
  unit_price: number;
  list_unit_price: number | null;
  regular_amount: number;
  direct_discount_percent: number | null;
  final_amount: number;
  promotions: unknown[];
  change: 'added' | 'inherited';
  assigned_member_id: number | null;
}

const LINE_COLUMNS = `s.id, s.product_id, s.quantity, s.item_name, s.item_type, s.unit_price,
  s.list_unit_price, s.direct_discount_percent, s.item_billing_frequency, s.currency,
  s.starts_at, COALESCE(s.line_ref, s.id) AS line_ref,
  p.description, p.image_url, p.image_thumbnail_url`;

async function linesOf(gymId: string, setId: number, ownerSql: string): Promise<any[]> {
  const { rows } = await db.query<any>(
    `SELECT ${LINE_COLUMNS}, ${assignedMemberSql('s', ownerSql)} AS assigned_member_id
       FROM member_products_recurrent_snapshot s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
       LEFT JOIN products p ON p.id = s.product_id AND p.gym_id = s.gym_id
      WHERE s.gym_id = ? AND s.product_set_id = ?
        AND (s.ends_at IS NULL OR s.ends_at >= CURDATE())
      ORDER BY s.created_at ASC, s.id ASC`,
    [gymId, setId],
  );
  return rows;
}

function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadMemberProductSetView(gymId: string, set: { id: number; status: string; previous_product_set_id: number | null }) {
  const lines = await linesOf(gymId, Number(set.id), 'ps.owner_member_id');
  const previous = set.previous_product_set_id != null
    ? await linesOf(gymId, Number(set.previous_product_set_id), 'ps.owner_member_id') : [];
  const previousRefs = new Set(previous.map((r) => Number(r.line_ref)));
  const currentRefs = new Set(lines.map((r) => Number(r.line_ref)));

  const promos = await loadRecurringLinePromotions(gymId, lines.map((r) => {
    const unit = Number(r.unit_price);
    return {
      id: Number(r.id), productId: Number(r.product_id),
      listUnit: r.list_unit_price == null ? unit : Number(r.list_unit_price),
      quantity: Number(r.quantity) || 1,
      pct: r.direct_discount_percent == null ? null : Number(r.direct_discount_percent),
    };
  }));

  const shapeLine = (r: any, change: 'added' | 'inherited'): MemberProductSetLine => {
    const quantity = Number(r.quantity) || 1;
    const unit = Number(r.unit_price);
    const listUnit = r.list_unit_price == null ? null : Number(r.list_unit_price);
    const lp = promos.get(Number(r.id));
    return {
      id: Number(r.id),
      product_id: Number(r.product_id),
      product_name: r.item_name,
      product_type: r.item_type ?? null,
      description: r.description ?? null,
      image_url: r.image_url ?? null,
      image_thumbnail_url: r.image_thumbnail_url ?? r.image_url ?? null,
      quantity,
      billing_frequency: r.item_billing_frequency ?? null,
      starts_at: dateOnly(r.starts_at),
      currency: r.currency ?? 'EUR',
      unit_price: unit,
      list_unit_price: listUnit,
      regular_amount: round2((listUnit ?? unit) * quantity),
      direct_discount_percent: r.direct_discount_percent == null ? null : Number(r.direct_discount_percent),
      final_amount: lp?.final ?? round2(unit * quantity),
      promotions: lp?.promotions ?? [],
      change,
      assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
    };
  };

  let expiresIn: number | null = null;
  if (set.status === 'draft') {
    const { rows } = await db.query<any>(
      `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), last_activity_at + INTERVAL ${DRAFT_TTL_MINUTES} MINUTE) AS s
         FROM product_sets WHERE id = ? AND gym_id = ?`, [Number(set.id), gymId]);
    expiresIn = draftExpiresInSeconds(rows[0]?.s);
  }

  return {
    expires_in_seconds: expiresIn,
    lines: lines.map((r) => shapeLine(r, set.previous_product_set_id != null && previousRefs.has(Number(r.line_ref)) ? 'inherited' : 'added')),
    removed_lines: previous
      .filter((r) => !currentRefs.has(Number(r.line_ref)))
      .map((r) => ({
        line_ref: Number(r.line_ref),
        product_id: Number(r.product_id),
        product_name: r.item_name,
        image_thumbnail_url: r.image_thumbnail_url ?? r.image_url ?? null,
        quantity: Number(r.quantity) || 1,
        billing_frequency: r.item_billing_frequency ?? null,
      })),
  };
}
