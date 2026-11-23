import supertest from 'supertest';
import { anchorHandAssignment } from './handAnchor';
import { legacyProductInsert } from './legacyProductFixture';
import { app } from '../app';
import { db } from '../infra/db';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import { fixtureAssignments, handRow, mirrorLegacyLifecycle, splitTopLevel, testAssignmentWrite } from './assignmentFixture';
import { ASSIGNMENT_BENEFICIARIES } from '../domain/assignmentBeneficiaries';
import { assignmentOfLegacyIdSql, productSetOfLegacyAssignmentSql, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';


export const request = supertest(app);

// Must match the `sub` returned by the mocked verifyToken in setup.ts
export const TEST_USER_ID = 'test-user-id';

// Any non-empty string is accepted by the mocked verifyToken
export const TEST_AUTH_HEADER = 'Bearer test-token';

// Track gym IDs per worker so concurrent test files don't cross-contaminate cleanup.
const _createdGymIds: string[] = [];

/** Creates a gym and returns its UUID. */
export async function createTestGym(name = 'Test Gym'): Promise<string> {
  const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // #636: gyms.payment_provider_id is NOT NULL — take the platform default,
  // resolved with the same predicate as the router's
  // resolveDefaultPaymentProviderId() (seeded by migration 175). Looked up
  // first so a database with no default says so, instead of inserting zero rows
  // and failing one line later on `rows[0].id`.
  const { rows: providerRows } = await db.query<{ id: number }>(
    "SELECT id FROM payment_providers WHERE is_default = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1",
  );
  if (!providerRows[0]) {
    throw new Error(
      'createTestGym: no active default payment provider (#636). Run `npm run db:migrate`, '
      + "or repair it with: UPDATE payment_providers SET is_default = 1 WHERE provider_key = 'monei'",
    );
  }
  await db.query(
    `INSERT INTO gyms (name, slug, plan, payment_provider_id) VALUES (?, ?, 'free', ?)`,
    [name, slug, providerRows[0].id],
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM gyms WHERE slug = ?', [slug]);
  _createdGymIds.push(rows[0].id);
  return rows[0].id;
}

/** Inserts a gym_memberships row so tenantContext can resolve the user's role. */
export async function createTestMembership(
  gymId: string,
  role: 'admin' | 'trainer_performance' | 'trainer_perf_nutrition' | 'front_desk' | 'accountant' | 'nutritionist' | 'member' = 'admin',
  userId = TEST_USER_ID,
) {
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, ?, 'active')`,
    [userId, gymId, role],
  );
}

/**
 * #986: a trainer is an **active Staff record**, so a `gym_memberships` row used
 * as a trainer (an activity's Default Trainer, an occurrence's trainer, a
 * trainer-availability window) needs the employment row behind it — the login's
 * role no longer decides. Inserts one for an existing membership.
 */
export async function createTestStaffForMembership(
  gymId: string,
  membershipId: number,
  first = 'Test',
  last = 'Trainer',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO staff
       (gym_id, gym_membership_id, first_name, last_name, email, profile,
        employment_status, current_status, hire_date)
     VALUES (?, ?, ?, ?, ?, 'Personal Trainer', 'active', 'available', '2026-01-01')`,
    [
      gymId, membershipId, first, last,
      `staff-${membershipId}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    ],
  );
  return Number(insertId);
}

/**
 * Commit a Draft assignment (#1108 stage 1).
 *
 * Every assignment path creates the row as a Draft now, so a test whose subject
 * is what an *active* plan prices, bills or shows — rather than the Draft state
 * itself — assigns and then calls this. It is a helper rather than each file
 * spelling the request because there is one commit route and a second spelling
 * of it would drift from `POST /:id/activate`'s own contract.
 *
 * `confirm` is #956's replacement confirmation, which moved onto this transition
 * from the four insert paths: pass it where the member is deliberately being
 * given a second plan.
 */
export async function activateAssignment(
  gymId: string, userMembershipId: number, opts?: { confirm?: boolean },
): Promise<void> {
  const res = await request
    .post(`/user-memberships/${userMembershipId}/activate`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send(opts?.confirm ? { confirm: true } : {});
  if (res.status !== 200) {
    throw new Error(
      `activateAssignment(${userMembershipId}) answered ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
}

/* ── Assignment configuration fixtures (#1325 PR 3e-3) ───────────────────────
 *
 * `user_memberships` carries no commercial column since migration 258: an
 * assignment's fee, Billing & Duration, cadence, renewal flag and negotiated
 * fee are the plan snapshot of the ProductSet version linked to it. A fixture
 * that used to write them on the row writes them here instead — on the latest
 * version linked to the assignment, or on a **superseded** one it creates for
 * the purpose (it holds no one-active or one-in-flight slot and generates
 * nothing; `ensureTestProductSet()` adopts its snapshot when the same fixture
 * later needs an Active version).
 */

/** Marks the superseded version a fixture creates only to carry configuration. */
const FIXTURE_HOLDER = '__fixture_config_holder__';

const ASSIGNMENT_CONFIG_COLUMNS = [
  'base_price', 'plan_price_id', 'discount_reason', 'discount_expires_at', 'membership_fee_price',
  'free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods',
  'recurring_billing_interval', 'recurring_billing_unit', 'auto_renew',
  'personal_fee_benefit_action', 'personal_fee_benefit_value',
] as const;
export type AssignmentConfigColumn = (typeof ASSIGNMENT_CONFIG_COLUMNS)[number];
export type AssignmentConfigPatch = Partial<Record<AssignmentConfigColumn, unknown>>;

async function latestLinkedSet(umId: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [umId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * #2125 M6b-46: links a fixture's Product Set to the assignment `umId` names, the way the writers do
 * (`PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL`): its anchor, the lowest snapshot naming it, or none yet.
 */
async function relinkTestSet(setId: number, umId: number): Promise<void> {
  await db.query(
    `UPDATE product_sets SET plan_assignment_id = (SELECT a.id FROM plan_snapshots a
                                                    WHERE a.gym_id = product_sets.gym_id AND a.id = ? AND a.anchor_plan_snapshot_id = a.id)
      WHERE id = ?`, [umId, setId]);
}

/** Copies a config holder's snapshot onto a freshly created Active version. */
async function adoptConfigHolder(setId: number, umId: number | null): Promise<void> {
  if (umId == null) return;
  await relinkTestSet(setId, umId);
  // A version is the assignment's: it carries its plan (a plan-less version is
  // the retirement of a plan, which the projection treats as such).
  await db.query(
    `UPDATE product_sets
        SET membership_plan_id = COALESCE(membership_plan_id,
              (SELECT membership_plan_id FROM ${fixtureAssignments()} fa WHERE fa.id = ?))
      WHERE id = ?`, [umId, setId]);
  const { rows: own } = await db.query('SELECT plan_snapshot_id AS id FROM product_set_plan_snapshots WHERE product_set_id = ?', [setId]);
  if (own.length > 0) return;
  const { rows: holder } = await db.query<{ id: number }>(
    `SELECT j.plan_snapshot_id AS id FROM product_set_plan_snapshots j JOIN product_sets ps ON ps.id = j.product_set_id
      WHERE ${productSetOfLegacyAssignmentSql('?', 'ps')} AND ps.id <> ? ORDER BY ps.id DESC, j.plan_snapshot_id DESC LIMIT 1`, [umId, setId]);
  if (!holder[0]) return;
  const cols = ASSIGNMENT_CONFIG_COLUMNS.join(', ');
  const scols = ASSIGNMENT_CONFIG_COLUMNS.map((c) => `s.${c}`).join(', ');
  const { insertId: inserted } = await db.query(
    `INSERT INTO plan_snapshots
       (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, ${cols})
     SELECT s.gym_id, ps.owner_member_id, ps.membership_plan_id, ps.status, ps.starts_at, ps.ends_at,
            ${scols}
       FROM plan_snapshots s JOIN product_sets ps ON ps.id = ? WHERE s.id = ?`, [setId, holder[0].id]);
  await db.query('INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [setId, inserted]);
  await anchorHandAssignment(Number(inserted), umId);
  // The Active version is the assignment's now: a holder only existed to carry
  // what the fixture wrote before one did. M5b: its snapshots go by reference.
  await db.query(
    `DELETE FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} AND id <> ? AND created_by = ?`,
    [umId, setId, FIXTURE_HOLDER]);
  await deleteUnlinkedPlanSnapshots();
  await relinkTestSet(setId, umId);
  await syncFixtureSnapshot(setId);
}

/** #2125 M5b: a fixture that deletes a set by hand deletes the plan snapshots no set links any more. */
export async function deleteUnlinkedPlanSnapshots(): Promise<void> {
  // M6b-1: an assignment's anchor is not deletable while another snapshot of it survives (self FK,
  // RESTRICT), and InnoDB refuses to delete a row that names itself, so the rows about to go are
  // un-anchored first. A kept anchor goes on the next call, once its dependants have.
  const { rows } = await db.query<{ id: number }>(
    `SELECT s.id FROM plan_snapshots s
      WHERE NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM plan_snapshots o WHERE o.anchor_plan_snapshot_id = s.id AND o.id <> s.id)`);
  if (rows.length === 0) return;
  const marks = rows.map(() => '?').join(',');
  const ids = rows.map((r) => Number(r.id));
  await db.query(`UPDATE plan_snapshots SET anchor_plan_snapshot_id = NULL WHERE id IN (${marks}) AND anchor_plan_snapshot_id = id`, ids);
  await db.query(`DELETE FROM plan_snapshots WHERE id IN (${marks})`, ids);
}

/**
 * #3026 stage 3c-3: a fixture that wrote legacy Promotion rows by hand (an application's grant
 * snapshot rows, say) re-derives the assignment's plan snapshot rows the readers read.
 */
export async function resyncTestAssignmentPromotions(umId: number): Promise<void> {
  await syncFixtureSnapshot(await versionOfAssignment(umId));
}

/** #2125 stage 5: readers use `plan_snapshots`, so a fixture writing the legacy row re-derives it as the routes do. */
async function syncFixtureSnapshot(setId: number): Promise<void> {
  const { rows } = await db.query<{ gym_id: string }>('SELECT gym_id FROM product_sets WHERE id = ?', [setId]);
  if (!rows[0]) return;
  await syncPlanSnapshot(db as any, rows[0].gym_id, setId);
  // #2125 M6b-51d-7a: a new anchor is seeded from its own snapshot, which a fixture builds with a
  // placeholder status; the hand-written row is the assignment, so its lifecycle is mirrored onto the
  // anchor (as the fixture door does) and the sync re-run to carry it.
  const { rows: named } = await db.query<{ um: number }>(
    `SELECT DISTINCT s.anchor_plan_snapshot_id AS um FROM product_set_plan_snapshots j
       JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? AND s.anchor_plan_snapshot_id IS NOT NULL`, [setId]);
  if (named.length > 0) {
    await mirrorLegacyLifecycle(db, named.map((r) => Number(r.um)));
    await syncPlanSnapshot(db as any, rows[0].gym_id, setId);
  }
}

/** The configuration an assignment has — its latest linked version's plan snapshot — as the row used to carry it. */
export async function getAssignmentConfig(umId: number): Promise<Record<string, any>> {
  const { rows } = await db.query<any>(
    `SELECT snap.*, ps.id AS product_set_id, ps.status AS product_set_status
       FROM product_sets ps
       LEFT JOIN plan_snapshots snap ON snap.id = (SELECT j2.plan_snapshot_id FROM product_set_plan_snapshots j2
                                                    WHERE j2.product_set_id = ps.id AND j2.entitlement_only = 0 ORDER BY j2.id LIMIT 1)
      WHERE ${productSetOfLegacyAssignmentSql('?', 'ps')} ORDER BY ps.id DESC LIMIT 1`, [umId]);
  return rows[0] ?? {};
}

/** Writes configuration values onto an assignment's version (creating the holder if none). */
export async function setAssignmentConfig(umId: number, patch: AssignmentConfigPatch): Promise<void> {
  const keys = Object.keys(patch) as AssignmentConfigColumn[];
  if (keys.length === 0) return;
  let setId = await latestLinkedSet(umId);
  if (setId == null) {
    const { rows } = await db.query<any>(
      `SELECT gym_id, member_id, membership_plan_id, starts_at, ends_at FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [umId]);
    const um = rows[0];
    if (!um) throw new Error(`setAssignmentConfig: assignment ${umId} not found`);
    const { insertId } = await db.query(
      `INSERT INTO product_sets
         (gym_id, owner_member_id, status, membership_plan_id, starts_at, ends_at, superseded_at)
       VALUES (?, ?, 'superseded', ?, ?, ?, UTC_TIMESTAMP())`,
      [um.gym_id, um.member_id, um.membership_plan_id, um.starts_at, um.ends_at]);
    await db.query("UPDATE product_sets SET created_by = ? WHERE id = ?", [FIXTURE_HOLDER, insertId]);
    setId = Number(insertId);
  }
  const { rows: snap } = await db.query<{ id: number }>(
    'SELECT j.plan_snapshot_id AS id FROM product_set_plan_snapshots j WHERE j.product_set_id = ? AND j.entitlement_only = 0 ORDER BY j.id LIMIT 1', [setId]);
  let snapshotId = snap[0]?.id != null ? Number(snap[0].id) : null;
  if (snapshotId == null) {
    const { insertId } = await db.query(
      `INSERT INTO plan_snapshots
         (gym_id, member_id, membership_plan_id, status, starts_at, ends_at)
       SELECT ps.gym_id, ps.owner_member_id, ps.membership_plan_id, ps.status, ps.starts_at, ps.ends_at
         FROM product_sets ps WHERE ps.id = ?`, [setId]);
    await db.query('INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [setId, Number(insertId)]);
    snapshotId = await anchorHandAssignment(Number(insertId), umId);
    await relinkTestSet(setId, umId);
  }
  const defined = keys.filter((k) => patch[k] !== undefined);
  await db.query(
    `UPDATE plan_snapshots SET ${defined.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...defined.map((k) => patch[k] ?? (k === 'personal_fee_benefit_action' ? 'no_benefit' : k === 'auto_renew' ? 0 : null)), snapshotId]);
  await syncFixtureSnapshot(setId);
}

function literalValue(token: string, params: unknown[]): unknown {
  if (token === '?') return params.shift();
  if (/^NULL$/i.test(token)) return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  const quoted = token.match(/^'(.*)'$/s);
  if (quoted) return quoted[1];
  throw new Error(`legacy assignment fixture: unsupported value ${token}`);
}

/**
 * #1325 PR 3e-4a: an assignment's benefit rows, applied Promotions and
 * recurring services are its current ProductSet version's. A fixture written
 * against the old assignment-keyed shape (`user_membership_id`) goes through
 * this: an INSERT is re-keyed to the assignment's latest linked version (one is
 * created when the assignment has none), and a `user_membership_id = ?` /
 * `IN (?, …)` predicate becomes the same lookup through that version.
 */
const LATEST_VERSION = (idExpr: string) =>
  `(SELECT p9.id FROM product_sets p9 WHERE ${productSetOfLegacyAssignmentSql(idExpr, 'p9')} ORDER BY p9.id DESC LIMIT 1)`;

async function versionOfAssignment(userMembershipId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [userMembershipId]);
  if (rows[0]) return Number(rows[0].id);
  const { rows: um } = await db.query<{ gym_id: string; member_id: number }>(
    `SELECT gym_id, member_id FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [userMembershipId]);
  if (!um[0]) throw new Error(`legacy child fixture: assignment ${userMembershipId} not found`);
  const id = await ensureTestProductSet(um[0].gym_id, Number(um[0].member_id), userMembershipId);
  if (id == null) throw new Error('legacy child fixture: no version');
  return id;
}

const PRIMARY_SNAPSHOT_OF_VERSION = (versionExpr: string) =>
  `(SELECT j9.plan_snapshot_id FROM product_set_plan_snapshots j9 WHERE j9.product_set_id = ${versionExpr} ORDER BY j9.id LIMIT 1)`;

export async function legacyChildQuery(sqlIn: string, params: unknown[] = []): Promise<any> {
  // #3026 stage 3d-1: a read of "the applications" (or their grants) written against the legacy
  // tables reads the plan snapshot rows under the legacy column names.
  if (/^\s*SELECT\b/i.test(sqlIn) && /\buser_membership_promotion/.test(sqlIn)) {
    const { rewriteLegacyPromotionSelect } = await import('./planPromotionReads');
    return db.query(rewriteLegacyPromotionSelect(sqlIn), params as any[]);
  }
  // #3026 stage 3d-2: and a fixture's grant snapshot row of such an application is the plan
  // promotion snapshot's own grant row.
  const grantInsert = sqlIn.match(/^(\s*INSERT INTO )user_membership_promotion_(session|oneoff|periodical)_snapshot\b([\s\S]*)$/i);
  if (grantInsert) {
    return db.query(
      `${grantInsert[1]}plan_promotion_${grantInsert[2]}_product_snapshots${grantInsert[3].replace(/\buser_membership_promotion_id\b/, 'plan_promotion_snapshot_id')}`,
      params as any[]);
  }
  const queue = [...params];
  // #2125 stage 16: the included Products are the plan snapshot's own lines. A fixture written against
  // `user_membership_session|oneoff|periodical` is re-pointed at `plan_*_snapshots`, keyed by the
  // primary plan snapshot of the assignment's version (derived first when it does not exist yet).
  let isLineTable = false;
  const sql = sqlIn.replace(/\buser_membership_(session|oneoff|periodical)\b/g, (_m, kind) => {
    isLineTable = true;
    return `plan_${kind}_snapshots`;
  });
  // Coverage is the plan snapshot's own: an INSERT naming an assignment's
  // covered Members is written on that assignment's snapshot.
  const cover = sql.match(/^\s*INSERT INTO user_membership_members\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i);
  if (cover) {
    const columns = cover[1].split(',').map((c) => c.trim());
    const tuples = [...cover[2].matchAll(/\(([^()]*)\)/g)].map((m) => splitTopLevel(m[1]));
    let last: any = { rows: [], insertId: 0 };
    for (const tokens of tuples) {
      const value = (name: string) => {
        const token = tokens[columns.indexOf(name)].trim();
        return token === '?' ? queue.shift() : token;
      };
      // Placeholders are consumed in column order.
      const resolved: Record<string, any> = {};
      for (const c of columns) resolved[c] = value(c);
      const versionId = await versionOfAssignment(Number(resolved.user_membership_id));
      const { rows } = await db.query<{ id: number }>(
        `SELECT s.id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
          WHERE j.product_set_id = ?
          ORDER BY (s.anchor_plan_snapshot_id = ?) DESC, j.id LIMIT 1`, [versionId, Number(resolved.user_membership_id)]);
      if (!rows[0]) {
        // A version with no plan snapshot yet (a bare fixture): give it the assignment's own.
        const { rows: um } = await db.query<any>(
          `SELECT member_id, membership_plan_id, starts_at, status FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [Number(resolved.user_membership_id)]);
        const { insertId } = await db.query(
          `INSERT INTO plan_snapshots (gym_id, member_id, membership_plan_id, status, starts_at, origin)
           VALUES (?, ?, ?, 'in_cart', ?, 'admin')`,
          [resolved.gym_id, um[0].member_id, um[0].membership_plan_id, um[0].starts_at]);
        await db.query('INSERT IGNORE INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [versionId, Number(insertId)]);
        rows.push({ id: await anchorHandAssignment(Number(insertId), Number(resolved.user_membership_id)) });
      }
      last = await db.query(
        `INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, ?)`,
        [resolved.gym_id, rows[0].id, Number(resolved.member_id), Number(resolved.is_owner)]);
    }
    return last;
  }
  // #2125 M6a: the `user_membership_members` view is dropped; a fixture that reads it reads the same
  // coverage through ASSIGNMENT_BENEFICIARIES.
  if (/^\s*SELECT\b/i.test(sql) && /\bFROM user_membership_members\b/.test(sql)) {
    return db.query(sql.replace(/\bFROM user_membership_members\b/g,
      `FROM ${ASSIGNMENT_BENEFICIARIES} user_membership_members`), queue);
  }
  const insert = sql.match(/^(\s*INSERT INTO \w+\s*\()([^)]*)(\)\s*VALUES\s*\()([\s\S]*)(\)\s*)$/i);
  if (insert && /\buser_membership_id\b/.test(insert[2])) {
    const columns = insert[2].split(',').map((c) => c.trim());
    const tokens = splitTopLevel(insert[4]);
    if (columns.length !== tokens.length) throw new Error('legacy child fixture: column/value mismatch');
    const at = columns.indexOf('user_membership_id');
    let placeholders = 0;
    for (let i = 0; i < at; i++) placeholders += (tokens[i].match(/\?/g) ?? []).length;
    if (tokens[at].trim() !== '?') throw new Error('legacy child fixture: user_membership_id must be a placeholder');
    const assignmentId = Number(queue[placeholders]);
    const versionId = await versionOfAssignment(assignmentId);
    // #3026 stage 3d-2: a Membership Plan Promotion application is its plan snapshot's own row, so a
    // fixture written as `INSERT INTO user_membership_promotions (… user_membership_id …)` inserts
    // that row (same column names) on the assignment's primary plan snapshot.
    const isPlanPromotion = /^\s*INSERT INTO user_membership_promotions\b/i.test(insert[1]);
    if (isLineTable || isPlanPromotion) {
      await syncFixtureSnapshot(versionId);
      const { rows: snap } = await db.query<{ id: number }>(
        'SELECT j.plan_snapshot_id AS id FROM product_set_plan_snapshots j WHERE j.product_set_id = ? AND j.entitlement_only = 0 ORDER BY j.id LIMIT 1', [versionId]);
      if (!snap[0]) throw new Error(`legacy child fixture: version ${versionId} has no plan snapshot`);
      queue[placeholders] = snap[0].id;
      columns[at] = 'plan_snapshot_id';
    } else {
      queue[placeholders] = versionId;
      columns[at] = 'product_set_id';
    }
    const head = isPlanPromotion
      ? insert[1].replace(/user_membership_promotions/i, 'plan_promotion_snapshots') : insert[1];
    const rewritten = `${head}${columns.join(', ')}${insert[3]}${tokens.join(', ')}${insert[5]}`;
    if (isPlanPromotion) return db.query(rewritten, queue);
    // #2126 stage 5d-6: the legacy recurring line table is dropped; the line is its Product snapshot.
    const written = /^\s*INSERT INTO member_products_recurrent_snapshot\b/i.test(insert[1])
      ? await legacyProductInsert(rewritten, queue)
      : await db.query(rewritten, queue);
    // #2125 stage 11: readers use the plan snapshot tables, so a fixture writing the legacy row re-derives them.
    if (!isLineTable) await syncFixtureSnapshot(Number(queue[placeholders]));
    return written;
  }
  // A predicate: re-key `user_membership_id = ?` / `IN (?, ?)` through the version (or, for the
  // plan lines, through the version's primary plan snapshot).
  const keyColumn = isLineTable ? 'plan_snapshot_id' : 'product_set_id';
  const keyExpr = (idExpr: string) => isLineTable
    ? PRIMARY_SNAPSHOT_OF_VERSION(LATEST_VERSION(idExpr)) : LATEST_VERSION(idExpr);
  let out = sql.replace(/\b((?:\w+\.)?)user_membership_id\s*=\s*\?/g,
    (_m, alias) => `${alias}${keyColumn} = ${keyExpr('?')}`);
  out = out.replace(/\b((?:\w+\.)?)user_membership_id\s+IN\s*\(([^)]*)\)/g,
    (_m, alias, list) => `${alias}${keyColumn} IN (${list.split(',').map(() => keyExpr('?')).join(', ')})`);
  // #3026 stage 3d-1: a Plan application is its plan snapshot's own row. A fixture that edits
  // "the assignment's applications" by hand (`UPDATE user_membership_promotions … WHERE
  // user_membership_id = ?`) edits the rows of the assignment's current plan snapshot (the legacy
  // table is dropped since stage 3d-3d).
  const native = sql.match(/^(\s*UPDATE) user_membership_promotions\b([\s\S]*?\bWHERE\b[\s\S]*)$/i);
  if (native) {
    if (!/\buser_membership_id\s*=\s*\?/.test(native[2])) {
      throw new Error('legacy child fixture: an UPDATE of the applications must name user_membership_id = ?');
    }
    const onSnapshot = `${native[1]} plan_promotion_snapshots${native[2]}`.replace(
      /\b(?:\w+\.)?user_membership_id\s*=\s*\?/,
      `plan_snapshot_id = (SELECT x.id FROM (SELECT pa.id FROM plan_snapshots pa
          WHERE ${assignmentOfLegacyIdSql('?', 'pa')}) x)`);
    return db.query(onSnapshot, params as any[]);
  }
  return db.query(out, queue);
}

/**
 * The fixtures' `INSERT INTO user_memberships` / `UPDATE user_memberships SET …`
 * as they were written when the row carried the configuration: the columns it
 * no longer has are taken out of the statement and written on the assignment's
 * version instead. Same signature as `db.query`, so a call site changes by its
 * function name only.
 */
/**
 * #2126 stage 5a — gives a one-time purchase's payment request the `product_purchase` Billing Event
 * every real purchase path writes with it (#1325 PR 2). A purchase reaches its payment through its
 * snapshot's Billing Event junction, so a fixture request with no event is unreachable. Call it
 * before the purchase is synced (`syncProductSnapshotForPurchase()` writes the junction).
 */
export async function linkTestPurchaseRequestToEvent(
  gymId: string, memberId: number, requestId: number, amount = '20.00',
): Promise<number> {
  const { insertId } = await db.query<any>(
    `INSERT INTO billing_events (gym_id, member_id, event_type, amount, source, created_by)
     VALUES (?, ?, 'product_purchase', ?, 'provider', 'Test')`, [gymId, memberId, amount]);
  await db.query('UPDATE payment_requests SET billing_event_id = ? WHERE id = ? AND gym_id = ?',
    [insertId, requestId, gymId]);
  return Number(insertId);
}

/**
 * #2126 stage 3d — a one-time purchase seeded with a legacy-shaped statement
 * (`INSERT INTO member_products_oneoff_snapshot …`). Since stage 5d-6 that table is dropped and
 * `legacyProductInsert()` writes the purchase's Product snapshot instead. Returns the purchase id.
 */
export async function insertTestPurchase(sql: string, params: unknown[] = []): Promise<number> {
  return (await legacyProductInsert(sql, params)).insertId;
}

export async function legacyAssignmentQuery(sql: string, params: unknown[] = []): Promise<any> {
  const queue = [...params];
  const insert = sql.match(/^\s*INSERT INTO user_memberships\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
  if (insert) {
    const columns = insert[1].split(',').map((c) => c.trim());
    const tokens = splitTopLevel(insert[2]);
    if (columns.length !== tokens.length) throw new Error('legacy assignment fixture: column/value mismatch');
    const keptCols: string[] = []; const keptTokens: string[] = []; const keptParams: unknown[] = [];
    const config: AssignmentConfigPatch = {};
    columns.forEach((col, i) => {
      const token = tokens[i];
      if ((ASSIGNMENT_CONFIG_COLUMNS as readonly string[]).includes(col)) {
        config[col as AssignmentConfigColumn] = literalValue(token, queue);
        return;
      }
      keptCols.push(col); keptTokens.push(token);
      const need = (token.match(/\?/g) ?? []).length;
      for (let n = 0; n < need; n += 1) keptParams.push(queue.shift());
    });
    const result = await testAssignmentWrite(
      `INSERT INTO user_memberships (${keptCols.join(', ')}) VALUES (${keptTokens.join(', ')})`, keptParams);
    if (Object.keys(config).length > 0) await setAssignmentConfig(result.insertId, config);
    // A running assignment has its Active version (its Promotions, services and
    // edits live there), carrying the configuration written above.
    const row = handRow(result.insertId) as any;
    if (row && (row.status === 'active' || row.status === 'paused') && row.membership_plan_id != null) {
      await ensureTestProductSet(row.gym_id, Number(row.member_id), result.insertId);
      // #2125 M6b-17: the Billing Simulation reads the assignment's status and dates from its plan
      // snapshot, so the snapshot the set carries states the row's, not the set's placeholder date.
      await db.query(
        `UPDATE plan_snapshots s SET s.status = ?, s.starts_at = ?, s.ends_at = ?
          WHERE s.anchor_plan_snapshot_id = ?`, [row.status, row.starts_at, row.ends_at ?? null, result.insertId]);
      // #2125 M6b-51d-7b: and so does its anchor, the assignment's record (the set's activation above
      // wrote the lifecycle a real activation would, not the hand-written row's).
      await db.query(
        `UPDATE plan_snapshots a SET a.assignment_status = ?, a.assignment_ends_at = ?, a.assignment_closed_at = ?
          WHERE a.anchor_plan_snapshot_id = ? AND a.anchor_plan_snapshot_id = a.id`,
        [row.status, row.ends_at ?? null, row.closed_at ?? null, result.insertId]);
    }
    // #2125 M6b-51c-5: the sync reads an assignment's lifecycle off its anchor, which a hand-written
    // row has no writer to fill; this is what migration 453's backfill does for history.
    if (row) await mirrorLegacyLifecycle(db, [result.insertId]);
    return result;
  }
  const update = sql.match(/^\s*UPDATE user_memberships\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i);
  if (update) {
    const assignments = splitTopLevel(update[1]);
    const config: AssignmentConfigPatch = {};
    const kept: string[] = []; const keptParams: unknown[] = [];
    for (const a of assignments) {
      const m = a.match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if (!m) throw new Error(`legacy assignment fixture: cannot parse ${a}`);
      if ((ASSIGNMENT_CONFIG_COLUMNS as readonly string[]).includes(m[1])) {
        config[m[1] as AssignmentConfigColumn] = literalValue(m[2].trim(), queue);
      } else {
        kept.push(a);
        const need = (m[2].match(/\?/g) ?? []).length;
        for (let n = 0; n < need; n += 1) keptParams.push(queue.shift());
      }
    }
    const where = update[2];
    const whereParams = [...queue];
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM ${fixtureAssignments()} x WHERE ${where}`, whereParams);
    for (const r of rows) await setAssignmentConfig(Number(r.id), config);
    if (kept.length > 0) {
      // #2125 M6b-51d-5: the door mirrors the hand-written change onto the anchors it touched.
      return testAssignmentWrite(`UPDATE user_memberships SET ${kept.join(', ')} WHERE ${where}`, [...keptParams, ...whereParams]);
    }
    return { rows: [], rowCount: rows.length, insertId: 0 };
  }
  throw new Error('legacyAssignmentQuery: unsupported statement');
}

/**
 * #1325: an Active ProductSet of the member (created once per member), linked
 * to `userMembershipId` when given — what a test's hand-written Billing Event
 * must belong to since migration 253.
 */
/** The version a fixture links to an assignment carries that assignment's dates. */
async function followAssignmentDates(setId: number, userMembershipId: number | null): Promise<void> {
  if (userMembershipId == null) return;
  // A hand-written row's own dates (its snapshot may still carry the set's placeholder ones).
  const hand = handRow(userMembershipId);
  const { rows } = hand ? { rows: [hand as any] } : await db.query<any>(
    `SELECT starts_at, ends_at FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [userMembershipId]);
  if (!rows[0]) return;
  await db.query('UPDATE product_sets ps SET ps.starts_at = ?, ps.ends_at = ? WHERE ps.id = ?',
    [rows[0].starts_at, rows[0].ends_at ?? null, setId]);
}

export async function ensureTestProductSet(
  gymId: string, memberId: number | null, userMembershipId: number | null = null,
  opts: { takeActive?: boolean } = {},
): Promise<number | null> {
  if (memberId == null) return null;
  // The set is the member's: a fixture that names another gym (a tenant test)
  // must not leave a row the member's own gym cannot clean up.
  const { rows: owner } = await db.query<{ gym_id: string }>('SELECT gym_id FROM members WHERE id = ?', [memberId]);
  if (owner[0]) gymId = owner[0].gym_id;
  // One Active set per owner (`product_sets_one_active`), whichever gym a
  // fixture moved the member to since: it follows the member.
  const { rows } = await db.query<{ id: number; user_membership_id: number | null }>(
    `SELECT id, ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets
      WHERE owner_member_id = ? AND status = 'active' LIMIT 1`, [memberId]);
  // A second live assignment of one member (a fixture the model forbids) is
  // carried by a superseded version of its own, so the first keeps its set.
  if (!opts.takeActive && rows[0] && userMembershipId != null && rows[0].user_membership_id != null
      && Number(rows[0].user_membership_id) !== userMembershipId) {
    const { insertId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at)
       VALUES (?, ?, 'superseded', '2000-01-01')`,
      [gymId, memberId]);
    await adoptConfigHolder(Number(insertId), userMembershipId);
    await followAssignmentDates(Number(insertId), userMembershipId);
    return Number(insertId);
  }
  if (rows[0]) {
    await db.query(
      'UPDATE product_sets SET gym_id = ? WHERE id = ?', [gymId, rows[0].id]);
    await adoptConfigHolder(Number(rows[0].id), userMembershipId);
    await followAssignmentDates(Number(rows[0].id), userMembershipId);
    return Number(rows[0].id);
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at)
       VALUES (?, ?, 'active', '2000-01-01')`,
      [gymId, memberId]);
    await adoptConfigHolder(Number(insertId), userMembershipId);
    await followAssignmentDates(Number(insertId), userMembershipId);
    return Number(insertId);
  } catch (err: any) {
    // Two fixtures of one member racing on `product_sets_one_active`: the set exists now.
    if (err?.errno !== 1062) throw err;
    return ensureTestProductSet(gymId, memberId, userMembershipId, opts);
  }
}

/**
 * #1325 PR 3c: what used to be `user_memberships.next_billing_date` — the
 * member's Active ProductSet with one scheduled Billing Event on `billingDate`
 * (a `YYYY-MM-DD` string or a SQL date expression such as `CURDATE()`).
 */
export async function seedScheduledEvent(
  gymId: string, memberId: number, userMembershipId: number | null, billingDate: string, amount = 29.99,
): Promise<number> {
  const setId = await ensureTestProductSet(gymId, memberId, userMembershipId, { takeActive: true });
  const isExpr = /[()]/.test(billingDate);
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, product_set_id, event_type, source, amount, billing_date, is_scheduled)
     VALUES (?, ?, ?, 'charge_created', 'system', ?, ${isExpr ? billingDate : '?'}, 1)`,
    isExpr ? [gymId, memberId, setId, amount] : [gymId, memberId, setId, amount, billingDate]);
  return Number(insertId);
}

/** Removes every scheduled event of the member's Active ProductSet. */
/**
 * #1325 PR 3d: `billing_events.user_membership_id` is gone, so a test reads an
 * assignment's events the way the API does — through its owner's Product Sets.
 */
export async function billingEventsOfAssignment<T = any>(gymId: string, umId: number, columns = '*'): Promise<T[]> {
  const { rows } = await db.query<T>(
    `SELECT ${columns} FROM billing_events be
      WHERE be.gym_id = ? AND be.product_set_id IN (
              SELECT ps.id FROM product_sets ps
               WHERE ps.gym_id = ? AND ps.owner_member_id IN (
                       SELECT p2.owner_member_id FROM product_sets p2
                        WHERE p2.gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'p2')}))
      ORDER BY be.id ASC`,
    [gymId, gymId, gymId, umId],
  );
  return rows;
}

export async function clearScheduledEvents(gymId: string, memberId: number): Promise<void> {
  await db.query(
    `DELETE be FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
      WHERE be.gym_id = ? AND ps.owner_member_id = ? AND be.is_scheduled = 1`, [gymId, memberId]);
}

/** Deletes gyms created by this worker and their dependent rows. */
export async function cleanupTestGyms() {
  // #780: the two run histories are the deliberate no-`gym_id` exception, so
  // no cascade from `gyms` reaches them and the `ids` early-return below would
  // skip them. They have to go regardless: one `completed` row for today's UTC
  // date makes `POST /billing/run` (and the unscoped recurring booking run)
  // answer `already_completed_today` for every test in every later file.
  await db.query('DELETE FROM billing_run_log');
  await db.query('DELETE FROM recurring_booking_run_log');
  await db.query('DELETE FROM job_run_log');

  const ids = _createdGymIds.splice(0);
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  // Delete in FK dependency order to avoid constraint violations.
  // #2126 stage 5d-6: purchases and recurring lines are Product snapshots only (the legacy
  // tables are dropped); they cascade from the gym and their Product FK is SET NULL.
  // #1325: ProductSet children cascade from `product_sets`, which cascades from
  // the gym; `owner_member_id` is RESTRICT, so the sets go before `members`.
  // #2567 stage 4: `related_invoice_id` is RESTRICT, so rectifying invoices go before the ones they correct.
  await db.query(`DELETE FROM invoices WHERE gym_id IN (${marks}) AND related_invoice_id IS NOT NULL`, ids);
  // #2648 stage 7: `replaces_invoice_id` is RESTRICT too, so a replacing invoice goes before the simplified one.
  await db.query(`DELETE FROM invoices WHERE gym_id IN (${marks}) AND replaces_invoice_id IS NOT NULL`, ids);
  await db.query(`DELETE FROM product_sets WHERE gym_id IN (${marks})`, ids);
  await db.query(
    `DELETE ps FROM product_sets ps JOIN members m ON m.id = ps.owner_member_id WHERE m.gym_id IN (${marks})`, ids);
  // #2125 M5b: a plan snapshot names no set, so none went with them; `member_id` is RESTRICT.
  // M6b-1: `anchor_plan_snapshot_id` is a RESTRICT self FK, so the identities go before the rows.
  await db.query(`UPDATE plan_snapshots SET anchor_plan_snapshot_id = NULL WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM plan_snapshots WHERE gym_id IN (${marks})`, ids);
  // #1118 / #2126 stage 5d-6: a purchase's frozen Promotions point at `promotions` with ON DELETE
  // RESTRICT, and MySQL does not order the cascades one gym DELETE produces, so they go first.
  await db.query(`DELETE FROM product_promotion_snapshots WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM payment_requests WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM payment_methods WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM calendar_event_shared_training_requests WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM shared_training_requests WHERE gym_id IN (${marks})`, ids).catch(() => {});
  await db.query(`DELETE FROM professional_service_consumptions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM calendar_event_bookings WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM bookings WHERE gym_id IN (${marks})`, ids).catch(() => {});
  await db.query(`DELETE FROM member_notifications WHERE gym_id IN (${marks})`, ids);
  // #1916: standalone exercises (logs of them reference the row, RESTRICT).
  await db.query(`DELETE FROM exercise_log_sets WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM exercise_logs WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_standalone_exercises WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_restrictions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_meal_items WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_meals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_days WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plans WHERE gym_id IN (${marks})`, ids);
  // #647 stage 3 note: `member_recurring_slots` needs no line of its own —
  // every one of its FKs (gym, member, activity type, professional service,
  // center) is ON DELETE CASCADE, so the members delete below clears it.
  // #1009: `workout_block_logs.workout_block_id` is ON DELETE RESTRICT (migration
  // 042), and deleting a member cascades `training_plans` -> `workouts` ->
  // `workout_blocks`. MySQL does not order the cascades a single DELETE fans out
  // into, so the block can go while its log still points at it — which fails the
  // members delete below rather than the gyms one. The log's own `member_id` and
  // `gym_id` are both CASCADE, so this line is only about getting there first.
  await db.query(`DELETE FROM workout_block_logs WHERE gym_id IN (${marks})`, ids);
  // #948 §4: every FK is ON DELETE CASCADE, so the `members` delete below would
  // clear these anyway — listed first for the reason the goal catalogues below
  // are, so a later ticket pointing a non-cascading FK at them finds the order
  // already written down.
  // #1037 stage 2: both FKs are ON DELETE CASCADE and the assignment delete
  // below reaches these through its own, so this line is only about keeping the
  // order readable — a later ticket pointing a non-cascading FK at the readings
  // finds it already written down.
  await db.query(`DELETE FROM member_personal_goal_readings WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_personal_goals WHERE gym_id IN (${marks})`, ids);
  // #1072: both FKs are ON DELETE CASCADE, so the `members` delete below would
  // clear these too — listed for the same readable-order reason.
  await db.query(`DELETE FROM member_device_tokens WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM members WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM staff WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM class_sessions WHERE gym_id IN (${marks})`, ids).catch(() => {});
  await db.query(`DELETE FROM spaces WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM activity_type_eligible_professional_services WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM activity_types WHERE gym_id IN (${marks})`, ids);
  // #966: `tptw_workout_template_id` is the one FK into `workout_templates` that
  // is ON DELETE RESTRICT (migration 038), so a gym's plan-template → workout-
  // template links have to go before the `workout_templates` delete below. The
  // `training_plan_templates` line beside it is cascade-covered, listed for the
  // same readable-order reason the benefit tables further down are.
  await db.query(`DELETE FROM training_plan_template_workouts WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM training_plan_templates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_template_exercises WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_template_blocks WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_templates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM exercises WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_restrictions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_meals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_days WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_templates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_library_items WHERE gym_id IN (${marks})`, ids);
  // #947: both FKs are ON DELETE CASCADE, so the `gyms` delete would clear these
  // anyway — listed for the same reason the Plan-side benefit tables below are,
  // so a later ticket that points a non-cascading FK at them finds the order
  // already written down. The System rows (`gym_id IS NULL`) are migration 206's
  // seeds and are deliberately left alone.
  await db.query(`DELETE FROM personal_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_goals WHERE gym_id IN (${marks})`, ids);
  // #980 stage 3: every FK is ON DELETE CASCADE, so the `calendar_events` delete
  // below would clear these anyway — listed for the same readable-order reason
  // `activity_type_eligible_professional_services` is above.
  await db.query(`DELETE FROM calendar_event_eligible_professional_services WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM calendar_events WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM product_professional_services WHERE gym_id IN (${marks})`, ids);
  // #635 stage 1: every FK on these is ON DELETE CASCADE, so the products
  // delete below would clear them anyway — listed explicitly for the same
  // reason `promotion_session`/`_oneoff`/`_periodical` are, so the order stays
  // readable when a later stage adds a non-cascading FK.
  await db.query(`DELETE FROM membership_plan_session WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM membership_plan_oneoff WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM membership_plan_periodical WHERE gym_id IN (${marks})`, ids);
  // #635 stage 2: the Assigned Plan snapshot tables key to `products`
  // *without* ON DELETE CASCADE (the snapshot must outlive a retired item), so
  // unlike the Plan-side tables above these genuinely have to go before
  // products.
  await db.query(`DELETE FROM plan_session_snapshots WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM plan_oneoff_snapshots WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM plan_periodical_snapshots WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM products WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM tax_rates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gym_professional_services WHERE gym_id IN (${marks})`, ids);
  // #1181: both FKs are ON DELETE CASCADE (and the `personal_goals` delete
  // above already took the gym-owned-goal rows), so the `gyms` delete would
  // clear this anyway — listed for the same readable-order reason.
  await db.query(`DELETE FROM gym_personal_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM professional_services WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM billing_events WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotion_membership_fee_benefits WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotion_session WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotion_oneoff WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotion_periodical WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotion_membership_plans WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM promotions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gym_holiday_hours WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gym_operating_hours WHERE gym_id IN (${marks})`, ids);
  // #725/#732: `fk_theme_member_images_gym` cascades, so a gym's own rows go
  // with it — but a row of a Base Theme carries `gym_id IS NULL` (migration
  // 182) and nothing cascades to it, so a suite that writes one has to clear it
  // itself (`base-theme-members-images.test.ts` does, by theme id).
  await db.query(`DELETE FROM theme_member_images WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, ids);
  // #636: `payment_providers` is deliberately NOT cleaned here. It is
  // platform-level (no gym_id), so nothing cascades it and a blanket delete
  // would take rows a developer created by hand in their own database — plus the
  // migration-seeded default every other test file's createTestGym depends on.
  // A test that creates providers owns them: hard-delete them in its own
  // afterAll, *after* this call (gyms.payment_provider_id is RESTRICT), and hand
  // the default flag back if it borrowed it. See payment-providers.test.ts.
}

/**
 * Polls `fn` until `done(result)` holds, or the timeout passes (then returns
 * the last result so the caller's assertion reports it). For fire-and-forget
 * writes such as audit rows, whose timing a fixed sleep can't guarantee on CI.
 */
export async function eventually<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    last = await fn();
  }
  return last;
}

/**
 * #1863 — a Promotion is applied only to a Membership Plan added in a Draft
 * ProductSet, never to one a Draft inherited from the previous Active version
 * (`is_inherited`, migration 305). A test that applies a Plan Promotion therefore
 * creates its assignment the way `POST /user-memberships` does — a `draft` row
 * plus its first Draft version through `createDraftSetForAssignment()` — so the
 * plan snapshot is the Draft's own. `config` is written onto that version's
 * snapshot, exactly as `legacyAssignmentQuery()` does for a running one. The plan
 * need not be public or priced: those are the route's checks, not the version's.
 */
export async function createTestDraftAssignment(
  gymId: string,
  memberId: number,
  planId: number,
  opts: { startsAt?: string; endsAt?: string | null; config?: AssignmentConfigPatch } = {},
): Promise<number> {
  const { createDraftSetForAssignment } = await import('../api/assignment-draft-set');
  const startsAt = opts.startsAt ?? new Date().toISOString().slice(0, 10);
  const umId = await db.transaction(async (tx) => {
    // #2125 N1: the assignment is opened on the Draft's plan snapshot, as the routes do.
    const { assignmentId } = await createDraftSetForAssignment(tx, {
      gymId, ownerMemberId: memberId, membershipPlanId: planId,
      startsAt, endsAt: opts.endsAt ?? null,
      membershipFeePrice: null, basePrice: null, planPriceId: null,
      discountReason: null, discountExpiresAt: null, actor: { name: 'Test fixture' },
    });
    return assignmentId;
  });
  if (opts.config) await setAssignmentConfig(umId, opts.config);
  return umId;
}

/**
 * #2125 M6b-3: re-derives an assignment's plan snapshots after a fixture wrote its
 * `user_memberships` row by hand (a status, a closure). The readers that moved onto
 * `plan_snapshots` see the fixture's change only through this, as they see a real route's
 * through the sync that route runs.
 */
export async function syncTestAssignmentSnapshots(umId: number): Promise<void> {
  const { syncPlanSnapshotsForAssignment } = await import('../api/plan-snapshot-sync');
  const { rows } = await db.query<{ gym_id: string }>(`SELECT gym_id FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [umId]);
  if (!rows[0]) throw new Error(`syncTestAssignmentSnapshots: no assignment ${umId}`);
  // #2125 M6b-51d-7b: the fixture door already wrote a hand-written change onto the anchor.
  await db.transaction((tx) => syncPlanSnapshotsForAssignment(tx, rows[0].gym_id, umId));
}

/**
 * Commits a Draft assignment through the real route (`POST /:id/activate`,
 * `confirm: true` so a plan it replaces is superseded), for a test that needs a
 * running plan carrying a Promotion applied while it was a Draft (#1863).
 */
export async function activateTestAssignment(gymId: string, umId: number): Promise<void> {
  const res = await request
    .post(`/user-memberships/${umId}/activate`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ confirm: true });
  if (res.status >= 300) {
    throw new Error(`activateTestAssignment: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/**
 * #2833: a Promotion applied to a Draft is a reference only until the Draft is
 * confirmed. Takes the snapshots of the Draft versions linked to this assignment
 * exactly as Save & Pay / the free commit does, without moving any status, for a
 * test that checks what a confirmed application keeps once the Promotion is edited.
 */
export async function confirmTestDraftPromotions(gymId: string, umId: number): Promise<void> {
  const { confirmDraftPromotionSnapshots } = await import('../api/membership-promotions');
  const { rows } = await db.query<{ id: number }>(
    `SELECT DISTINCT ps.id FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.status = 'in_cart'
        AND ${productSetOfLegacyAssignmentSql('?', 'ps')}`,
    [gymId, umId]);
  for (const r of rows) {
    await db.transaction((tx) => confirmDraftPromotionSnapshots(tx, gymId, Number(r.id)));
  }
}

/**
 * #1849 stage 2e: removes System Personal Goals a test created. A Base goal is
 * referenced `ON DELETE RESTRICT` by `gym_personal_goals` / `member_personal_goals`
 * (a gym created in parallel seeds an activation row for every Base goal), so those
 * references go first, then the Base row, then its legacy mirror.
 */
export async function deleteTestSystemPersonalGoals(where: string, params: unknown[] = []): Promise<void> {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM base_personal_goals WHERE ${where}`, params);
  for (const { id } of rows) {
    await db.query('DELETE FROM gym_personal_goals WHERE personal_goal_id = ? OR base_personal_goal_id = ?', [id, id]);
    await db.query('DELETE FROM member_personal_goals WHERE personal_goal_id = ? OR base_personal_goal_id = ?', [id, id]);
    await db.query('DELETE FROM base_personal_goals WHERE id = ?', [id]);
    await db.query('DELETE FROM personal_goals WHERE id = ? AND gym_id IS NULL', [id]);
  }
}

/**
 * #1849 2f: a new Base Personal Goal id must come from the gym-owned goals' sequence
 * (`personal_goals`), so the two id spaces stay disjoint — the same throw-away row
 * `allocateGoalId()` uses in the Cordel router. A fixture that lets
 * `base_personal_goals` pick its own AUTO_INCREMENT can collide with a gym-owned goal
 * on a fresh database, which makes the catalogue view answer for the wrong goal.
 */
export async function allocateTestBaseGoalId(): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO personal_goals (gym_id, name, status, created_by) VALUES (NULL, CONCAT('__reserved_id_', UUID()), 'deleted', 'System')",
  );
  await db.query('DELETE FROM personal_goals WHERE id = ?', [insertId]);
  return insertId as number;
}

/**
 * #1849 F2/F5: a System Food as Cordel's router sees it — a Base row only, its id drawn
 * from the legacy sequence as the router does it.
 */
export async function createTestBaseFood(name: string): Promise<number> {
  // The id is drawn from the legacy table's sequence, as Cordel's router does (F5).
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status, created_by) VALUES (NULL, CONCAT('__reserved_id_', UUID()), 'deleted', 'System')",
  );
  await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [insertId]);
  await db.query('INSERT INTO base_nutrition_library_items (id, name, created_by) VALUES (?, ?, ?)', [insertId, name, 'System']);
  return insertId as number;
}

/** Removes System Foods a test created (Base rows; the plan tables' RESTRICT FKs go first). */
export async function deleteTestBaseFoods(where: string, params: unknown[] = []): Promise<void> {
  await db.query(`DELETE FROM base_nutrition_library_items WHERE ${where}`, params);
}

/**
 * #1849 F2b: a fixture that created a System Food the old way (legacy row plus legacy
 * junction rows) makes it visible to the gym-side reads — which go through the
 * catalogue views — by copying the legacy System foods and their junctions into the
 * Base tables, under the same ids. Idempotent; call it after the fixture's inserts.
 */
export async function syncLegacySystemFoodsToBase(): Promise<void> {
  // A fixture that dropped its legacy System food in an earlier run left a Base copy
  // under another id; its live name would make the INSERT IGNORE below skip the new row
  // silently. Only a Base row sharing a name with a fixture's legacy row is touched: the
  // seeded Base foods have no legacy twin any more (#1849 F5).
  await db.query(`DELETE b FROM base_nutrition_library_items b
    JOIN nutrition_library_items i ON i.name = b.name AND i.gym_id IS NULL AND i.id <> b.id`);
  await db.query(`
    INSERT IGNORE INTO base_nutrition_library_items
      (id, name, description, image_url, created_at, created_by, modified_at, modified_by, deleted_at, deleted_by)
    SELECT id, name, description, image_url, created_at, COALESCE(created_by, 'System'), modified_at, modified_by,
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE NULL END, deleted_by
      FROM nutrition_library_items WHERE gym_id IS NULL`);
  const copies: Array<[string, string, string]> = [
    ['nutrition_library_item_categories', 'base_nutrition_library_item_categories', 'item_id, category_id, created_at'],
    ['nutrition_library_item_qualities', 'base_nutrition_library_item_qualities', 'item_id, quality_id, created_at'],
    ['nutrition_library_item_translations', 'base_nutrition_library_item_translations', 'item_id, locale, name, created_at, modified_at'],
    ['nutrition_library_item_description_translations', 'base_nutrition_library_item_description_translations', 'item_id, locale, description, created_at, modified_at'],
  ];
  for (const [legacy, base, cols] of copies) {
    await db.query(`INSERT IGNORE INTO ${base} (${cols}) SELECT ${cols.split(', ').map((c) => `t.${c}`).join(', ')}
      FROM ${legacy} t JOIN nutrition_library_items i ON i.id = t.item_id AND i.gym_id IS NULL`);
  }
}

/**
 * #1849 stage E2 — a Base exercise fixture: a row of `base_exercises` whose id comes from
 * the legacy `exercises` sequence (so it can never collide with a gym-owned id). Since E6 there is
 * no legacy twin: plan rows reference it through `base_exercise_id`.
 */
export async function createBaseExercise(
  fields: Record<string, unknown> & { name: string },
): Promise<number> {
  const { insertId: id } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, created_by) VALUES (NULL, CONCAT('__reserved_id_', UUID()), 'deleted', 'System')`,
  );
  await db.query('DELETE FROM exercises WHERE id = ?', [id]);
  const cols = Object.keys(fields);
  await db.query(
    `INSERT INTO base_exercises (id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, 'System')`,
    [id, ...cols.map((c) => fields[c])],
  );
  return Number(id);
}

/** Removes Base exercises (referenced rows are the caller's to delete first; gym copies cloned from them go too). */
export async function deleteBaseExercises(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  await db.query(`DELETE FROM exercises WHERE base_exercise_id IN (${marks})`, ids);
  await db.query(`DELETE FROM base_exercises WHERE id IN (${marks})`, ids);
}

/**
 * #1849 E2/E6 — a fixture that still inserts a System exercise the old way (a legacy row with
 * `gym_id IS NULL`, with legacy junction rows and plan rows pointing at it) is moved to where
 * a System exercise lives since migration 343: copied into the Base tables under the same id,
 * its references re-pointed to `base_exercise_id` (the old column cleared), and the legacy row
 * deleted. Call it after the fixture's inserts; rows the fixture inserts afterwards must use
 * `base_exercise_id`. Idempotent, and it touches nothing else (the seeded Base exercises have
 * no legacy twin).
 */
export async function syncLegacySystemExercisesToBase(): Promise<void> {
  const { rows: legacyRows } = await db.query('SELECT id FROM exercises WHERE gym_id IS NULL');
  if (legacyRows.length === 0) return;
  const cols = `name, description, short_description, status, min_reps_default, max_reps_default,
       rest_default_seconds, sets_default, source, source_id, slug, equipment, category, level,
       mechanic, force_type, image_male_url, image_female_url, video_male_url, video_female_url,
       created_at, modified_at, modified_by, deleted_by`;
  await db.query(`
    INSERT INTO base_exercises (id, ${cols}, created_by, deleted_at)
    SELECT id, ${cols}, COALESCE(created_by, 'System'),
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE deleted_at END
      FROM exercises WHERE gym_id IS NULL
    ON DUPLICATE KEY UPDATE ${cols.split(',').map((c) => c.trim()).filter((c) => c !== 'created_at').map((c) => `${c} = VALUES(${c})`).join(', ')},
      deleted_at = VALUES(deleted_at)`);
  const copies: Array<[string, string, string]> = [
    ['exercise_translations', 'base_exercise_translations', 'exercise_id, locale, name, created_at, modified_at'],
    ['exercise_description_translations', 'base_exercise_description_translations', 'exercise_id, locale, short_description, description, created_at, modified_at'],
    ['exercise_muscles', 'base_exercise_muscles', 'exercise_id, role, muscle, muscle_id, created_at'],
    ['exercise_allowed_result_types', 'base_exercise_allowed_result_types', 'exercise_id, result_type_id'],
  ];
  for (const [legacy, base, cols2] of copies) {
    await db.query(`DELETE b FROM ${base} b JOIN exercises e ON e.id = b.exercise_id AND e.gym_id IS NULL`);
    await db.query(`INSERT IGNORE INTO ${base} (${cols2}) SELECT ${cols2.split(', ').map((c) => `t.${c}`).join(', ')}
      FROM ${legacy} t JOIN exercises e ON e.id = t.exercise_id AND e.gym_id IS NULL`);
  }
  for (const [table, col] of [
    ['workout_template_exercises', 'exercise_id'], ['workout_exercises', 'exercise_id'],
    ['exercise_logs', 'exercise_id'], ['member_standalone_exercises', 'exercise_id'], ['exercises', 'cloned_from_id'],
  ]) {
    await db.query(`UPDATE ${table} t JOIN exercises x ON x.id = t.${col} AND x.gym_id IS NULL
      SET t.base_exercise_id = x.id, t.${col} = NULL`);
  }
  for (const junction of Object.keys(Object.fromEntries(copies.map(([l]) => [l, 1])))) {
    await db.query(`DELETE j FROM ${junction} j JOIN exercises e ON e.id = j.exercise_id AND e.gym_id IS NULL`);
  }
  await db.query('DELETE FROM exercises WHERE gym_id IS NULL');
}

/**
 * #2125 M5c — what a monthly charge starting today owes on its first payment under the
 * billing calendar (Oscar, 2026-11-11): the full period when today is the 1st, otherwise
 * the stretch to the next 1st prorated by the proration rule (monthly price ÷ 31 × days).
 */
export function proratedToNextFirst(monthly: number, today: Date = new Date()): number {
  if (today.getUTCDate() === 1) return monthly;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const next = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const days = Math.min(Math.round((next - start) / 86_400_000), 31);
  return Math.round(monthly * days / 31 * 100) / 100;
}

/**
 * #2125 M6b-13: gives an assignment a fixture wrote by hand (`INSERT INTO user_memberships`, no
 * Product Set) the plan snapshot the closed-status readers (the New Member rule, the enrollment
 * status) read it from: one superseded Product Set linking one snapshot carrying the row's owner,
 * plan, status, dates and creation time, anchored on itself. Call it after the last hand-written
 * change to the row; a second call replaces the snapshot it wrote, so a fixture that edits the
 * row again can call it again. A real route writes these through the sync.
 */
export async function snapshotTestAssignment(umId: number): Promise<number> {
  // #2125 M6b-51d-7b: once an anchor states the assignment, its lifecycle is the anchor's (a route may
  // have moved it since the row was written by hand); the row's own values are the creation's. A
  // hand-written row whose anchor has not taken them yet takes them now.
  await mirrorLegacyLifecycle(db, [umId]);
  const { rows } = await db.query<any>(
    `SELECT gym_id, member_id, membership_plan_id, starts_at, created_at, status, ends_at, closed_at
       FROM ${fixtureAssignments()} fa WHERE fa.id = ?`, [umId]);
  const um = rows[0];
  if (!um) throw new Error(`snapshotTestAssignment: no assignment ${umId}`);
  const { rows: existing } = await db.query<{ id: number }>(
    'SELECT id FROM plan_snapshots WHERE anchor_plan_snapshot_id = ? ORDER BY id LIMIT 1', [umId]);
  if (existing[0]) {
    await db.query(
      `UPDATE plan_snapshots SET status = ?, starts_at = ?, ends_at = ?, closed_at = ?, created_at = ?
        WHERE anchor_plan_snapshot_id = ?`,
      [um.status, um.starts_at, um.ends_at, um.closed_at, um.created_at, umId]);
    await db.query(
      `UPDATE plan_snapshots SET assignment_status = ?, assignment_ends_at = ?, assignment_closed_at = ?
        WHERE anchor_plan_snapshot_id = ? AND anchor_plan_snapshot_id = id`, [um.status, um.ends_at, um.closed_at, umId]);
    return Number(existing[0].id);
  }
  const { insertId: setId } = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, membership_plan_id)
     VALUES (?, ?, 'superseded', ?, ?)`,
    [um.gym_id, um.member_id, um.starts_at, um.membership_plan_id]);
  const { insertId: inserted } = await db.query(
    `INSERT INTO plan_snapshots (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, closed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [um.gym_id, um.member_id, um.membership_plan_id, um.status, um.starts_at, um.ends_at, um.closed_at, um.created_at]);
  await db.query(
    'INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [setId, inserted]);
  const snapId = await anchorHandAssignment(Number(inserted), umId);
  await db.query('UPDATE product_sets SET plan_assignment_id = ? WHERE id = ?', [snapId, setId]);
  await mirrorLegacyLifecycle(db, [umId]);
  return Number(snapId);
}

/**
 * #2879: puts `ownerId` and `otherIds` in one family (the first is its owner), so a plan
 * can cover them together — `POST /membership-plans/:id/assign` takes beneficiaries
 * from the owner's family only. Returns the family id.
 */
export async function createTestFamily(gymId: string, ownerId: number, otherIds: number[] = []): Promise<number> {
  const { insertId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)',
    [gymId, `Test family ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, insertId, ownerId]);
  for (const id of otherIds) {
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, insertId, id]);
  }
  return insertId;
}

/**
 * #2125 M6b-42 — links a Product Set to a hand-inserted assignment the way the real writers do: the
 * set's `user_membership_id` **and** its anchor `plan_assignment_id`, the lowest plan snapshot naming
 * that assignment. When no snapshot names it yet, the set's own first plan snapshot is named (as the
 * snapshot sync does for a Draft), else `snapshotTestAssignment()` gives it one.
 */
export async function linkTestSetToAssignment(productSetId: number, umId: number): Promise<void> {
  const { rows: named } = await db.query<{ id: number }>(
    'SELECT id FROM plan_snapshots WHERE anchor_plan_snapshot_id = ? LIMIT 1', [umId]);
  if (!named[0]) {
    const { rows: own } = await db.query<{ id: number }>(
      `SELECT s.id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND s.anchor_plan_snapshot_id IS NULL ORDER BY j.id LIMIT 1`, [productSetId]);
    if (own[0]) {
      // The snapshot becomes the hand-written assignment's anchor, carrying the row's lifecycle
      // (#2125 M6b-51d-7b: the anchor is the only record the writer reads and writes).
      await anchorHandAssignment(Number(own[0].id), umId);
      await mirrorLegacyLifecycle(db, [umId]);
    } else {
      await snapshotTestAssignment(umId);
    }
  }
  await db.query(
    `UPDATE product_sets SET plan_assignment_id = (SELECT a.id FROM plan_snapshots a
                                   WHERE a.gym_id = product_sets.gym_id AND a.id = ? AND a.anchor_plan_snapshot_id = a.id)
      WHERE id = ?`, [umId, productSetId]);
}

