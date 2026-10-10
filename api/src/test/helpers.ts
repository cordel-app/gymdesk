import supertest from 'supertest';
import { app } from '../app';
import { db } from '../infra/db';

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

/** Deletes gyms created by this worker and their dependent rows. */
export async function cleanupTestGyms() {
  // #780: the two run histories are the deliberate no-`gym_id` exception, so
  // no cascade from `gyms` reaches them and the `ids` early-return below would
  // skip them. They have to go regardless: one `completed` row for today's UTC
  // date makes `POST /billing/run` (and the unscoped recurring booking run)
  // answer `already_completed_today` for every test in every later file.
  await db.query('DELETE FROM billing_run_log');
  await db.query('DELETE FROM recurring_booking_run_log');

  const ids = _createdGymIds.splice(0);
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  // Delete in FK dependency order to avoid constraint violations.
  // #1121 stage 2: before `payment_requests` (its FK to them is ON DELETE SET
  // NULL, so leaving it would null the link rather than fail) and well before
  // `products`, whose FK from here is ON DELETE RESTRICT — a purchase is the
  // record of money that moved, so a Product may not be hard-deleted under it.
  // #1118: before `member_products` (CASCADE would take them anyway) and well
  // before `promotions`, whose FK from here is ON DELETE RESTRICT for the same
  // reason the Product's is — the application is the record of what the member
  // was charged under.
  // #1325: ProductSet children cascade from `product_sets`, which cascades from
  // the gym; `owner_member_id` is RESTRICT, so the sets go before `members`.
  await db.query(`DELETE FROM product_sets WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_product_promotions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_products WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM payment_requests WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM payment_methods WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM calendar_event_shared_training_requests WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM shared_training_requests WHERE gym_id IN (${marks})`, ids).catch(() => {});
  await db.query(`DELETE FROM professional_service_consumptions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM calendar_event_bookings WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM bookings WHERE gym_id IN (${marks})`, ids).catch(() => {});
  await db.query(`DELETE FROM member_notifications WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_goals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_restrictions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_meal_items WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_meals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plan_days WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM member_nutrition_plans WHERE gym_id IN (${marks})`, ids);
  // #631: user_membership_services.product_id has no ON DELETE CASCADE, so
  // these rows must go before products below (deleting members cascades them
  // via user_memberships, but only for gyms whose members are deleted here).
  await db.query(`DELETE FROM user_membership_services WHERE gym_id IN (${marks})`, ids);
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
  // products — same reason as `user_membership_services` further up.
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
