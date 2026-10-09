/**
 * #1227 stage 1 — staff adjustments of a Member's Professional Service balance.
 *
 * The balance stays the derived one (`domain/memberProfessionalServices.ts`,
 * #973/#1189): the ticket's thread is explicit that no second balance system is
 * introduced. A manual correction is therefore one more *source* of that
 * balance, recorded as an append-only ledger row — the signed `delta` plus the
 * `balance_before` / `balance_after` it was taken against, a free-text `reason`
 * and #1182's plain-text actor snapshot. Nothing is ever updated or deleted.
 *
 * `professional_service_consumptions.source_kind` is widened to admit
 * `manual_adjustment`, because a positive net adjustment is spent like any other
 * grant (`domain/serviceConsumption.ts`). The CHECK is a superset by design.
 */
const TABLE = 'professional_service_adjustments';

const KINDS = ['plan_session', 'promotion_session', 'membership_service', 'class_package', 'manual_adjustment'];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                   CHAR(36)     NOT NULL,
        member_id                INT UNSIGNED NOT NULL,
        professional_service_id  INT UNSIGNED NOT NULL,
        delta                    INT          NOT NULL,
        balance_before           INT          NOT NULL,
        balance_after            INT          NOT NULL,
        reason                   VARCHAR(255) NULL,
        created_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by               VARCHAR(255) NULL,
        PRIMARY KEY (id),
        KEY psa_member_service (gym_id, member_id, professional_service_id),
        CONSTRAINT fk_psa_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT fk_psa_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
        CONSTRAINT fk_psa_service FOREIGN KEY (professional_service_id)
          REFERENCES professional_services (id) ON DELETE CASCADE,
        CONSTRAINT chk_psa_delta CHECK (delta <> 0),
        CONSTRAINT chk_psa_math CHECK (balance_after = balance_before + delta),
        CONSTRAINT chk_psa_balance CHECK (balance_before >= 0 AND balance_after >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
  await swapKindCheck(knex, KINDS);
};

exports.down = async (knex) => {
  const { rows } = await selectRows(knex,
    "SELECT COUNT(*) AS n FROM professional_service_consumptions WHERE source_kind = 'manual_adjustment'");
  if (Number(rows[0].n) > 0) {
    throw new Error('Cannot roll back 242: manual_adjustment rows exist in professional_service_consumptions');
  }
  await swapKindCheck(knex, KINDS.slice(0, 4));
  await knex.schema.dropTableIfExists(TABLE);
};

async function selectRows(knex, sql) {
  const res = await knex.raw(sql);
  return { rows: res[0] };
}

/** Drop the CHECK only if present, then add the new definition (re-runnable after a partial failure). */
async function swapKindCheck(knex, kinds) {
  const { rows } = await selectRows(knex,
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'professional_service_consumptions'
        AND CONSTRAINT_NAME = 'chk_psc_kind' AND CONSTRAINT_TYPE = 'CHECK'`);
  if (Number(rows[0].n) > 0) {
    await knex.raw('ALTER TABLE professional_service_consumptions DROP CHECK chk_psc_kind');
  }
  const list = kinds.map((k) => `'${k}'`).join(', ');
  await knex.raw(
    `ALTER TABLE professional_service_consumptions ADD CONSTRAINT chk_psc_kind CHECK (source_kind IN (${list}))`,
  );
}

exports.KINDS = KINDS;
