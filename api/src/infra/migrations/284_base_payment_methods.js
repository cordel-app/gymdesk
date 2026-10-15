/**
 * #1663 — Cordel → Base Payment Methods: the platform's catalogue of payment
 * methods (Members App, Cash, Google Pay, Apple Pay, Card, PayPal, Bizum, Monei).
 *
 * `base_payment_methods` is a global catalogue (no `gym_id`) and is **not**
 * `payment_methods`, which holds a member's stored card. A row is a stable
 * `code` plus a lifecycle: `status` (active | inactive — whether the method is
 * enabled for use) and `deleted_at` (soft delete — gone from administration,
 * kept for historical references) are two different facts and are never merged.
 * The code is unique among live rows only (`active_code_key`, migration 183's
 * VIRTUAL generated-column device), so a deleted code can be reused.
 *
 * Names and descriptions live in `base_payment_method_translations`, one row per
 * `(method, locale)` (CLAUDE.md's junction shape for translated data).
 *
 * The seed is idempotent: it inserts a method only while its code has no live
 * row, and a translation only while that locale has none, so re-running it (or
 * a wording Cordel has since changed) is never overwritten.
 *
 * Mirrors `SEED_BASE_PAYMENT_METHODS` in `api/src/domain/basePaymentMethods.ts`
 * (a migration is plain JS and cannot import it); a unit test asserts they agree.
 */

const TABLE = 'base_payment_methods';
const TRANSLATIONS = 'base_payment_method_translations';

const SEEDS = [
  ['members_app', 'active', 'Members App', 'Payment managed through the Members App.', 'App de miembros', 'Pago gestionado a través de la app de miembros.', 'App de membres', "Pagament gestionat a través de l'app de membres."],
  ['cash', 'active', 'Cash', 'Payment made in cash.', 'Efectivo', 'Pago realizado en efectivo.', 'Efectiu', 'Pagament en efectiu.'],
  ['google_pay', 'inactive', 'Google Pay', 'Payment using Google Pay.', 'Google Pay', 'Pago mediante Google Pay.', 'Google Pay', 'Pagament mitjançant Google Pay.'],
  ['apple_pay', 'inactive', 'Apple Pay', 'Payment using Apple Pay.', 'Apple Pay', 'Pago mediante Apple Pay.', 'Apple Pay', 'Pagament mitjançant Apple Pay.'],
  ['card', 'active', 'Card', 'Payment made by debit or credit card.', 'Tarjeta', 'Pago realizado con tarjeta de débito o crédito.', 'Targeta', 'Pagament amb targeta de dèbit o crèdit.'],
  ['paypal', 'inactive', 'PayPal', 'Payment using PayPal.', 'PayPal', 'Pago mediante PayPal.', 'PayPal', 'Pagament mitjançant PayPal.'],
  ['bizum', 'inactive', 'Bizum', 'Payment using Bizum.', 'Bizum', 'Pago mediante Bizum.', 'Bizum', 'Pagament mitjançant Bizum.'],
  ['monei', 'active', 'Monei', 'Payment processed through Monei.', 'Monei', 'Pago procesado a través de Monei.', 'Monei', 'Pagament processat a través de Monei.'],
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
        code         VARCHAR(50)  NOT NULL,
        status       VARCHAR(20)  NOT NULL DEFAULT 'active',
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by   VARCHAR(255) NULL,
        modified_at  DATETIME     NULL,
        modified_by  VARCHAR(255) NULL,
        deleted_at   DATETIME     NULL,
        deleted_by   VARCHAR(255) NULL,
        active_code_key VARCHAR(50)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_payment_methods_active_code (active_code_key),
        KEY base_payment_methods_status_index (status),
        CONSTRAINT chk_base_payment_methods_status CHECK (status IN ('active','inactive'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await knex.schema.hasTable(TRANSLATIONS))) {
    await knex.raw(`
      CREATE TABLE ${TRANSLATIONS} (
        base_payment_method_id INT UNSIGNED NOT NULL,
        locale      VARCHAR(10)  NOT NULL,
        name        VARCHAR(120) NOT NULL,
        description VARCHAR(500) NULL,
        PRIMARY KEY (base_payment_method_id, locale),
        CONSTRAINT bpmt_method_fk FOREIGN KEY (base_payment_method_id)
          REFERENCES ${TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  for (const [code, status, ...texts] of SEEDS) {
    await knex.raw(
      `INSERT INTO ${TABLE} (code, status, created_by)
       SELECT ?, ?, 'System' FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE code = ? AND deleted_at IS NULL)`,
      [code, status, code],
    );
    const locales = ['en', 'es', 'ca'];
    for (let i = 0; i < locales.length; i++) {
      await knex.raw(
        `INSERT IGNORE INTO ${TRANSLATIONS} (base_payment_method_id, locale, name, description)
         SELECT id, ?, ?, ? FROM ${TABLE} WHERE code = ? AND deleted_at IS NULL`,
        [locales[i], texts[i * 2], texts[i * 2 + 1], code],
      );
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TRANSLATIONS);
  await knex.schema.dropTableIfExists(TABLE);
};
