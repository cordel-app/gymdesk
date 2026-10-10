import { db, Tx } from '../infra/db';
import { toPersonalFeeBenefit } from '../domain/personalFeeBenefit';
import { toPlanDuration, toPlanDurationCadence, toPlanDurationRepeats } from '../domain/planDuration';
import { toProductBenefit } from '../domain/productBenefitActions';
import { toSessionBenefitFrequency } from '../domain/sessionBenefitFrequency';
import {
  BillingUnit, ProductFrequency, SimulationAssignment, SimulationLine, SimulationPlanBenefit,
  SimulationService, computeBillingSimulation,
} from '../domain/billingSimulation';
import { ProductBenefitCategory, planBenefitTableForCategory } from '../domain/productClassification';
import { BillingEventLineRow, linesMatchTotal, linesTotal, lineFromSimulation } from '../domain/billingEventLines';
import { PLAN_SCHEDULE_KEY, allocateSchedule, cadenceForFrequency, type ExistingSchedule } from '../domain/scheduleAllocation';
import { loadPromotionApplicationsForSets } from './user-memberships';
import { loadPromotionGrantSnapshots } from './assigned-plan-snapshot';
import { activate, MoveOutcome } from './product-sets';
import { projectActiveProductSet } from './product-set-projection';

/**
 * #1325 PR 2b — a ProductSet version's configuration, the engine's input built
 * from it, and the persisted Scheduled Billing Events generated from that input.
 *
 * Nothing here prices anything: the loader hands the existing
 * `computeBillingSimulation()` the same `SimulationAssignment` shape the
 * assignment-keyed loader does, and the events and lines persisted are that
 * engine's own output. The only difference is *ownership*: every row read is the
 * version's own (`product_set_id`), so an earlier version is never read through
 * a later one and a catalogue edit moves nothing already frozen.
 *
 * The live nightly run does not call any of this yet (2c).
 */

const CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];
const BENEFIT_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'user_membership_session',
  oneoff: 'user_membership_oneoff',
  periodical: 'user_membership_periodical',
};

const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

const toDateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/* ── Schedules ───────────────────────────────────────────────────────────── */

/**
 * The schedule `(root, key)`, created on first use and **never re-anchored**:
 * schedule identity is stable across the versions of a chain, so a new version
 * finds the row its predecessor made and keeps billing on the same dates.
 */
export async function ensureSchedule(tx: Tx, input: {
  gymId: string; rootProductSetId: number; key: string; anchorDate: string;
  cadenceInterval: number; cadenceUnit: string;
}): Promise<number> {
  await tx.query(
    `INSERT IGNORE INTO product_set_schedules
       (gym_id, root_product_set_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.gymId, input.rootProductSetId, input.key, input.anchorDate, input.cadenceInterval, input.cadenceUnit],
  );
  const { rows } = await tx.query<{ id: number }>(
    `SELECT id FROM product_set_schedules WHERE root_product_set_id = ? AND schedule_key = ?`,
    [input.rootProductSetId, input.key],
  );
  return Number(rows[0].id);
}

/* ── Writing a version's configuration ───────────────────────────────────── */

/**
 * Freezes a Membership Plan's configuration onto a ProductSet version: the plan
 * snapshot (fee, Billing & Duration, auto renew), the `plan` schedule carrying
 * the plan's cadence, and a copy of each benefit line keyed to the version. The
 * statement shapes mirror `snapshotAssignedPlan()`'s, so a line carries the same
 * frozen name, type, price, treatment and mandatory flag.
 */
export async function snapshotProductSetFromPlan(tx: Tx, input: {
  gymId: string;
  productSetId: number;
  membershipPlanId: number;
  membershipFeePrice: number | null;
  startsAt: string;
  declinedBenefits?: Array<{ section: string; product_id: number }>;
}): Promise<void> {
  const { gymId, productSetId, membershipPlanId } = input;
  const { rows: setRows } = await tx.query<{ root_product_set_id: number | null }>(
    'SELECT root_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  if (!setRows[0]) throw new Error('ProductSet not found');
  const rootId = Number(setRows[0].root_product_set_id ?? productSetId);

  const { rows: planRows } = await tx.query(
    `SELECT p.free_periods, p.paid_periods, p.bonus_periods, p.pay_beforehand_periods,
            bp.recurring_billing_interval, bp.recurring_billing_unit, bp.auto_renew
       FROM membership_plans p
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = p.gym_id
      WHERE p.id = ? AND p.gym_id = ?`,
    [membershipPlanId, gymId],
  );
  const plan = planRows[0] ?? {};

  let scheduleId: number | null = null;
  if (plan.recurring_billing_interval != null && plan.recurring_billing_unit != null) {
    scheduleId = await ensureSchedule(tx, {
      gymId, rootProductSetId: rootId, key: PLAN_SCHEDULE_KEY, anchorDate: input.startsAt,
      cadenceInterval: Number(plan.recurring_billing_interval), cadenceUnit: String(plan.recurring_billing_unit),
    });
  }

  await tx.query(
    `INSERT INTO product_set_plan_snapshots
       (gym_id, product_set_id, schedule_id, membership_fee_price,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods, auto_renew)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE schedule_id = VALUES(schedule_id), membership_fee_price = VALUES(membership_fee_price),
       free_periods = VALUES(free_periods), paid_periods = VALUES(paid_periods),
       bonus_periods = VALUES(bonus_periods), pay_beforehand_periods = VALUES(pay_beforehand_periods),
       auto_renew = VALUES(auto_renew)`,
    [
      gymId, productSetId, scheduleId, input.membershipFeePrice ?? null,
      plan.free_periods ?? null, plan.paid_periods ?? null, plan.bonus_periods ?? null,
      plan.pay_beforehand_periods ?? null,
      toPlanDurationRepeats(plan.auto_renew ?? false) ? 1 : 0,
    ],
  );

  for (const category of CATEGORIES) {
    const target = BENEFIT_TABLE[category];
    const source = planBenefitTableForCategory(category);
    const sessionFrequency = category === 'session';
    const declined = (input.declinedBenefits ?? [])
      .filter((d) => d.section === category).map((d) => d.product_id);
    const declinedClause = declined.length > 0
      ? `AND b.product_id NOT IN (${declined.map(() => '?').join(',')})` : '';
    // A recurring line of the plan's own cadence joins the `plan` schedule; any
    // other cadence is allocated its own schedule by the writer that adds the
    // item (`allocateSchedule()`), so this copy leaves `schedule_id` NULL and the
    // generator treats a NULL as the plan schedule.
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, product_set_id, product_id, quantity,
          item_name, item_type, item_billing_frequency, unit_price, currency, \`action\`, \`value\`,
          mandatory${sessionFrequency ? ', frequency' : ''})
       SELECT ?, ?, b.product_id, b.quantity,
              ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
              gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency,
              b.\`action\`, b.\`value\`, b.mandatory${sessionFrequency ? ', b.frequency' : ''}
         FROM ${source} b
         JOIN products gc ON gc.id = b.product_id
         LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
        WHERE b.membership_plan_id = ? AND b.gym_id = ? ${declinedClause}`,
      [gymId, productSetId, membershipPlanId, gymId, ...declined],
    );
  }
  await allocateItemSchedules(tx, gymId, productSetId);
}


/**
 * Gives every recurring item of a version a schedule (Q8, one rule): an item on
 * the plan's cadence joins the `plan` schedule, one matching another item's
 * cadence joins that schedule, anything else opens an independent schedule
 * anchored on its own start. Items that already have one are left alone, so
 * running it twice — or after a version is cloned — changes nothing.
 */
export async function allocateItemSchedules(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  const { rows: setRows } = await tx.query<any>(
    'SELECT root_product_set_id, starts_at FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  if (!setRows[0]) return;
  const rootId = Number(setRows[0].root_product_set_id ?? productSetId);
  const setStart = toDateOnly(setRows[0].starts_at);

  const { rows: sched } = await tx.query<any>(
    `SELECT id, schedule_key, anchor_date, cadence_interval, cadence_unit
       FROM product_set_schedules WHERE root_product_set_id = ?`, [rootId]);
  const schedules: ExistingSchedule[] = sched.map((r: any) => ({
    id: Number(r.id), key: String(r.schedule_key), anchorDate: toDateOnly(r.anchor_date),
    cadence: { interval: Number(r.cadence_interval), unit: r.cadence_unit },
  }));

  for (const table of ['user_membership_periodical', 'user_membership_services'] as const) {
    const { rows } = await tx.query<any>(
      `SELECT id, item_billing_frequency${table === 'user_membership_services' ? ', starts_at' : ''}
         FROM ${table} WHERE gym_id = ? AND product_set_id = ? AND schedule_id IS NULL`,
      [gymId, productSetId]);
    for (const row of rows) {
      const cadence = cadenceForFrequency(row.item_billing_frequency);
      if (!cadence) continue;
      const purchaseDate = row.starts_at ? toDateOnly(row.starts_at) : setStart;
      const allocation = allocateSchedule({ cadence, purchaseDate, schedules });
      let scheduleId: number | null = null;
      if (allocation.kind === 'new') {
        scheduleId = await ensureSchedule(tx, {
          gymId, rootProductSetId: rootId, key: allocation.key, anchorDate: allocation.anchorDate,
          cadenceInterval: cadence.interval, cadenceUnit: cadence.unit,
        });
        schedules.push({ id: scheduleId, key: allocation.key, anchorDate: allocation.anchorDate, cadence });
      } else {
        scheduleId = schedules.find((s) => s.key === allocation.key)?.id ?? null;
      }
      if (scheduleId != null) {
        await tx.query(`UPDATE ${table} SET schedule_id = ? WHERE id = ?`, [scheduleId, row.id]);
      }
    }
  }
}

/** Adds a recurring Additional Product to a version, on its own schedule. */
export async function addProductSetService(tx: Tx, input: {
  gymId: string; productSetId: number; productId: number; quantity: number;
  startsAt: string; scheduleId: number | null;
}): Promise<number> {
  const { insertId } = await tx.query(
    `INSERT INTO user_membership_services
       (gym_id, product_set_id, product_id, quantity, starts_at,
        item_name, item_type, unit_price, item_billing_frequency, currency, schedule_id)
     SELECT ?, ?, gc.id, ?, ?, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
            COALESCE(gc.amount, 0), gc.billing_frequency, gc.currency, ?
       FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE gc.id = ? AND gc.gym_id = ?`,
    [input.gymId, input.productSetId, input.quantity, input.startsAt, input.scheduleId, input.productId, input.gymId],
  );
  return insertId;
}

/* ── Reading it back for the engine ──────────────────────────────────────── */

type Exec = { query: typeof db.query };

/**
 * `exec` is the transaction a version was written in, when it is read back
 * before that transaction commits (an assignment imported at commit); otherwise
 * the pool.
 */
export async function loadProductSetSimulationAssignment(
  gymId: string, productSetId: number, exec: Exec = db,
): Promise<SimulationAssignment | null> {
  const { rows } = await exec.query(
    `SELECT ps.id, ps.owner_member_id, ps.membership_plan_id, ps.starts_at, ps.ends_at,
            mp.name AS plan_name,
            snap.membership_fee_price, snap.free_periods, snap.paid_periods, snap.bonus_periods,
            snap.pay_beforehand_periods, snap.auto_renew,
            snap.personal_fee_benefit_action, snap.personal_fee_benefit_value,
            sch.cadence_interval, sch.cadence_unit
       FROM product_sets ps
       LEFT JOIN membership_plans mp ON mp.id = ps.membership_plan_id
       LEFT JOIN product_set_plan_snapshots snap ON snap.product_set_id = ps.id
       LEFT JOIN product_set_schedules sch ON sch.id = snap.schedule_id
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [productSetId, gymId],
  );
  const row = rows[0];
  if (!row) return null;

  const applications = ((await loadPromotionApplicationsForSets(gymId, [productSetId], exec)).get(productSetId) ?? [])
    .filter((a) => a.status === 'applied');
  const grants = await loadPromotionGrantSnapshots(gymId, applications.map((a) => a.id), exec);

  const cadence = toPlanDurationCadence(row.cadence_interval, row.cadence_unit);
  const startsAt = toDateOnly(row.starts_at);

  const { rows: benefitRows } = await exec.query(
    CATEGORIES.map((category) => `
      SELECT '${category}' AS category, product_id, quantity, item_name, item_billing_frequency,
             unit_price, \`action\`, \`value\`,
             ${category === 'session' ? 'frequency' : 'NULL'} AS session_frequency
        FROM ${BENEFIT_TABLE[category]} WHERE gym_id = ? AND product_set_id = ?`).join(' UNION ALL '),
    CATEGORIES.flatMap(() => [gymId, productSetId]),
  );
  const planBenefits: SimulationPlanBenefit[] = (benefitRows as any[]).map((b) => ({
    productId: b.product_id,
    name: b.item_name,
    category: b.category as ProductBenefitCategory,
    billingFrequency: (b.item_billing_frequency ?? null) as ProductFrequency | null,
    unitPrice: b.unit_price != null ? Number(b.unit_price) : 0,
    quantity: Math.max(1, Math.trunc(Number(b.quantity)) || 1),
    sessionFrequency: toSessionBenefitFrequency(b.session_frequency),
    benefit: toProductBenefit('plan', b.action, b.value),
  }));

  const { rows: serviceRows } = await exec.query(
    `SELECT id, product_id, quantity, starts_at, ends_at, item_name, item_billing_frequency, unit_price
       FROM user_membership_services WHERE gym_id = ? AND product_set_id = ?
      ORDER BY starts_at ASC, id ASC`,
    [gymId, productSetId],
  );
  const services: SimulationService[] = (serviceRows as any[]).map((s) => ({
    id: s.id,
    productId: s.product_id,
    name: s.item_name,
    billingFrequency: (s.item_billing_frequency ?? null) as ProductFrequency | null,
    unitPrice: s.unit_price != null ? Number(s.unit_price) : 0,
    quantity: Math.max(1, Math.trunc(Number(s.quantity)) || 1),
    startsOn: toDateOnly(s.starts_at),
    endsOn: s.ends_at != null ? toDateOnly(s.ends_at) : null,
  }));

  return {
    // The engine's identifier for the contract; a ProductSet has no assignment,
    // so its own id stands in (it only labels lines).
    userMembershipId: Number(row.id),
    planName: row.plan_name ?? null,
    startsAt,
    endsAt: row.ends_at != null ? toDateOnly(row.ends_at) : null,
    membershipFeePrice: row.membership_fee_price != null ? Number(row.membership_fee_price) : null,
    recurringInterval: row.cadence_interval != null ? Number(row.cadence_interval) : null,
    recurringUnit: (row.cadence_unit ?? null) as BillingUnit | null,
    promotions: applications.map((a) => ({
      name: a.name,
      appliedAt: a.appliedAt,
      revokedAt: a.revokedAt,
      freeMonths: a.freeMonths,
      paidMonths: a.paidMonths,
      payBeforehandMonths: a.payBeforehandMonths,
      bonusMonths: a.bonusMonths,
      membershipFeeBenefits: a.membershipFeeBenefits,
      grants: grants.get(a.id) ?? [],
    })),
    services,
    planBenefits,
    planDuration: toPlanDuration(
      row.free_periods, row.paid_periods, row.bonus_periods, row.pay_beforehand_periods,
      cadence, row.auto_renew,
    ),
    personalFeeBenefit: toPersonalFeeBenefit(row.personal_fee_benefit_action, row.personal_fee_benefit_value),
  };
}

/* ── Generating the persisted obligations ────────────────────────────────── */

/** Coverage cap at commit time (Q1): never more than two cycles per schedule. */
export const MAX_COVERED_CYCLES = 2;

interface PlannedEvent {
  scheduleKey: string | null;
  date: string;
  periodEnd: string | null;
  lines: SimulationLine[];
}

/**
 * The events the engine projects for this version from `from` on, grouped by the
 * schedule that owns each line: the Membership Fee and every line on the plan's
 * cadence belong to `plan`; a recurring service takes its own schedule's key; a
 * one-off belongs to no schedule (`null`). At most `cycles` future dates are kept
 * per schedule.
 */
export async function planScheduledEvents(
  gymId: string, productSetId: number, from: string, cycles: number = MAX_COVERED_CYCLES,
  exec: Exec = db,
): Promise<PlannedEvent[]> {
  const assignment = await loadProductSetSimulationAssignment(gymId, productSetId, exec);
  if (!assignment) return [];
  const result = computeBillingSimulation({ assignments: [assignment], horizonFrom: from, minimumCycles: cycles });
  if (!result.available) return [];

  const { rows: scheduled } = await exec.query(
    `SELECT s.product_id, sch.schedule_key
       FROM user_membership_services s JOIN product_set_schedules sch ON sch.id = s.schedule_id
      WHERE s.gym_id = ? AND s.product_set_id = ?
     UNION
     SELECT p.product_id, sch.schedule_key
       FROM user_membership_periodical p JOIN product_set_schedules sch ON sch.id = p.schedule_id
      WHERE p.gym_id = ? AND p.product_set_id = ?`,
    [gymId, productSetId, gymId, productSetId],
  );
  const keyByProduct = new Map<number, string>((scheduled as any[]).map((r) => [Number(r.product_id), String(r.schedule_key)]));
  const planCadence = assignment.recurringInterval != null && assignment.recurringUnit != null
    ? { interval: assignment.recurringInterval, unit: assignment.recurringUnit } : null;
  const hasPlanSchedule = planCadence != null;

  const buckets = new Map<string, PlannedEvent>();
  for (const section of result.sections) {
    for (const event of section.events) {
      if (event.date < from) continue;
      for (const line of event.lines) {
        let key: string | null;
        if (line.kind === 'membership_fee') key = hasPlanSchedule ? PLAN_SCHEDULE_KEY : null;
        else if (line.product_id != null && keyByProduct.has(line.product_id)) key = keyByProduct.get(line.product_id)!;
        else if (section.section === 'one_off' || section.section === 'session' || section.section === 'other') key = null;
        else key = hasPlanSchedule && cadenceForFrequency(section.section) != null ? PLAN_SCHEDULE_KEY : null;
        const bucketKey = `${key ?? '~'}|${event.date}`;
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
          bucket = { scheduleKey: key, date: event.date, periodEnd: event.period_end, lines: [] };
          buckets.set(bucketKey, bucket);
        }
        bucket.lines.push(line);
      }
    }
  }

  // At most `cycles` dated events per schedule; one-offs are all kept.
  const perKey = new Map<string, number>();
  return [...buckets.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((e) => {
      if (e.scheduleKey === null) return true;
      const n = (perKey.get(e.scheduleKey) ?? 0) + 1;
      perKey.set(e.scheduleKey, n);
      return n <= cycles;
    });
}

/**
 * Persists the version's future obligations as `is_scheduled` Billing Events with
 * their lines. Idempotent: an obligation that already exists for the same
 * `(schedule, period)` — or, for a one-off, the same date — is left alone, so a
 * second call, a retry or a concurrent commit creates nothing twice
 * (`UNIQUE (schedule_id, period_start)` is the backstop).
 */
export async function materialiseScheduledEvents(tx: Tx, input: {
  gymId: string; productSetId: number; today: string; cycles?: number;
}): Promise<{ created: number }> {
  const { gymId, productSetId, today } = input;
  const { rows: setRows } = await tx.query<{ owner_member_id: number; root_product_set_id: number }>(
    'SELECT owner_member_id, root_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?',
    [productSetId, gymId]);
  if (!setRows[0]) return { created: 0 };
  const rootId = Number(setRows[0].root_product_set_id);

  const planned = await planScheduledEvents(gymId, productSetId, today, input.cycles, tx);
  const scheduleIds = new Map<string, number>();
  const { rows: schedules } = await tx.query<{ id: number; schedule_key: string }>(
    'SELECT id, schedule_key FROM product_set_schedules WHERE root_product_set_id = ?', [rootId]);
  for (const s of schedules) scheduleIds.set(String(s.schedule_key), Number(s.id));

  let created = 0;
  for (const event of planned) {
    const scheduleId = event.scheduleKey ? scheduleIds.get(event.scheduleKey) ?? null : null;
    const lines: BillingEventLineRow[] = event.lines.map((l) => lineFromSimulation(l));
    const amount = linesTotal(lines);
    if (!linesMatchTotal(lines, amount)) throw new Error('Billing event lines do not sum to the event amount');

    const { rows: existing } = scheduleId != null
      ? await tx.query(
        'SELECT id FROM billing_events WHERE schedule_id = ? AND period_start = ? FOR UPDATE', [scheduleId, event.date])
      : await tx.query(
        `SELECT id FROM billing_events
          WHERE product_set_id = ? AND schedule_id IS NULL AND billing_date = ? AND event_type = 'charge_created' FOR UPDATE`,
        [productSetId, event.date]);
    if (existing.length > 0) continue;

    const { insertId } = await tx.query(
      `INSERT INTO billing_events
         (gym_id, member_id, event_type, source, amount, product_set_id, schedule_id,
          period_start, period_end, billing_date, is_scheduled)
       VALUES (?, ?, 'charge_created', 'system', ?, ?, ?, ?, ?, ?, 1)`,
      [gymId, setRows[0].owner_member_id, amount, productSetId, scheduleId,
        event.date, event.periodEnd, event.date],
    );
    for (const l of lines) {
      await tx.query(
        `INSERT INTO billing_event_lines
           (gym_id, billing_event_id, kind, product_id, item_name, item_type, quantity, regular_unit_price,
            treatment_action, treatment_value, promotion_name, prorated_days, period_days,
            tax_rate_percent, tax_behavior, amount_excl_tax, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, insertId, l.kind, l.product_id, l.item_name, l.item_type, l.quantity, l.regular_unit_price,
          l.treatment_action, l.treatment_value, l.promotion_name, l.prorated_days, l.period_days,
          l.tax_rate_percent, l.tax_behavior, l.amount_excl_tax, l.amount],
      );
    }
    created += 1;
  }
  return { created };
}

/**
 * Removes the previous version's obsolete future obligations: scheduled, due
 * after `today`, and with no payment attempt of any kind. Past events, anything
 * attempted, paid, refunded or waived, and every `payment_requests` row are
 * untouched; lines go with their event by the FK.
 */
export async function replaceFutureScheduledEvents(tx: Tx, input: {
  gymId: string; previousProductSetId: number; today: string;
}): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM billing_events
      WHERE gym_id = ? AND product_set_id = ? AND is_scheduled = 1 AND billing_date > ?
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = billing_events.id)`,
    [input.gymId, input.previousProductSetId, input.today],
  );
  return rowCount;
}

/**
 * `draft | pending_payment → active` **with** its obligations: the previous
 * version is superseded, its obsolete future Scheduled events are deleted, and
 * the new version's are generated — in the caller's one transaction, so there is
 * no moment with the old events gone and the new ones missing, nor two sets of
 * future events at once. Idempotent: an already-active set only tops up.
 */
export async function activateWithEvents(tx: Tx, input: {
  gymId: string; productSetId: number; today: string; cycles?: number;
}): Promise<MoveOutcome & { eventsCreated?: number; eventsReplaced?: number }> {
  const { rows } = await tx.query<{ previous_product_set_id: number | null }>(
    'SELECT previous_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?',
    [input.productSetId, input.gymId]);
  const previousId = rows[0]?.previous_product_set_id != null ? Number(rows[0].previous_product_set_id) : null;

  const moved = await activate(tx, input.gymId, input.productSetId);
  if (moved.kind !== 'ok') return moved;

  let replaced = 0;
  if (previousId != null) {
    replaced = await replaceFutureScheduledEvents(tx, { gymId: input.gymId, previousProductSetId: previousId, today: input.today });
  }
  const { created } = await materialiseScheduledEvents(tx, {
    gymId: input.gymId, productSetId: input.productSetId, today: input.today, cycles: input.cycles,
  });
  // #1325 PR 3a: the operational assignment that access, eligibility and the
  // screens still read is a projection of this version, written here and only
  // here, in the same transaction as the activation.
  await projectActiveProductSet(tx, input.gymId, input.productSetId);
  return { ...moved, eventsCreated: created, eventsReplaced: replaced };
}

export type { SimulationLine };
