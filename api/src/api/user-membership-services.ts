import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { classifySellableItem } from '../domain/sellableItemClassification';
import { SimulationService, SellableItemFrequency } from '../domain/billingSimulation';

/**
 * #631 — Additional Periodic Services on an Assigned Plan.
 *
 * Recurring Sellable Items attached directly to a `user_memberships` row
 * (migration 164). They belong to the Assigned Plan, never to the Membership
 * Plan and never to a Promotion (#631 §4/§7): adding one changes nothing about
 * the Plan itself, and nothing here touches `promotion_*` or the Plan's
 * included benefits.
 *
 * The Sellable Item stays the source of truth for the price and the billing
 * frequency (#631 §2 — "use the existing Sellable Item definitions ... rather
 * than creating a new product/service model"), so those are read live from
 * `gym_charges` on every request instead of being copied onto the attachment.
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
const ATTACHABLE_STATUSES = ['draft', 'awaiting_payment', 'active', 'paused'];

const DUPLICATE_ERROR = 'This service is already attached to the Assigned Plan for that period';

// `gym_charges` is joined without a `deleted_at` filter on purpose: an item
// that is retired after being attached must keep billing and keep displaying
// (the FK has no ON DELETE CASCADE for the same reason). Its retired state is
// reported on the row instead, so the UI can flag it.
const SELECT = `
  SELECT ums.id, ums.gym_id, ums.user_membership_id, ums.gym_charge_id,
         ums.quantity, ums.starts_at, ums.ends_at, ums.created_at,
         ums.item_name AS snapshot_item_name,
         ums.item_billing_frequency AS snapshot_billing_frequency,
         ums.unit_price AS snapshot_unit_price,
         ums.currency AS snapshot_currency,
         gc.name AS sellable_item_name,
         gc.type AS sellable_item_type,
         gc.status AS sellable_item_status,
         gc.deleted_at AS sellable_item_deleted_at,
         gc.billing_frequency,
         gc.amount AS unit_price,
         gc.currency
  FROM user_membership_services ums
  JOIN gym_charges gc ON gc.id = ums.gym_charge_id
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
  gym_charge_id: number;
  quantity: number;
  starts_at: string;
  ends_at: string | null;
  sellable_item_name: string;
  billing_frequency: SellableItemFrequency | null;
  unit_price: number;
  currency: string | null;
  /** False once the effective removal date has passed — kept for the billing history. */
  active: boolean;
  /**
   * The underlying Sellable Item has been retired (soft-deleted or made
   * inactive) since it was attached. It still bills — the attachment owns the
   * window, not the catalogue — but POST would no longer accept it, so the UI
   * flags it rather than presenting it as an ordinary item.
   */
  sellable_item_retired: boolean;
  /**
   * #635 — what the Sellable Item cost when the service was attached
   * (migration 174). `null` for an attachment made before that migration, which
   * is the caller's signal to keep using the live values above. Since stage 3
   * the Billing Simulation bills from this; the live values are served beside
   * it so the UI can still show that the item has been repriced since.
   */
  snapshot: {
    item_name: string;
    billing_frequency: SellableItemFrequency | null;
    unit_price: number;
    currency: string | null;
  } | null;
}

function shape(row: any): AssignedPlanServiceRow {
  const endsAt = row.ends_at != null ? toDateOnly(row.ends_at) : null;
  return {
    id: row.id,
    user_membership_id: row.user_membership_id,
    gym_charge_id: row.gym_charge_id,
    quantity: Number(row.quantity),
    starts_at: toDateOnly(row.starts_at),
    ends_at: endsAt,
    sellable_item_name: row.sellable_item_name,
    billing_frequency: (row.billing_frequency ?? null) as SellableItemFrequency | null,
    unit_price: row.unit_price != null ? Number(row.unit_price) : 0,
    currency: row.currency ?? null,
    active: endsAt == null || endsAt >= todayISO(),
    sellable_item_retired: row.sellable_item_deleted_at != null || row.sellable_item_status !== 'active',
    snapshot: row.snapshot_unit_price != null ? {
      item_name: row.snapshot_item_name,
      billing_frequency: (row.snapshot_billing_frequency ?? null) as SellableItemFrequency | null,
      unit_price: Number(row.snapshot_unit_price),
      currency: row.snapshot_currency ?? null,
    } : null,
  };
}

/** Every service attached to one Assigned Plan, oldest window first. */
export async function loadAssignedPlanServices(gymId: string, umId: number): Promise<AssignedPlanServiceRow[]> {
  const { rows } = await db.query(
    `${SELECT} WHERE ums.gym_id = ? AND ums.user_membership_id = ? ORDER BY ums.starts_at ASC, ums.id ASC`,
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
    `${SELECT} WHERE ums.gym_id = ? AND ums.user_membership_id IN (${umIds.map(() => '?').join(',')})
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
 * taken when the service was attached (§11, §17), so repricing the Sellable
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
    `${SELECT} WHERE ums.gym_id = ? AND ums.user_membership_id IN (${umIds.map(() => '?').join(',')})
     ORDER BY ums.starts_at ASC, ums.id ASC`,
    [gymId, ...umIds],
  );
  for (const row of rows) {
    const shaped = shape(row);
    const list = byAssignment.get(shaped.user_membership_id) ?? [];
    // Either the whole snapshot or none of it: a snapshot that recorded "no
    // billing frequency" must not silently pick the item's current one up.
    const priced = shaped.snapshot ?? {
      item_name: shaped.sellable_item_name,
      billing_frequency: shaped.billing_frequency,
      unit_price: shaped.unit_price,
    };
    list.push({
      id: shaped.id,
      gymChargeId: shaped.gym_charge_id,
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
  const plan = await loadAssignedPlan(gymId, (req.params as any).id);
  if (!plan) return res.status(404).json({ error: 'Membership not found' });
  if (!ATTACHABLE_STATUSES.includes(plan.status)) {
    return res.status(409).json({ error: 'Services cannot be added to a cancelled or expired Assigned Plan' });
  }

  const { gym_charge_id, quantity, starts_at } = req.body ?? {};

  const chargeId = Number(gym_charge_id);
  if (!Number.isInteger(chargeId) || chargeId <= 0) {
    return res.status(400).json({ error: 'gym_charge_id must be a positive integer' });
  }

  const parsedQuantity = quantity === undefined || quantity === null || quantity === '' ? 1 : Number(quantity);
  if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }

  // Default: today, or the plan's start date when the plan hasn't started yet —
  // a service can never be billed before the assignment it belongs to.
  const startsAt = starts_at ? String(starts_at) : (todayISO() > plan.starts_at ? todayISO() : plan.starts_at);
  if (!DATE_RE.test(startsAt)) {
    return res.status(400).json({ error: 'starts_at must be YYYY-MM-DD' });
  }
  if (startsAt < plan.starts_at) {
    return res.status(400).json({ error: 'starts_at cannot be earlier than the Assigned Plan start date' });
  }
  if (plan.ends_at != null && startsAt > plan.ends_at) {
    return res.status(400).json({ error: 'starts_at cannot be later than the Assigned Plan end date' });
  }

  // `gc.name` is nullable — a system charge displays under its `charge_types`
  // name — so it is resolved here the way every other reader resolves it,
  // rather than snapshotting a NULL below.
  const { rows: itemRows } = await db.query(
    `SELECT gc.id, COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id)) AS name,
            gc.type, gc.status, gc.billing_frequency, gc.amount, gc.currency
     FROM gym_charges gc
     LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE gc.id = ? AND gc.gym_id = ? AND gc.deleted_at IS NULL`,
    [chargeId, gymId],
  );
  if (itemRows.length === 0) return res.status(404).json({ error: 'Sellable Item not found' });
  const item = itemRows[0];
  if (item.status !== 'active') {
    return res.status(400).json({ error: 'Sellable Item is not active' });
  }
  // #631 §2: only recurring/periodic services are attachable. `classifySellableItem`
  // is the single source of truth for that rule (#550) — never re-derived here.
  if (classifySellableItem(item) !== 'periodical') {
    return res.status(400).json({ error: 'Only recurring Sellable Items can be added as periodic services' });
  }

  // The same item may be attached again after an earlier stint ended, but not
  // while one is still running (that is what `quantity` is for). The open case
  // is additionally enforced by the `ums_one_open_per_item` unique index, which
  // is what makes two simultaneous POSTs safe; this check also covers a closed
  // window that still ends on or after the requested start date.
  const { rows: overlapping } = await db.query(
    `SELECT id FROM user_membership_services
     WHERE gym_id = ? AND user_membership_id = ? AND gym_charge_id = ?
       AND (ends_at IS NULL OR ends_at >= ?)`,
    [gymId, plan.id, chargeId, startsAt],
  );
  if (overlapping.length > 0) {
    return res.status(409).json({ error: DUPLICATE_ERROR });
  }

  let insertId: number;
  try {
    ({ insertId } = await db.query(
      // #635 (migration 174): the item's commercial facts are frozen onto the
      // attachment as well as read live. §17 — repricing the Sellable Item
      // must not move what an already-attached service costs, which is what
      // the Billing Simulation reads since stage 3; the live join below still
      // drives display, so the UI can flag an item that has changed.
      `INSERT INTO user_membership_services
       (gym_id, user_membership_id, gym_charge_id, quantity, starts_at, created_by_membership_id,
        item_name, item_type, item_billing_frequency, unit_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, plan.id, chargeId, parsedQuantity, startsAt, gymMembershipId ?? null,
        item.name, item.type ?? 'other', item.billing_frequency ?? null,
        item.amount != null ? item.amount : 0, item.currency ?? null,
      ],
    ));
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: DUPLICATE_ERROR });
    throw err;
  }

  const { rows } = await db.query(`${SELECT} WHERE ums.id = ? AND ums.gym_id = ?`, [insertId, gymId]);
  const created = shape(rows[0]);
  recordAudit(req, {
    action: 'add_service',
    entityType: 'user_membership',
    entityId: plan.id,
    next: { gym_charge_id: chargeId, sellable_item: item.name, quantity: parsedQuantity, starts_at: startsAt },
  });
  res.status(201).json(created);
});

/**
 * #631 §3 — future-only removal. A service that is already being billed keeps
 * every charge up to today and stops afterwards (`ends_at = today`); one whose
 * billing has not started yet is deleted, since an `ends_at` before `starts_at`
 * would be meaningless (and violates chk_ums_ends_at).
 */
userMembershipServicesRouter.delete('/:serviceId', requireModuleWrite('PAYMENTS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const plan = await loadAssignedPlan(gymId, (req.params as any).id);
  if (!plan) return res.status(404).json({ error: 'Membership not found' });

  const serviceId = Number(req.params.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return res.status(400).json({ error: 'serviceId must be a positive integer' });
  }

  const { rows } = await db.query(`${SELECT} WHERE ums.id = ? AND ums.gym_id = ? AND ums.user_membership_id = ?`,
    [serviceId, gymId, plan.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Service not found' });
  const service = shape(rows[0]);
  if (service.ends_at != null) {
    return res.status(409).json({ error: 'Service has already been removed' });
  }

  const today = todayISO();
  const deleted = service.starts_at > today;
  if (deleted) {
    await db.query('DELETE FROM user_membership_services WHERE id = ? AND gym_id = ?', [serviceId, gymId]);
  } else {
    await db.query(
      'UPDATE user_membership_services SET ends_at = ? WHERE id = ? AND gym_id = ?',
      [today, serviceId, gymId],
    );
  }

  recordAudit(req, {
    action: 'remove_service',
    entityType: 'user_membership',
    entityId: plan.id,
    previous: { gym_charge_id: service.gym_charge_id, sellable_item: service.sellable_item_name, starts_at: service.starts_at },
    next: deleted ? null : { ends_at: today },
  });
  res.json({ id: serviceId, deleted, ends_at: deleted ? null : today });
});
