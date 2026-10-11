import { assignmentVersionId } from './assignment-config';
import { redirectEditToProductSet } from './assignment-edit-redirect';
import { addService as psAddService, removeService as psRemoveService } from './product-set-draft';
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { classifyProduct } from '../domain/productClassification';
import { SimulationService, ProductFrequency } from '../domain/billingSimulation';

/**
 * #631 — Additional Periodic Services on an Assigned Plan.
 *
 * Recurring Products attached directly to a `user_memberships` row
 * (migration 164). They belong to the Assigned Plan, never to the Membership
 * Plan and never to a Promotion (#631 §4/§7): adding one changes nothing about
 * the Plan itself, and nothing here touches `promotion_*` or the Plan's
 * included benefits.
 *
 * The Product stays the source of truth for the price and the billing
 * frequency (#631 §2 — "use the existing Product definitions ... rather
 * than creating a new product/service model"), so those are read live from
 * `products` on every request instead of being copied onto the attachment.
 * Only the assignment-specific facts are stored: which item, how many, and the
 * effective window.
 *
 * Removal is future-only (#631 §3): it stamps `ends_at` rather than deleting
 * the row, so the Billing Simulation keeps the charges the service already
 * produced and only stops billing it afterwards. A service whose billing had
 * not started yet is deleted outright — it never produced a charge to preserve.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A service can be attached while the plan still has billing ahead of it.
// 'cancelled'/'expired' assignments bill nothing further, so attaching a
// service to one would be a no-op the user could not see the effect of.
//
// #1108 §4: `draft` is in the list because Additional Products are part of what
// a Draft is for — they are added before the purchase is committed and they
// show up in its Billing Event Forecast. They bill nothing while the assignment
// is a Draft, because the nightly run reads `status = 'active'`.
const ATTACHABLE_STATUSES = ['draft', 'active', 'paused'];

const DUPLICATE_ERROR = 'This service is already attached to the Assigned Plan for that period';

// `products` is joined without a `deleted_at` filter on purpose: an item
// that is retired after being attached must keep billing and keep displaying
// (the FK has no ON DELETE CASCADE for the same reason). Its retired state is
// reported on the row instead, so the UI can flag it.
const SELECT = `
  SELECT ums.id, ums.gym_id, um.id AS user_membership_id, ums.product_id,
         ums.quantity, ums.starts_at, ums.ends_at, ums.created_at,
         ums.item_name AS snapshot_item_name,
         ums.item_billing_frequency AS snapshot_billing_frequency,
         ums.unit_price AS snapshot_unit_price,
         ums.currency AS snapshot_currency,
         gc.name AS product_name,
         gc.type AS product_type,
         gc.status AS product_status,
         gc.deleted_at AS product_deleted_at,
         gc.billing_frequency,
         gc.amount AS unit_price,
         gc.currency
  FROM user_memberships um
  JOIN member_products_recurrent_snapshot ums
    ON ums.product_set_id = ${assignmentVersionId('um.id')} AND ums.gym_id = um.gym_id
  JOIN products gc ON gc.id = ums.product_id
`;

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts) —
// every date leaves this module as a plain YYYY-MM-DD string.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AssignedPlanServiceRow {
  id: number;
  user_membership_id: number;
  product_id: number;
  quantity: number;
  starts_at: string;
  ends_at: string | null;
  product_name: string;
  billing_frequency: ProductFrequency | null;
  unit_price: number;
  currency: string | null;
  /** False once the effective removal date has passed — kept for the billing history. */
  active: boolean;
  /**
   * The underlying Product has been retired (soft-deleted or made
   * inactive) since it was attached. It still bills — the attachment owns the
   * window, not the catalogue — but POST would no longer accept it, so the UI
   * flags it rather than presenting it as an ordinary item.
   */
  product_retired: boolean;
  /**
   * #635 — what the Product cost when the service was attached
   * (migration 174). `null` for an attachment made before that migration, which
   * is the caller's signal to keep using the live values above. Since stage 3
   * the Billing Simulation bills from this; the live values are served beside
   * it so the UI can still show that the item has been repriced since.
   */
  snapshot: {
    item_name: string;
    billing_frequency: ProductFrequency | null;
    unit_price: number;
    currency: string | null;
  } | null;
}

function shape(row: any): AssignedPlanServiceRow {
  const endsAt = row.ends_at != null ? toDateOnly(row.ends_at) : null;
  return {
    id: row.id,
    user_membership_id: row.user_membership_id,
    product_id: row.product_id,
    quantity: Number(row.quantity),
    starts_at: toDateOnly(row.starts_at),
    ends_at: endsAt,
    product_name: row.product_name,
    billing_frequency: (row.billing_frequency ?? null) as ProductFrequency | null,
    unit_price: row.unit_price != null ? Number(row.unit_price) : 0,
    currency: row.currency ?? null,
    active: endsAt == null || endsAt >= todayISO(),
    product_retired: row.product_deleted_at != null || row.product_status !== 'active',
    snapshot: row.snapshot_unit_price != null ? {
      item_name: row.snapshot_item_name,
      billing_frequency: (row.snapshot_billing_frequency ?? null) as ProductFrequency | null,
      unit_price: Number(row.snapshot_unit_price),
      currency: row.snapshot_currency ?? null,
    } : null,
  };
}

/** Every service attached to one Assigned Plan, oldest window first. */
export async function loadAssignedPlanServices(gymId: string, umId: number): Promise<AssignedPlanServiceRow[]> {
  const { rows } = await db.query(
    `${SELECT} WHERE ums.gym_id = ? AND um.id = ? ORDER BY ums.starts_at ASC, ums.id ASC`,
    [gymId, umId],
  );
  return rows.map(shape);
}

/**
 * The same rows for several Assigned Plans in one query, flat and oldest
 * window first. Used by the Member-level ADDITIONAL SERVICES section (#634
 * §4), which lists every service the Member pays for across all of their
 * Membership Plans rather than one plan at a time.
 */
export async function loadServicesForAssignments(
  gymId: string, umIds: number[],
): Promise<AssignedPlanServiceRow[]> {
  if (umIds.length === 0) return [];
  const { rows } = await db.query(
    `${SELECT} WHERE ums.gym_id = ? AND um.id IN (${umIds.map(() => '?').join(',')})
     ORDER BY ums.starts_at ASC, ums.id ASC`,
    [gymId, ...umIds],
  );
  return rows.map(shape);
}

/**
 * The same rows, grouped per Assigned Plan and mapped onto the Billing
 * Simulation engine's input — one query for every assignment the simulation
 * covers, rather than one per assignment.
 *
 * #635 stage 3: the name, price and billing frequency come from the snapshot
 * taken when the service was attached (§11, §17), so repricing the Product
 * Item leaves every assignment already paying for it alone. A row attached
 * before migration 174 has no snapshot and keeps resolving live — which is
 * what it has always done. The rows the *UI* renders still show both (`snapshot`
 * alongside the live values), so a repriced item is still visible as such.
 */
export async function loadServicesForSimulation(
  gymId: string, umIds: number[],
): Promise<Map<number, SimulationService[]>> {
  const byAssignment = new Map<number, SimulationService[]>();
  if (umIds.length === 0) return byAssignment;

  const { rows } = await db.query(
    `${SELECT} WHERE ums.gym_id = ? AND um.id IN (${umIds.map(() => '?').join(',')})
     ORDER BY ums.starts_at ASC, ums.id ASC`,
    [gymId, ...umIds],
  );
  for (const row of rows) {
    const shaped = shape(row);
    const list = byAssignment.get(shaped.user_membership_id) ?? [];
    // Either the whole snapshot or none of it: a snapshot that recorded "no
    // billing frequency" must not silently pick the item's current one up.
    const priced = shaped.snapshot ?? {
      item_name: shaped.product_name,
      billing_frequency: shaped.billing_frequency,
      unit_price: shaped.unit_price,
    };
    list.push({
      id: shaped.id,
      productId: shaped.product_id,
      name: priced.item_name,
      billingFrequency: priced.billing_frequency,
      unitPrice: priced.unit_price,
      quantity: shaped.quantity,
      startsOn: shaped.starts_at,
      endsOn: shaped.ends_at,
    });
    byAssignment.set(shaped.user_membership_id, list);
  }
  return byAssignment;
}

export const userMembershipServicesRouter = Router({ mergeParams: true });

interface AssignedPlan {
  id: number;
  status: string;
  starts_at: string;
  ends_at: string | null;
}

async function loadAssignedPlan(gymId: string, id: unknown): Promise<AssignedPlan | null> {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const { rows } = await db.query(
    'SELECT id, status, starts_at, ends_at FROM user_memberships WHERE id = ? AND gym_id = ?',
    [numeric, gymId],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    status: rows[0].status,
    starts_at: toDateOnly(rows[0].starts_at),
    ends_at: rows[0].ends_at != null ? toDateOnly(rows[0].ends_at) : null,
  };
}

userMembershipServicesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const plan = await loadAssignedPlan(gymId, (req.params as any).id);
  if (!plan) return res.status(404).json({ error: 'Membership not found' });
  res.json(await loadAssignedPlanServices(gymId, plan.id));
});

userMembershipServicesRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  if (await redirectEditToProductSet(req, res, {
    userMembershipId: Number((req.params as any).id), action: 'update', detail: { add_service: req.body },
    mutate: async (tx, d) => { const r = await psAddService(tx, d, req.body, { legacy: true }); return 'kind' in r ? r : { ok: true as const }; },
    // The route's own contract is the attachment it created, not the list.
    respond: async () => {
      const list = await loadAssignedPlanServices(gymId, Number((req.params as any).id));
      const mine = list.filter((r: any) => Number(r.product_id) === Number(req.body?.product_id));
      return mine[mine.length - 1] ?? list[list.length - 1];
    },
    status: 201,
  })) return;
  const plan = await loadAssignedPlan(gymId, (req.params as any).id);
  if (!plan) return res.status(404).json({ error: 'Membership not found' });
  if (!ATTACHABLE_STATUSES.includes(plan.status)) {
    return res.status(409).json({ error: 'Services cannot be added to a cancelled or expired Assigned Plan' });
  }

  // #1325 PR 3e-4a: the attachment is the version's (above); a plan whose
  // version takes no edit (awaiting payment) answers here.
  return res.status(409).json({ error: 'Services cannot be added to a membership awaiting payment' });
});

/**
 * #631 §3 — future-only removal. A service that is already being billed keeps
 * every charge up to today and stops afterwards (`ends_at = today`); one whose
 * billing has not started yet is deleted, since an `ends_at` before `starts_at`
 * would be meaningless (and violates chk_ums_ends_at).
 */
userMembershipServicesRouter.delete('/:serviceId', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const serviceId = Number(req.params.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return res.status(400).json({ error: 'serviceId must be a positive integer' });
  }
  let removed: { deleted: boolean; ends_at: string | null } = { deleted: false, ends_at: null };
  if (await redirectEditToProductSet(req, res, {
    userMembershipId: Number((req.params as any).id), action: 'update', detail: { remove_service: req.params.serviceId },
    // The service id on the screen is the current version's row; the version
    // being edited carries its own copy of it (cloned with the configuration),
    // found by Product and start date, so the removal is addressed by that.
    mutate: async (tx, d) => {
      const { rows } = await tx.query<{ product_id: number; starts_at: string }>(
        'SELECT product_id, starts_at FROM member_products_recurrent_snapshot WHERE id = ? AND gym_id = ?', [serviceId, d.gym_id]);
      if (!rows[0]) return { kind: 'not_found' as const };
      const { rows: own } = await tx.query<{ id: number }>(
        `SELECT id FROM member_products_recurrent_snapshot
          WHERE gym_id = ? AND product_set_id = ? AND product_id = ? AND starts_at <=> ?
          ORDER BY id DESC LIMIT 1`,
        [d.gym_id, d.id, rows[0].product_id, rows[0].starts_at]);
      if (!own[0]) return { kind: 'not_found' as const };
      const out = await psRemoveService(tx, d, Number(own[0].id), { legacy: true });
      if ('kind' in out) return out;
      removed = { deleted: out.deleted, ends_at: out.ends_at };
      return { ok: true as const };
    },
    respond: async () => ({ id: serviceId, deleted: removed.deleted, ends_at: removed.ends_at }),
  })) return;
  const plan = await loadAssignedPlan(gymId, (req.params as any).id);
  if (!plan) return res.status(404).json({ error: 'Membership not found' });
  return res.status(409).json({ error: 'Services cannot be removed from a membership that is closed or awaiting payment' });
});
