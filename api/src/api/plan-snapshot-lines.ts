import type { Tx } from '../infra/db';
import type { ProductBenefitCategory } from '../domain/productClassification';

/**
 * #2125 stage 16 — the Products a Membership Plan includes are the **plan snapshot's own lines**
 * (`plan_session/oneoff/periodical_snapshots`, keyed by `plan_snapshot_id`); the version-keyed
 * `user_membership_session/oneoff/periodical` tables are gone. A version's editable plan — what a
 * Draft's section writers, the clone and the version-keyed loader mean by "the version's
 * benefits" — is its **primary** plan snapshot: the lowest id, the one the version's own legacy
 * plan row derives (plans added beside it are inherited or native copies with later ids).
 */
export const PLAN_LINE_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'plan_session_snapshots',
  oneoff: 'plan_oneoff_snapshots',
  periodical: 'plan_periodical_snapshots',
};

export const PLAN_LINE_CATEGORIES: ProductBenefitCategory[] = ['session', 'oneoff', 'periodical'];

type Exec = { query: Tx['query'] };

/** The version's primary plan snapshot, or `null` for a plan-less version. */
export async function primaryPlanSnapshotId(exec: Exec, gymId: string, productSetId: number): Promise<number | null> {
  const { rows } = await exec.query<{ id: number }>(
    'SELECT id FROM plan_snapshots WHERE gym_id = ? AND product_set_id = ? ORDER BY id LIMIT 1', [gymId, productSetId]);
  return rows[0] ? Number(rows[0].id) : null;
}
