import { db } from '../infra/db';
import type { BasePsTranslations } from '../domain/baseProfessionalServices';

/**
 * #2110 — the one reader/writer of `professional_service_translations`, for a
 * Base service (`gym_id IS NULL`) and a gym's own alike: the junction is keyed by
 * the service id, so both share it. `name` / `description` on the row stay the
 * base-locale value and the fallback.
 */
type Tx = { query: (sql: string, params?: any[]) => Promise<any> };

export async function attachTranslations<R extends { id: number; name: string; description: string | null }>(
  rows: R[], locale: string,
) {
  if (rows.length === 0) return [];
  const { rows: tr } = await db.query<any>(
    `SELECT professional_service_id AS id, locale, name, description
       FROM professional_service_translations
      WHERE professional_service_id IN (${rows.map(() => '?').join(',')})`,
    rows.map((r) => r.id),
  );
  const byId = new Map<number, BasePsTranslations>();
  for (const t of tr) {
    const m = byId.get(t.id) ?? {};
    m[t.locale] = { name: t.name, description: t.description };
    byId.set(t.id, m);
  }
  return rows.map((r) => {
    const translations = byId.get(r.id) ?? {};
    const shown = translations[locale];
    return {
      ...r,
      translations,
      display_name: shown?.name || r.name,
      display_description: shown?.description || r.description,
    };
  });
}

/** Replace-all for the locales given; a locale absent from the map is left alone. */
export async function writeTranslations(tx: Tx, id: number, t: BasePsTranslations) {
  for (const [locale, v] of Object.entries(t)) {
    await tx.query(
      `INSERT INTO professional_service_translations (professional_service_id, locale, name, description)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
      [id, locale, v.name, v.description],
    );
  }
}

/** Deletes the locales the caller blanked out (used by a gym's own service, where a locale is optional). */
export async function deleteTranslations(tx: Tx, id: number, locales: string[]) {
  if (locales.length === 0) return;
  await tx.query(
    `DELETE FROM professional_service_translations WHERE professional_service_id = ? AND locale IN (${locales.map(() => '?').join(',')})`,
    [id, ...locales],
  );
}

/** Copies every translation row from one service to another (Import, Duplicate). */
export async function copyTranslations(tx: Tx, fromId: number, toId: number, nameSuffix = '') {
  await tx.query(
    `INSERT INTO professional_service_translations (professional_service_id, locale, name, description)
     SELECT ?, locale, CONCAT(name, ?), description FROM professional_service_translations WHERE professional_service_id = ?`,
    [toId, nameSuffix, fromId],
  );
}
