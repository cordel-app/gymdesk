import { db } from '../infra/db';
import { parsePsTranslations, type BasePsTranslations } from '../domain/baseProfessionalServices';

/**
 * #2254 — the one reader/writer of `product_translations` (a gym's Product) and
 * `base_product_translations` (a Cordel template), the Professional Services
 * mechanism (#2110) one catalogue over. `name` / `description` on the row stay
 * the base-locale (English) value and the fallback; a locale with no (or a
 * blank) row falls back to it. Two junctions, never shared: a template's
 * translations and a gym's are separate rows.
 */
type Tx = { query: (sql: string, params?: any[]) => Promise<any> };
export type ProductTranslationKind = 'product' | 'base';

const TABLES: Record<ProductTranslationKind, { table: string; fk: string }> = {
  product: { table: 'product_translations', fk: 'product_id' },
  base: { table: 'base_product_translations', fk: 'base_product_id' },
};

/** A Product may leave a locale out; judged like a gym's own Professional Service. */
export function parseProductTranslations(value: unknown) {
  return parsePsTranslations(value, { requireAll: false });
}

export async function attachProductTranslations<R extends { id: number; name: string; description: string | null }>(
  kind: ProductTranslationKind, rows: R[], locale: string,
) {
  if (rows.length === 0) return [];
  const { table, fk } = TABLES[kind];
  const { rows: tr } = await db.query<any>(
    `SELECT ${fk} AS id, locale, name, description FROM ${table} WHERE ${fk} IN (${rows.map(() => '?').join(',')})`,
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

/** Upserts the locales given; `cleared` lists locales the caller blanked, which lose their row. */
export async function writeProductTranslations(
  kind: ProductTranslationKind, tx: Tx, id: number | string, t: BasePsTranslations, cleared: string[] = [],
) {
  const { table, fk } = TABLES[kind];
  for (const [locale, v] of Object.entries(t)) {
    await tx.query(
      `INSERT INTO ${table} (${fk}, locale, name, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), modified_at = UTC_TIMESTAMP()`,
      [id, locale, v.name, v.description],
    );
  }
  if (cleared.length > 0) {
    await tx.query(
      `DELETE FROM ${table} WHERE ${fk} = ? AND locale IN (${cleared.map(() => '?').join(',')})`,
      [id, ...cleared],
    );
  }
}

/** The locales a request blanked out (present in the body, absent from the parsed value). */
export function clearedLocales(body: unknown, parsed: BasePsTranslations): string[] {
  return Object.keys((body ?? {}) as object).filter((l) => !(l in parsed));
}

/** Copies a template's translations onto a gym Product (Import) or a Product's onto its copy (Duplicate). */
export async function copyProductTranslations(
  from: ProductTranslationKind, to: 'product', tx: Tx, fromId: number | string, toId: number | string, replace = false,
) {
  const src = TABLES[from];
  const dst = TABLES[to];
  if (replace) await tx.query(`DELETE FROM ${dst.table} WHERE ${dst.fk} = ?`, [toId]);
  await tx.query(
    `INSERT IGNORE INTO ${dst.table} (${dst.fk}, locale, name, description)
     SELECT ?, locale, name, description FROM ${src.table} WHERE ${src.fk} = ?`,
    [toId, fromId],
  );
}
