/**
 * #2125 N2 — a hand-written fixture assignment's id is a plan snapshot id, as a real one's is.
 *
 * Since migration 462 a plan snapshot names its assignment only through `assignment_id`, a FK to the
 * anchor snapshot whose id is the assignment's. A fixture that writes an assignment by hand
 * (`INSERT INTO user_memberships …`, `assignmentFixture.ts`) gets an id before any snapshot exists, so:
 *
 *   - the id is **reserved** from `plan_snapshots`' own AUTO_INCREMENT (a placeholder row inserted and
 *     deleted, like `reserveBaseExerciseId()`), so no real snapshot ever takes it;
 *   - the first snapshot a fixture writes for it is **re-keyed** onto that id (`anchorHandAssignment()`)
 *     with every row that references it, so it becomes the assignment's anchor; a later one is named
 *     after it (`assignment_id = id`).
 */
import { db } from '../infra/db';

type Exec = { query: (sql: string, params?: any[]) => Promise<any> };

/** Reserves a plan snapshot id for a hand-written assignment of `gymId` (owned by `memberId`). */
export async function reserveHandAssignmentId(exec: Exec, gymId: string, memberId: number | null): Promise<number> {
  let member = memberId;
  if (member == null) {
    const { rows } = await exec.query('SELECT id FROM members WHERE gym_id = ? ORDER BY id LIMIT 1', [gymId]);
    member = rows[0] ? Number(rows[0].id) : null;
  }
  if (member == null) throw new Error('reserveHandAssignmentId: a hand-written assignment needs a member of its gym');
  const { insertId } = await exec.query(
    'INSERT INTO plan_snapshots (gym_id, member_id, starts_at) VALUES (?, ?, UTC_DATE())', [gymId, member]);
  await exec.query('DELETE FROM plan_snapshots WHERE id = ?', [insertId]);
  return Number(insertId);
}

let references: Array<{ table: string; column: string }> | null = null;

async function referencesToPlanSnapshots(): Promise<Array<{ table: string; column: string }>> {
  if (references) return references;
  const { rows } = await db.query<{ table: string; column: string }>(
    `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\` FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'plan_snapshots' AND REFERENCED_COLUMN_NAME = 'id'`);
  references = rows.map((r) => ({ table: String(r.table), column: String(r.column) }));
  return references;
}

/**
 * Makes plan snapshot `snapshotId` belong to the hand-written assignment `assignmentId`: when no
 * snapshot has that id yet, the snapshot is re-keyed onto it (with every reference to it) and anchors
 * itself; otherwise it is named after the existing anchor. Answers the snapshot's id afterwards.
 */
export async function anchorHandAssignment(snapshotId: number, assignmentId: number): Promise<number> {
  const id = Number(assignmentId);
  const from = Number(snapshotId);
  if (from === id) {
    await db.query('UPDATE plan_snapshots SET assignment_id = id WHERE id = ?', [id]);
    return id;
  }
  const { rows: existing } = await db.query('SELECT id FROM plan_snapshots WHERE id = ?', [id]);
  if (existing[0]) {
    await db.query('UPDATE plan_snapshots SET assignment_id = ? WHERE id = ?', [id, from]);
    return from;
  }
  const refs = await referencesToPlanSnapshots();
  await db.transaction(async (tx) => {
    await tx.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      await tx.query('UPDATE plan_snapshots SET id = ? WHERE id = ?', [id, from]);
      for (const r of refs) {
        await tx.query(`UPDATE \`${r.table}\` SET \`${r.column}\` = ? WHERE \`${r.column}\` = ?`, [id, from]);
      }
      await tx.query('UPDATE plan_snapshots SET assignment_id = id WHERE id = ?', [id]);
    } finally {
      await tx.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
  return id;
}
