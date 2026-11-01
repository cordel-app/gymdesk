import supertest from 'supertest';
import { app } from '../app';
import { db } from '../infra/db';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';

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
    'SELECT id FROM product_sets WHERE user_membership_id = ? ORDER BY version DESC, id DESC LIMIT 1', [umId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** Copies a config holder's snapshot onto a freshly created Active version. */
async function adoptConfigHolder(setId: number, umId: number | null): Promise<void> {
  if (umId == null) return;
  // A version is the assignment's: it carries its plan (a plan-less version is
  // the retirement of a plan, which the projection treats as such).
  await db.query(
    `UPDATE product_sets
        SET membership_plan_id = COALESCE(membership_plan_id,
              (SELECT membership_plan_id FROM user_memberships WHERE id = ?))
      WHERE id = ?`, [umId, setId]);
  const { rows: own } = await db.query('SELECT id FROM product_set_plan_snapshots WHERE product_set_id = ?', [setId]);
  if (own.length > 0) return;
  const { rows: holder } = await db.query<{ id: number }>(
    `SELECT ps.id FROM product_sets ps
       JOIN product_set_plan_snapshots s ON s.product_set_id = ps.id
      WHERE ps.user_membership_id = ? AND ps.id <> ? ORDER BY ps.version DESC, ps.id DESC LIMIT 1`, [umId, setId]);
  if (!holder[0]) return;
  const cols = ASSIGNMENT_CONFIG_COLUMNS.join(', ');
  await db.query(
    `INSERT INTO product_set_plan_snapshots (gym_id, product_set_id, ${cols})
     SELECT gym_id, ?, ${cols} FROM product_set_plan_snapshots WHERE product_set_id = ?`, [setId, holder[0].id]);
  // The Active version is the assignment's now: a holder only existed to carry
  // what the fixture wrote before one did.
  await db.query(
    'DELETE FROM product_sets WHERE user_membership_id = ? AND id <> ? AND created_by = ?',
    [umId, setId, FIXTURE_HOLDER]);
  await syncFixtureSnapshot(setId);
}

/** #2125 stage 5: readers use `plan_snapshots`, so a fixture writing the legacy row re-derives it as the routes do. */
async function syncFixtureSnapshot(setId: number): Promise<void> {
  const { rows } = await db.query<{ gym_id: string }>('SELECT gym_id FROM product_sets WHERE id = ?', [setId]);
  if (rows[0]) await syncPlanSnapshot(db as any, rows[0].gym_id, setId);
}

/** The configuration an assignment has — its latest linked version's plan snapshot — as the row used to carry it. */
export async function getAssignmentConfig(umId: number): Promise<Record<string, any>> {
  const { rows } = await db.query<any>(
    `SELECT snap.*, ps.id AS product_set_id, ps.status AS product_set_status
       FROM product_sets ps
       LEFT JOIN product_set_plan_snapshots snap ON snap.product_set_id = ps.id
      WHERE ps.user_membership_id = ? ORDER BY ps.version DESC, ps.id DESC LIMIT 1`, [umId]);
  return rows[0] ?? {};
}

/** Writes configuration values onto an assignment's version (creating the holder if none). */
export async function setAssignmentConfig(umId: number, patch: AssignmentConfigPatch): Promise<void> {
  const keys = Object.keys(patch) as AssignmentConfigColumn[];
  if (keys.length === 0) return;
  let setId = await latestLinkedSet(umId);
  if (setId == null) {
    const { rows } = await db.query<any>(
      'SELECT gym_id, member_id, membership_plan_id, starts_at, ends_at FROM user_memberships WHERE id = ?', [umId]);
    const um = rows[0];
    if (!um) throw new Error(`setAssignmentConfig: assignment ${umId} not found`);
    const { insertId } = await db.query(
      `INSERT INTO product_sets
         (gym_id, owner_member_id, version, status, membership_plan_id, starts_at, ends_at,
          user_membership_id, superseded_at)
       VALUES (?, ?, 1, 'superseded', ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [um.gym_id, um.member_id, um.membership_plan_id, um.starts_at, um.ends_at, umId]);
    await db.query("UPDATE product_sets SET created_by = ? WHERE id = ?", [FIXTURE_HOLDER, insertId]);
    await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [insertId]);
    setId = Number(insertId);
  }
  const { rows: snap } = await db.query('SELECT id FROM product_set_plan_snapshots WHERE product_set_id = ?', [setId]);
  if (snap.length === 0) {
    await db.query(
      'INSERT INTO product_set_plan_snapshots (gym_id, product_set_id) SELECT gym_id, id FROM product_sets WHERE id = ?',
      [setId]);
  }
  const defined = keys.filter((k) => patch[k] !== undefined);
  await db.query(
    `UPDATE product_set_plan_snapshots SET ${defined.map((k) => `${k} = ?`).join(', ')} WHERE product_set_id = ?`,
    [...defined.map((k) => patch[k] ?? (k === 'personal_fee_benefit_action' ? 'no_benefit' : k === 'auto_renew' ? 0 : null)), setId]);
  await syncFixtureSnapshot(setId);
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0; let quote: string | null = null; let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
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
  `(SELECT p9.id FROM product_sets p9 WHERE p9.user_membership_id = ${idExpr} ORDER BY p9.version DESC, p9.id DESC LIMIT 1)`;

async function versionOfAssignment(userMembershipId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE user_membership_id = ? ORDER BY version DESC, id DESC LIMIT 1', [userMembershipId]);
  if (rows[0]) return Number(rows[0].id);
  const { rows: um } = await db.query<{ gym_id: string; member_id: number }>(
    'SELECT gym_id, member_id FROM user_memberships WHERE id = ?', [userMembershipId]);
  if (!um[0]) throw new Error(`legacy child fixture: assignment ${userMembershipId} not found`);
  const id = await ensureTestProductSet(um[0].gym_id, Number(um[0].member_id), userMembershipId);
  if (id == null) throw new Error('legacy child fixture: no version');
  return id;
}

export async function legacyChildQuery(sql: string, params: unknown[] = []): Promise<any> {
  const queue = [...params];
  // Coverage is the chain's (`product_set_members`): an INSERT naming an
  // assignment's covered Members is written on that assignment's chain.
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
      const { rows } = await db.query<{ root_product_set_id: number }>(
        'SELECT root_product_set_id FROM product_sets WHERE id = ?', [versionId]);
      last = await db.query(
        `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner) VALUES (?, ?, ?, ?)`,
        [resolved.gym_id, rows[0].root_product_set_id, Number(resolved.member_id), Number(resolved.is_owner)]);
    }
    return last;
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
    queue[placeholders] = await versionOfAssignment(assignmentId);
    columns[at] = 'product_set_id';
    // A Membership Plan application is the assignment's too (#1995 stage 3).
    if (/^\s*INSERT INTO user_membership_promotions\b/i.test(insert[1])) {
      columns.push('user_membership_id');
      tokens.push('?');
      queue.push(assignmentId);
    }
    const written = await db.query(`${insert[1]}${columns.join(', ')}${insert[3]}${tokens.join(', ')}${insert[5]}`, queue);
    // #2125 stage 11: readers use the plan snapshot tables, so a fixture writing the legacy row re-derives them.
    await syncFixtureSnapshot(Number(queue[placeholders]));
    return written;
  }
  // A predicate: re-key `user_membership_id = ?` / `IN (?, ?)` through the version.
  let out = sql.replace(/\b((?:\w+\.)?)user_membership_id\s*=\s*\?/g,
    (_m, alias) => `${alias}product_set_id = ${LATEST_VERSION('?')}`);
  out = out.replace(/\b((?:\w+\.)?)user_membership_id\s+IN\s*\(([^)]*)\)/g,
    (_m, alias, list) => `${alias}product_set_id IN (${list.split(',').map(() => LATEST_VERSION('?')).join(', ')})`);
  return db.query(out, queue);
}

/**
 * The fixtures' `INSERT INTO user_memberships` / `UPDATE user_memberships SET …`
 * as they were written when the row carried the configuration: the columns it
 * no longer has are taken out of the statement and written on the assignment's
 * version instead. Same signature as `db.query`, so a call site changes by its
 * function name only.
 */
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
    const result = await db.query(
      `INSERT INTO user_memberships (${keptCols.join(', ')}) VALUES (${keptTokens.join(', ')})`, keptParams);
    if (Object.keys(config).length > 0) await setAssignmentConfig(result.insertId, config);
    // A running assignment has its Active version (its Promotions, services and
    // edits live there), carrying the configuration written above.
    const { rows: created } = await db.query<any>(
      'SELECT gym_id, member_id, status, membership_plan_id FROM user_memberships WHERE id = ?', [result.insertId]);
    const row = created[0];
    if (row && (row.status === 'active' || row.status === 'paused') && row.membership_plan_id != null) {
      await ensureTestProductSet(row.gym_id, Number(row.member_id), result.insertId);
    }
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
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM user_memberships WHERE ${where}`, whereParams);
    for (const r of rows) await setAssignmentConfig(Number(r.id), config);
    if (kept.length > 0) {
      return db.query(`UPDATE user_memberships SET ${kept.join(', ')} WHERE ${where}`, [...keptParams, ...whereParams]);
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
  await db.query(
    `UPDATE product_sets ps JOIN user_memberships um ON um.id = ?
        SET ps.starts_at = um.starts_at, ps.ends_at = um.ends_at
      WHERE ps.id = ?`,
    [userMembershipId, setId]);
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
    "SELECT id, user_membership_id FROM product_sets WHERE owner_member_id = ? AND status = 'active' LIMIT 1", [memberId]);
  // A second live assignment of one member (a fixture the model forbids) is
  // carried by a superseded version of its own, so the first keeps its set.
  if (!opts.takeActive && rows[0] && userMembershipId != null && rows[0].user_membership_id != null
      && Number(rows[0].user_membership_id) !== userMembershipId) {
    const { insertId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, user_membership_id)
       VALUES (?, ?, 'superseded', '2000-01-01', ?)`,
      [gymId, memberId, userMembershipId]);
    await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [insertId]);
    await adoptConfigHolder(Number(insertId), userMembershipId);
    await followAssignmentDates(Number(insertId), userMembershipId);
    return Number(insertId);
  }
  if (rows[0]) {
    await db.query(
      'UPDATE product_sets SET gym_id = ?, user_membership_id = COALESCE(?, user_membership_id) WHERE id = ?',
      [gymId, userMembershipId, rows[0].id]);
    await adoptConfigHolder(Number(rows[0].id), userMembershipId);
    await followAssignmentDates(Number(rows[0].id), userMembershipId);
    return Number(rows[0].id);
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, user_membership_id)
       VALUES (?, ?, 'active', '2000-01-01', ?)`,
      [gymId, memberId, userMembershipId]);
    await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [insertId]);
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
 * assignment's events the way the API does — through its ProductSet chain.
 */
export async function billingEventsOfAssignment<T = any>(gymId: string, umId: number, columns = '*'): Promise<T[]> {
  const { rows } = await db.query<T>(
    `SELECT ${columns} FROM billing_events be
      WHERE be.gym_id = ? AND be.product_set_id IN (
              SELECT ps.id FROM product_sets ps
               WHERE ps.gym_id = ? AND ps.root_product_set_id IN (
                       SELECT p2.root_product_set_id FROM product_sets p2
                        WHERE p2.gym_id = ? AND p2.user_membership_id = ?))
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
  // #1121 stage 2: before `payment_requests` (its FK to them is ON DELETE SET
  // NULL, so leaving it would null the link rather than fail) and well before
  // `products`, whose FK from here is ON DELETE RESTRICT — a purchase is the
  // record of money that moved, so a Product may not be hard-deleted under it.
  // #1118: before `member_products_oneoff_snapshot` (CASCADE would take them anyway) and well
  // before `promotions`, whose FK from here is ON DELETE RESTRICT for the same
  // reason the Product's is — the application is the record of what the member
  // was charged under.
  // #1325: ProductSet children cascade from `product_sets`, which cascades from
  // the gym; `owner_member_id` is RESTRICT, so the sets go before `members`.
  await db.query(`DELETE FROM product_sets WHERE gym_id IN (${marks})`, ids);
  await db.query(
    `DELETE ps FROM product_sets ps JOIN members m ON m.id = ps.owner_member_id WHERE m.gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_products_oneoff_promotion_snapshot WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_products_oneoff_snapshot WHERE gym_id IN (${marks})`, ids);
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
  // #631: member_products_recurrent_snapshot.product_id has no ON DELETE CASCADE, so
  // these rows must go before products below (deleting members cascades them
  // via user_memberships, but only for gyms whose members are deleted here).
  await db.query(`DELETE FROM member_products_recurrent_snapshot WHERE gym_id IN (${marks})`, ids);
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
  // products — same reason as `member_products_recurrent_snapshot` further up.
  await db.query(`DELETE FROM user_membership_session WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_oneoff WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_periodical WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM products WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM tax_rates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gym_professional_services WHERE gym_id IN (${marks})`, ids);
  // #1181: both FKs are ON DELETE CASCADE (and the `personal_goals` delete
  // above already took the gym-owned-goal rows), so the `gyms` delete would
  // clear this anyway — listed for the same readable-order reason.
  await db.query(`DELETE FROM gym_personal_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM professional_services WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM billing_events WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_promotion_session_snapshot WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_promotion_oneoff_snapshot WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_promotion_periodical_snapshot WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM user_membership_promotions WHERE gym_id IN (${marks})`, ids);
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
    const { insertId } = await tx.query(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, starts_at, ends_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      [memberId, gymId, planId, startsAt, opts.endsAt ?? null, 'Test fixture'],
    );
    await createDraftSetForAssignment(tx, {
      gymId, userMembershipId: Number(insertId), ownerMemberId: memberId, membershipPlanId: planId,
      startsAt, endsAt: opts.endsAt ?? null,
      membershipFeePrice: null, basePrice: null, planPriceId: null,
      discountReason: null, discountExpiresAt: null, actor: { name: 'Test fixture' },
    });
    return Number(insertId);
  });
  if (opts.config) await setAssignmentConfig(umId, opts.config);
  return umId;
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
