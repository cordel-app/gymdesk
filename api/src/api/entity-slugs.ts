import { db, Tx } from '../infra/db';
import { generateSlug, nextAvailableSlug } from '../domain/entitySlug';

/**
 * #2951: the I/O half of `domain/entitySlug.ts` — picks the slug a new row of
 * one of the platform-wide tables is created with. Each of these tables is one
 * scope (it has no gym-specific rows), so the slugs it already holds, deleted
 * rows included, are what a new one must avoid: a slug is never reused, so a
 * deleted row keeps its own. The UNIQUE key on the column is the backstop for a
 * concurrent create.
 */
export type GlobalSlugTable = 'gyms' | 'payment_providers' | 'base_payment_methods';

const FALLBACK: Record<GlobalSlugTable, string> = {
  gyms: 'gym',
  payment_providers: 'payment-provider',
  base_payment_methods: 'payment-method',
};

export async function allocateGlobalSlug(
  table: GlobalSlugTable,
  name: string | null | undefined,
  exec: Pick<Tx, 'query'> = db,
): Promise<string> {
  const base = generateSlug(name, FALLBACK[table]);
  // `base` holds only [a-z0-9-], so it needs no LIKE escaping.
  const { rows } = await exec.query<{ slug: string }>(
    `SELECT slug FROM ${table} WHERE slug = ? OR slug LIKE ?`,
    [base, `${base}-%`],
  );
  return nextAvailableSlug(base, rows.map((r) => r.slug));
}
