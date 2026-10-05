/**
 * #1072 (mobile app WP1) — **`member_device_tokens`**: the devices a member can
 * be reached on by push.
 *
 * One row is "this member, on this device, in this app, holds this FCM
 * registration token". `POST /me/devices` writes it, `DELETE /me/devices/:token`
 * removes it, and `api/src/infra/push.ts` reads it after every
 * `member_notifications` insert. Nothing else consumes it.
 *
 * ── `UNIQUE (platform, token)`, deliberately not per gym ────────────────────
 *
 * An FCM registration token identifies an **app installation**, not a person:
 * two members who share a phone, or a gym's demo handset passed between staff,
 * produce one token. So the token is the identity and the member is an
 * attribute of it — the upsert re-points `gym_id`/`member_id` on a conflict
 * rather than inserting a second row, because leaving the first row in place
 * would send the new member's alerts to the previous member's account and the
 * previous member's to a phone that is no longer theirs. A `UNIQUE (gym_id,
 * platform, token)` would permit exactly that, one gym over.
 *
 * `platform` is part of the key because the same string could in principle be
 * issued by two transports; it costs nothing and makes the key say what it
 * means. 2112 bytes of utf8mb4 at the declared widths, inside InnoDB's 3072.
 *
 * The flip side of that global key, stated so a later reader does not have to
 * rediscover it: because `POST /me/devices` takes the token from the request
 * body, a member who *learns* another member's registration token — in this gym
 * or any other — can re-point the row at themselves, which stops the victim's
 * push and sends the attacker's alerts to the victim's handset. Per-gym
 * uniqueness would confine that to one gym without removing it, while
 * reintroducing the double delivery above, so the key stays global: a
 * registration token is device-scoped and is not meant to leave the device
 * (nothing in the product discloses one — it is never echoed by `POST
 * /me/devices`, never logged, and read only by the sender). What is pushed is
 * in any case a copy of an alert the member can already see in the app.
 *
 * ── `app_id` exists before the second app does ──────────────────────────────
 *
 * `docs/mobile-app.md` design rule 2: the token records which app registered it
 * **from the first migration**, because the sender resolves FCM credentials per
 * app (`FCM_SERVICE_ACCOUNTS`, keyed by app id) and adding the column later is a
 * data migration — every token already in the table would have to be attributed
 * to an app by guesswork. Stage 1 has exactly one profile, so the default is the
 * generic app's own id; the string is `DEFAULT_APP_ID` in
 * `api/src/domain/deviceTokens.ts`, spelled here to match it, and a deployment
 * overrides the *registration* default with `MOBILE_DEFAULT_APP_ID` rather than
 * by altering this column.
 *
 * VARCHAR(191) because a Bundle ID / package name is an identifier, not prose,
 * and 191 is this schema's habitual width for one (it is also the utf8mb4 length
 * that still fits a single-column index under the pre-8.0 767-byte limit, which
 * is where the number comes from).
 *
 * ── Two timestamps, and no `modified_at` ────────────────────────────────────
 *
 * `created_at` is when this device first registered and `last_seen_at` is when
 * it last did — which is what the upsert refreshes, and the only "modification"
 * a row has. A `modified_at` beside it would be the same fact twice. Neither is
 * read by anything yet; `last_seen_at` is what a later ticket would prune a
 * long-dead installation by, and recording it from the first migration costs
 * nothing (an FCM token that has not been refreshed in months is usually gone,
 * but `UNREGISTERED` is the authority on that, so no sweep is written here).
 *
 * ── CHECK on the platform, nothing else ────────────────────────────────────
 *
 * `chk_mdt_platform` mirrors `DEVICE_PLATFORMS` in
 * `api/src/domain/deviceTokens.ts`, so a new platform goes in **two** places.
 * `app_id` and `token` carry no CHECK: the first is deployment configuration
 * (a vocabulary in SQL would refuse a gym app added tomorrow) and the second is
 * an opaque string from Google.
 * ── Collations ─────────────────────────────────────────────────────────────
 *
 * The table pins `utf8mb4_0900_ai_ci` like every other `CREATE TABLE` here
 * rather than inheriting the schema default: MySQL requires a foreign key's
 * referencing and referenced string columns to share character set *and*
 * collation, so an inherited default that differs from the one `gyms` was
 * created under fails `mdt_gym_fk` with errno 3780 (migrations 181/182 spell
 * the gym column's collation out for the same reason).
 *
 * `platform` and `token` are `utf8mb4_bin` on top of that, because both are
 * opaque identifiers rather than text: under an accent- and case-insensitive
 * collation the unique key and the route's `WHERE token = ?` would match a
 * token that differs only in case, and since the upsert deliberately does not
 * rewrite `token`, the row would keep the old casing while the route answered
 * 201 — then the sender would push a token FCM rejects and
 * `pushFailureAction()` would delete the row. `app_id` stays on the table
 * collation, because nothing compares it in SQL; the sender matches it
 * **exactly** (a `Map` lookup against `FCM_SERVICE_ACCOUNTS`' keys), so a
 * registration spelling a bundle id in another case is skipped rather than
 * delivered to.
 *
 * `up()` is a single `CREATE TABLE`, so the implicit-DDL-commit hazard the
 * multi-statement migrations guard against (134/140/155/183/205/206/212) does
 * not arise: there is no second statement a crash could strand.
 */

/** Mirrors `DEVICE_PLATFORMS` in `api/src/domain/deviceTokens.ts`. */
const PLATFORMS = ['ios', 'android'];

/** Mirrors `DEFAULT_APP_ID` in `api/src/domain/deviceTokens.ts`. */
const DEFAULT_APP_ID = 'com.cordel.fitness';

/**
 * The prefix every constraint and index on the table is named with. CHECK and
 * FK names are schema-global in MySQL 8, so it is the table's own abbreviation
 * and nobody else's.
 */
const PREFIX = 'mdt';
const TABLE = 'member_device_tokens';

// Exported so `device-tokens.unit.test.ts` can assert the values rather than
// grep this file's text, as migrations 205/207/212 do for their own.
exports.PLATFORMS = PLATFORMS;
exports.DEFAULT_APP_ID = DEFAULT_APP_ID;
exports.TABLE = TABLE;
exports.PREFIX = PREFIX;

exports.up = async (knex) => {
  const platforms = PLATFORMS.map((p) => `'${p}'`).join(', ');

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id       CHAR(36)      NOT NULL,
        member_id    INT UNSIGNED  NOT NULL,
        platform     VARCHAR(16)   COLLATE utf8mb4_bin NOT NULL,
        app_id       VARCHAR(191)  NOT NULL DEFAULT '${DEFAULT_APP_ID}',
        token        VARCHAR(512)  COLLATE utf8mb4_bin NOT NULL,
        last_seen_at DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_at   DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ${PREFIX}_platform_token (platform, token),
        -- The delivery read: every token of a handful of members of one gym,
        -- which is the only query shape this table has.
        KEY ${PREFIX}_gym_member_index (gym_id, member_id),
        -- Declared rather than left to InnoDB, which would otherwise auto-create
        -- one named after the constraint: the composite above covers the gym FK
        -- but is not a usable prefix for the member one.
        KEY ${PREFIX}_member_index (member_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_member_fk FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
        CONSTRAINT chk_${PREFIX}_platform CHECK (platform IN (${platforms}))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

/**
 * Reversible in the only sense that matters: a device token is a cache of
 * something the device itself re-registers on the next sign-in (WP2 registers
 * on sign-in and removes on sign-out), so dropping the table loses no fact
 * nobody else holds — unlike migration 220's preference, it is not a member's
 * choice. The member still has every alert, in `member_notifications`.
 */
exports.down = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) {
    await knex.schema.dropTable(TABLE);
  }
};
