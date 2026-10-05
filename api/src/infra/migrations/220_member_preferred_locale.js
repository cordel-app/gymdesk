/**
 * #1039 — a Member's **default language** for the Members App, persisted on the
 * Member.
 *
 * ── Why a column at all ─────────────────────────────────────────────────────
 *
 * The locale was entirely a property of the *request* until now: `x-locale`
 * (from next-intl's `useLocale()`, i.e. the URL's own `/{locale}/…` segment),
 * falling back to `Accept-Language` and then to the base locale
 * (`api/src/infra/locale.ts`, #643). That is enough to render one request, and
 * it is not enough for §4's "the preference must persist after logging out and
 * logging back in": next-intl's `NEXT_LOCALE` cookie lives in one browser, so a
 * member signing in on a phone after choosing Català on a laptop would be back
 * in English. A stored preference is the only thing that survives the session,
 * so it belongs to the Member row.
 *
 * ── Nullable, no default, no backfill ───────────────────────────────────────
 *
 * `NULL` means **no preference**, which is exactly what every member written
 * before this migration means, and §3/§11 are explicit that such a member keeps
 * working and keeps seeing the application's current default. Seeding a locale
 * would turn "follow the app's default" into a snapshot of today's default and
 * would answer §3's "do not force an arbitrary new default" with precisely
 * that. Clearing the selector therefore writes NULL back rather than writing
 * the default in.
 *
 * ── No CHECK, deliberately ──────────────────────────────────────────────────
 *
 * Which locales exist is **configuration**, not a vocabulary: `SUPPORTED_LOCALES`
 * is an env var parsed at boot, and `api/src/infra/locale.ts` is the one place
 * that decides whether a tag is one of them. A CHECK listing `en`/`es`/`ca`
 * would freeze that set in the schema, so a deployment adding `fr` would store
 * a locale the application accepts and the database refuses — and a CHECK is
 * also what CLAUDE.md declines on the high-traffic tables, since
 * `ADD CONSTRAINT` rebuilds under `ALGORITHM=COPY`. The write path is the gate:
 * `parseMemberPreferredLocaleInput()`
 * (`api/src/domain/memberPreferredLocale.ts`) is the only place a request's
 * value is judged, and it stores the allowlist's own string rather than the
 * caller's (§10).
 *
 * VARCHAR(10) because that is what a locale column already is in this schema:
 * `nutrition_library_item_translations.locale` (migration 166) and
 * `exercise_translations.locale` (210). It holds every tag `SUPPORTED_LOCALES`
 * can carry today, and a deployment that configured a longer one
 * (`ca-valencia`, 11 characters, which `locale.ts`'s own pattern admits) would
 * need all three widened together — one migration of its own rather than this
 * one's problem. Worth knowing because the failure is unpleasant:
 * `normalizeLocale()` stores the allowlist's own string, so an over-long
 * configured locale reaches the `UPDATE` as ER_DATA_TOO_LONG, which carries no
 * `status` and so reads as a bare 500 (#966).
 *
 * The column is appended with **no `AFTER`**: `members` grows per gym per
 * member, and a mid-table `ADD COLUMN` is non-INSTANT before MySQL 8.0.29
 * (migration 218's note) while the position buys nothing — every reader
 * projects `m.*` or names its columns.
 *
 * No index: the column is never a predicate. It is read from a row already
 * selected by `gym_id` + id, and nothing lists members by language.
 */

const TABLE = 'members';
const COLUMN = 'preferred_locale';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(10) NULL`);
  }
};

/**
 * Lossy in a way `up()` cannot repair, migration 218's shape: nothing else
 * records a member's choice — `PATCH /me/profile` writes no audit row — so
 * dropping the column discards every preference, and a re-run of `up()` re-adds
 * an empty one that silently puts every member back on the application default,
 * which is the outcome §4 exists to prevent. Recorded here so the next reader
 * does not mistake this one for reversible. Note also that
 * `npm run db:migrate:down` is `knex migrate:rollback` and reverts the whole
 * batch; `migrate:down` steps one.
 */
exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};
