/**
 * #3273 — a Member's purchases (#3251's carts) for the Member card's **Purchases** tab: read-only.
 *
 * The first level is `FROM purchases` and nothing else: one row per `purchases.id`, scoped to the
 * gym, newest first by `purchases.created_at`, paginated on that table. A purchase belongs to the
 * Member's list when the Member owns it (`owner_member_id`) **or** is the beneficiary of something
 * it wrote — a plan snapshot's `plan_snapshot_beneficiaries` row, a plan line's `assigned_member_id`,
 * or a standalone Product snapshot's assignee (`COALESCE(assigned_member_id, member_id)`, #2609).
 * Those are `EXISTS` predicates, so several items for one Member never duplicate a purchase.
 *
 * Everything below the first level is loaded for the purchases already identified, through the
 * explicit `purchase_id` relationships (#3251 stage 2): the plan snapshots it wrote and their own
 * frozen lines, the standalone Product snapshots it wrote, and the Billing Events whose
 * `billing_events.purchase_id` names it — never the Member's latest event, a name, a date or an
 * amount. Each event's payment details come from its own attempts (`domain/purchasePayment.ts`).
 */
import { toPurchaseChannel, type PurchaseChannel } from '../domain/purchaseChannel';
import { purchaseTotalAmount } from '../domain/purchaseTotal';
import { db } from '../infra/db';
import { loadRefundSummaries } from './billing-event-refunds';
import { deriveBillingEventStatus, displayBillingEventStatus } from '../domain/billingEventStatus';
import { purchasePayment, type PurchaseAttempt, type PurchasePayment } from '../domain/purchasePayment';

export const MEMBER_PURCHASES_MAX_LIMIT = 200;
export const MEMBER_PURCHASES_DEFAULT_LIMIT = 50;

/** Binds `gymId` once and `memberId` eight times (see `memberPurchaseParams()`). */
const MEMBER_PURCHASE_PREDICATE = `p.gym_id = ? AND (
  p.owner_member_id = ?
  OR EXISTS (SELECT 1 FROM plan_snapshots ps
               JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = ps.id AND b.gym_id = ps.gym_id
              WHERE ps.purchase_id = p.id AND ps.gym_id = p.gym_id AND b.member_id = ?)
  OR EXISTS (SELECT 1 FROM plan_snapshots ps
              WHERE ps.purchase_id = p.id AND ps.gym_id = p.gym_id AND (
                EXISTS (SELECT 1 FROM plan_session_snapshots l WHERE l.plan_snapshot_id = ps.id AND l.assigned_member_id = ?)
                OR EXISTS (SELECT 1 FROM plan_oneoff_snapshots l WHERE l.plan_snapshot_id = ps.id AND l.assigned_member_id = ?)
                OR EXISTS (SELECT 1 FROM plan_periodical_snapshots l WHERE l.plan_snapshot_id = ps.id AND l.assigned_member_id = ?)))
  OR EXISTS (SELECT 1 FROM product_periodical_snapshots s
              WHERE s.purchase_id = p.id AND s.gym_id = p.gym_id AND COALESCE(s.assigned_member_id, s.member_id) = ?)
  OR EXISTS (SELECT 1 FROM product_oneoff_snapshots s
              WHERE s.purchase_id = p.id AND s.gym_id = p.gym_id AND s.source_id IS NOT NULL
                AND COALESCE(s.assigned_member_id, s.member_id) = ?)
  OR EXISTS (SELECT 1 FROM product_session_snapshots s
              WHERE s.purchase_id = p.id AND s.gym_id = p.gym_id AND s.source_id IS NOT NULL
                AND COALESCE(s.assigned_member_id, s.member_id) = ?)
)`;

function memberPurchaseParams(gymId: string, memberId: number): Array<string | number> {
  return [gymId, ...Array(8).fill(memberId)];
}

export interface PurchaseMember { id: number; name: string | null }

export interface PurchasePlanLine {
  kind: 'session' | 'oneoff' | 'periodical';
  product_id: number | null;
  name: string | null;
  product_type: string | null;
  quantity: number;
  beneficiary: PurchaseMember | null;
}

export interface PurchasePlan {
  plan_snapshot_id: number;
  membership_plan_id: number | null;
  name: string | null;
  status: string;
  starts_at: string | null;
  beneficiaries: PurchaseMember[];
  products: PurchasePlanLine[];
}

export interface PurchaseProduct {
  kind: 'recurring' | 'oneoff' | 'session';
  /** The line's own id (`source_id`), what the per-Product routes are keyed on. */
  line_id: number | null;
  product_id: number | null;
  name: string | null;
  product_type: string | null;
  billing_frequency: string | null;
  quantity: number;
  status: string | null;
  beneficiary: PurchaseMember | null;
}

export interface PurchaseBillingEvent extends PurchasePayment {
  id: number;
  name: string | null;
  event_type: string;
  amount: string | null;
  /** #3332: null when the event type records no payment. */
  status: string | null;
  created_at: string;
}

export interface MemberPurchase {
  id: number;
  /** #3270: the name basis, the purchase's creation instant (UTC ISO 8601); the Admin composes the label. */
  name: string | null;
  status: string;
  created_at: string;
  created_by: string | null;
  /** #3355 stage 2: the purchase row's last change (its status moves, a cart merge). */
  modified_at: string | null;
  modified_by: string | null;
  /** #3355 stage 2: `purchaseTotalAmount()` over its Billing Events; null with none. */
  total_amount: string | null;
  /** #3278: the application the purchase was initiated through; null when unknown. */
  channel: PurchaseChannel | null;
  owner: PurchaseMember;
  plans: PurchasePlan[];
  products: PurchaseProduct[];
  billing_events: PurchaseBillingEvent[];
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const dateOnly = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
};
const member = (id: unknown, name: unknown): PurchaseMember | null =>
  id == null ? null : { id: Number(id), name: (name as string | null) ?? null };
const placeholders = (n: number) => Array(n).fill('?').join(',');

export async function memberExistsInGym(gymId: string, memberId: number): Promise<boolean> {
  const { rows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  return rows.length > 0;
}

export async function loadMemberPurchases(
  gymId: string, memberId: number, limit: number, offset: number,
): Promise<{ items: MemberPurchase[]; total: number }> {
  // `limit` / `offset` are validated integers, written into the statement (no bound LIMIT).
  const lim = Math.max(1, Math.min(MEMBER_PURCHASES_MAX_LIMIT, Math.trunc(limit)));
  const off = Math.max(0, Math.trunc(offset));
  const params = memberPurchaseParams(gymId, memberId);

  const { rows: countRows } = await db.query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM purchases p WHERE ${MEMBER_PURCHASE_PREDICATE}`, params);
  const { rows: purchaseRows } = await db.query<any>(
    `SELECT p.id, p.name, p.status, p.created_at, p.created_by, p.modified_at, p.modified_by, p.channel, p.owner_member_id, o.name AS owner_name
       FROM purchases p
       LEFT JOIN members o ON o.id = p.owner_member_id AND o.gym_id = p.gym_id
      WHERE ${MEMBER_PURCHASE_PREDICATE}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  const total = Number(countRows[0]?.total ?? 0);
  if (purchaseRows.length === 0) return { items: [], total };

  const ids = purchaseRows.map((r: any) => Number(r.id));
  const inIds = placeholders(ids.length);
  const [plans, products, events] = await Promise.all([
    loadPlans(gymId, ids, inIds),
    loadProducts(gymId, ids, inIds),
    loadEvents(gymId, ids, inIds),
  ]);
  const eventCancelled = await cancelledEventIds(gymId, ids, inIds);

  const items: MemberPurchase[] = purchaseRows.map((r: any) => {
    const id = Number(r.id);
    return {
      id,
      name: r.name != null ? String(r.name) : null,
      status: r.status,
      created_at: iso(r.created_at) as string,
      created_by: r.created_by ?? null,
      modified_at: iso(r.modified_at),
      modified_by: r.modified_by ?? null,
      total_amount: purchaseTotalAmount((events.get(id) ?? []).map((e) => ({
        id: e.id, amount: e.amount, cancelled: eventCancelled.has(e.id),
      }))),
      channel: toPurchaseChannel(r.channel),
      owner: member(r.owner_member_id, r.owner_name) as PurchaseMember,
      plans: plans.get(id) ?? [],
      products: products.get(id) ?? [],
      billing_events: events.get(id) ?? [],
    };
  });
  return { items, total };
}

async function loadPlans(gymId: string, ids: number[], inIds: string): Promise<Map<number, PurchasePlan[]>> {
  const out = new Map<number, PurchasePlan[]>();
  const { rows: planRows } = await db.query<any>(
    `SELECT ps.id, ps.purchase_id, ps.membership_plan_id, mp.name AS plan_name, ps.status, ps.starts_at
       FROM plan_snapshots ps
       LEFT JOIN membership_plans mp ON mp.id = ps.membership_plan_id AND mp.gym_id = ps.gym_id
      WHERE ps.gym_id = ? AND ps.purchase_id IN (${inIds})
      ORDER BY ps.id`,
    [gymId, ...ids],
  );
  if (planRows.length === 0) return out;
  const snapIds = planRows.map((r: any) => Number(r.id));
  const inSnaps = placeholders(snapIds.length);

  const { rows: benRows } = await db.query<any>(
    `SELECT b.plan_snapshot_id, b.member_id, m.name
       FROM plan_snapshot_beneficiaries b
       LEFT JOIN members m ON m.id = b.member_id AND m.gym_id = b.gym_id
      WHERE b.gym_id = ? AND b.plan_snapshot_id IN (${inSnaps})
      ORDER BY b.is_owner DESC, m.name, b.member_id`,
    [gymId, ...snapIds],
  );
  const lineArm = (table: string, kind: PurchasePlanLine['kind']) => `
    SELECT '${kind}' AS kind, l.id, l.plan_snapshot_id, l.product_id, l.item_name, l.item_type, l.quantity,
           l.assigned_member_id, m.name AS assigned_name
      FROM ${table} l
      LEFT JOIN members m ON m.id = l.assigned_member_id AND m.gym_id = l.gym_id
     WHERE l.gym_id = ? AND l.plan_snapshot_id IN (${inSnaps})`;
  const { rows: lineRows } = await db.query<any>(
    `${lineArm('plan_session_snapshots', 'session')}
     UNION ALL ${lineArm('plan_oneoff_snapshots', 'oneoff')}
     UNION ALL ${lineArm('plan_periodical_snapshots', 'periodical')}
     ORDER BY plan_snapshot_id, item_name, id`,
    [gymId, ...snapIds, gymId, ...snapIds, gymId, ...snapIds],
  );

  const plansById = new Map<number, PurchasePlan>();
  for (const r of planRows) {
    const plan: PurchasePlan = {
      plan_snapshot_id: Number(r.id),
      membership_plan_id: r.membership_plan_id != null ? Number(r.membership_plan_id) : null,
      name: r.plan_name ?? null,
      status: r.status,
      starts_at: dateOnly(r.starts_at),
      beneficiaries: [],
      products: [],
    };
    plansById.set(plan.plan_snapshot_id, plan);
    const list = out.get(Number(r.purchase_id)) ?? [];
    list.push(plan);
    out.set(Number(r.purchase_id), list);
  }
  for (const b of benRows) {
    plansById.get(Number(b.plan_snapshot_id))?.beneficiaries.push(member(b.member_id, b.name) as PurchaseMember);
  }
  for (const l of lineRows) {
    plansById.get(Number(l.plan_snapshot_id))?.products.push({
      kind: l.kind,
      product_id: l.product_id != null ? Number(l.product_id) : null,
      name: l.item_name ?? null,
      product_type: l.item_type ?? null,
      quantity: Number(l.quantity ?? 0),
      beneficiary: member(l.assigned_member_id, l.assigned_name),
    });
  }
  return out;
}

async function loadProducts(gymId: string, ids: number[], inIds: string): Promise<Map<number, PurchaseProduct[]>> {
  const out = new Map<number, PurchaseProduct[]>();
  const arm = (table: string, kind: PurchaseProduct['kind'], purchaseRowsOnly: boolean) => `
    SELECT '${kind}' AS kind, s.id, s.purchase_id, s.source_id, s.product_id, s.product_name, s.product_type,
           s.billing_frequency, s.quantity, s.status,
           COALESCE(s.assigned_member_id, s.member_id) AS beneficiary_id, m.name AS beneficiary_name
      FROM ${table} s
      LEFT JOIN members m ON m.id = COALESCE(s.assigned_member_id, s.member_id) AND m.gym_id = s.gym_id
     WHERE s.gym_id = ? AND s.purchase_id IN (${inIds})${purchaseRowsOnly ? ' AND s.source_id IS NOT NULL' : ''}`;
  const { rows } = await db.query<any>(
    `${arm('product_periodical_snapshots', 'recurring', false)}
     UNION ALL ${arm('product_oneoff_snapshots', 'oneoff', true)}
     UNION ALL ${arm('product_session_snapshots', 'session', true)}
     ORDER BY purchase_id, product_name, id`,
    [gymId, ...ids, gymId, ...ids, gymId, ...ids],
  );
  for (const r of rows) {
    const list = out.get(Number(r.purchase_id)) ?? [];
    list.push({
      kind: r.kind,
      line_id: r.source_id != null ? Number(r.source_id) : null,
      product_id: r.product_id != null ? Number(r.product_id) : null,
      name: r.product_name ?? null,
      product_type: r.product_type ?? null,
      billing_frequency: r.billing_frequency ?? null,
      quantity: Number(r.quantity ?? 1),
      status: r.status ?? null,
      beneficiary: member(r.beneficiary_id, r.beneficiary_name),
    });
    out.set(Number(r.purchase_id), list);
  }
  return out;
}

async function cancelledEventIds(gymId: string, ids: number[], inIds: string): Promise<Set<number>> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM billing_events WHERE gym_id = ? AND purchase_id IN (${inIds}) AND cancelled_at IS NOT NULL`,
    [gymId, ...ids]);
  return new Set(rows.map((r) => Number(r.id)));
}

async function loadEvents(gymId: string, ids: number[], inIds: string): Promise<Map<number, PurchaseBillingEvent[]>> {
  const out = new Map<number, PurchaseBillingEvent[]>();
  const { rows: eventRows } = await db.query<any>(
    `SELECT be.id, be.purchase_id, be.name, be.event_type, be.amount, be.created_at, be.cancelled_at, be.is_scheduled,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.transaction_type = 'payment'
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
       FROM billing_events be
      WHERE be.gym_id = ? AND be.purchase_id IN (${inIds})
      ORDER BY be.id`,
    [gymId, ...ids],
  );
  if (eventRows.length === 0) return out;
  const eventIds = eventRows.map((r: any) => Number(r.id));
  const { rows: attemptRows } = await db.query<any>(
    `SELECT pr.id, pr.billing_event_id, pr.status, pr.provider_status, pr.method, pr.payment_method_name,
            pr.payment_method_code, pr.created_at, pr.completed_at
       FROM payment_requests pr
      WHERE pr.gym_id = ? AND pr.transaction_type = 'payment'
        AND pr.billing_event_id IN (${placeholders(eventIds.length)})`,
    [gymId, ...eventIds],
  );
  const attempts = new Map<number, PurchaseAttempt[]>();
  for (const a of attemptRows) {
    const list = attempts.get(Number(a.billing_event_id)) ?? [];
    list.push({ ...a, id: Number(a.id) });
    attempts.set(Number(a.billing_event_id), list);
  }
  const refunds = await loadRefundSummaries(gymId, eventIds);

  for (const r of eventRows) {
    const id = Number(r.id);
    const status = Number(r.is_scheduled) === 1
      ? 'scheduled'
      // #3352: a refund reads on the event's own status (the Billing Events list's display rule),
      // never on the payment status, which is the provider's alone.
      : displayBillingEventStatus(
        deriveBillingEventStatus(r.event_type, r.latest_tx_status, r.cancelled_at != null),
        refunds.get(id)?.refund_state);
    const list = out.get(Number(r.purchase_id)) ?? [];
    list.push({
      id,
      name: r.name ?? null,
      event_type: r.event_type,
      amount: r.amount != null ? String(r.amount) : null,
      status,
      created_at: iso(r.created_at) as string,
      ...purchasePayment(attempts.get(id) ?? []),
    });
    out.set(Number(r.purchase_id), list);
  }
  return out;
}
