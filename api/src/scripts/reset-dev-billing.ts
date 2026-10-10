/**
 * Development billing reset (#1325).
 *
 *   npm run billing:reset-dev                 # dry run: counts, deletes nothing
 *   RESET_CONFIRM=DELETE-DEV-BILLING-DATA npm run billing:reset-dev -- --execute  # deletes
 *
 * Deletes the assigned Membership Plans, the Billing Events and the payments
 * and one-off purchases that hang from them, plus the audit rows of those
 * entities. What it does and does not touch is `domain/devBillingReset.ts`.
 * Everything runs in ONE transaction: a failure leaves the database exactly as
 * it was. Prints per-table counts before and after.
 *
 * The deployed database is VCN-private, so the real run is the
 * `billing-reset-dev.yml` workflow (environment `dev` only), which executes the
 * compiled script from the VPS.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import {
  RESET_AUDIT_ENTITY_TYPES,
  RESET_STEPS,
  evaluateResetGuard,
} from '../domain/devBillingReset';

async function existingTables(): Promise<Set<string>> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  return new Set(rows.map((r) => String(r.name).toLowerCase()));
}

async function countRows(table: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(rows[0]?.c ?? 0);
}

async function countAudit(): Promise<number> {
  const marks = RESET_AUDIT_ENTITY_TYPES.map(() => '?').join(',');
  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type IN (${marks})`,
    [...RESET_AUDIT_ENTITY_TYPES],
  );
  return Number(rows[0]?.c ?? 0);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const guard = evaluateResetGuard({
    connectedHost: process.env.CORDEL_FITNESS_DB_HOST,
    confirmation: process.env.RESET_CONFIRM,
    dryRun,
  });
  if (!guard.allowed) {
    console.error(`REFUSED: ${guard.reason}`);
    process.exit(2);
  }

  const present = await existingTables();
  const steps = RESET_STEPS.filter((s) => present.has(s.table) || !s.optional);
  for (const s of steps) {
    if (!present.has(s.table)) {
      console.error(`ERROR: required table ${s.table} does not exist; nothing was deleted.`);
      process.exit(1);
    }
  }

  const before = new Map<string, number>();
  for (const s of steps) before.set(s.table, await countRows(s.table));
  const auditBefore = await countAudit();

  console.log(dryRun ? 'DRY RUN — nothing will be deleted.' : 'EXECUTING — deleting in one transaction.');
  console.log('\nTable'.padEnd(52) + 'rows'.padStart(8) + '  reason');
  for (const s of steps) {
    console.log(`  ${s.table}`.padEnd(50) + String(before.get(s.table)).padStart(8) + `  ${s.reason}`);
  }
  console.log(`  audit_logs (${RESET_AUDIT_ENTITY_TYPES.join(', ')})`.padEnd(50) + String(auditBefore).padStart(8));

  if (dryRun) {
    console.log('\nRe-run with --execute (and RESET_CONFIRM) to delete.');
    await db.end();
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const out = new Map<string, number>();
    for (const s of steps) {
      const { rowCount } = await tx.query(`DELETE FROM \`${s.table}\``);
      out.set(s.table, rowCount);
    }
    const marks = RESET_AUDIT_ENTITY_TYPES.map(() => '?').join(',');
    const audit = await tx.query(`DELETE FROM audit_logs WHERE entity_type IN (${marks})`, [...RESET_AUDIT_ENTITY_TYPES]);
    out.set('audit_logs', audit.rowCount);
    return out;
  });

  console.log('\nDeleted:');
  for (const [table, n] of deleted) console.log(`  ${table.padEnd(48)}${String(n).padStart(8)}`);

  // Post-condition: nothing the reset owns survives, and nothing it does not own
  // was touched (the preserved tables are not even read here).
  const leftovers: string[] = [];
  for (const s of steps) {
    const n = await countRows(s.table);
    if (n !== 0) leftovers.push(`${s.table}=${n}`);
  }
  if ((await countAudit()) !== 0) leftovers.push('audit_logs (reset types)');
  if (leftovers.length > 0) {
    console.error(`POST-CHECK FAILED — rows remain: ${leftovers.join(', ')}`);
    process.exit(1);
  }
  console.log('\nPost-check passed: every reset table is empty.');
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
